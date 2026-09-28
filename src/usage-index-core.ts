import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decodeProjectDir, extractSessionId } from "./paths.ts";
import type { UsageRecord } from "./types.ts";
import { todayStart } from "./dates.ts";

export const INDEX_NAME = "token-usage-index-v1.sqlite";
const VERSION = 3;
type Row = Record<string, any>;
type FileVersion = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
type Charge = UsageRecord & { key: string; position: number };
type Context = { id: string; parentId: string | null; provider: string | null; model: string | null };
export type UsageSnapshot = { records: UsageRecord[]; status: "loading" | "complete" | "incomplete"; warning?: string };
export type TodaySnapshot = UsageSnapshot & { keys: string[] };
export type IndexHooks = { beforeImport?: (path: string) => Promise<void>; beforeDelete?: (path: string) => Promise<void>; onBodyRead?: (path: string, bytes: number) => void };
/** The adapter passes actual persisted Pi session entries (including their ids), not bare turn messages. */
export type EventCharge = { filePath: string; project: string; entry: Record<string, any>; identity: string };

function version(s: ReturnType<typeof statSync>): FileVersion {
	return { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs };
}
function same(a: FileVersion, b: FileVersion): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
/** A changed file may be appended only when every previously indexed byte still matches. */
function prefixHasher(path: string, size: number, onRead?: (bytes: number) => void): ReturnType<typeof createHash> {
	const fd = openSync(path, "r");
	const digest = createHash("sha256");
	try {
		for (let position = 0; position < size;) {
			const chunk = Buffer.allocUnsafe(Math.min(256 * 1024, size - position));
			const n = readSync(fd, chunk, 0, chunk.length, position);
			if (!n) throw Error(`Short prefix read: ${path}`);
			digest.update(chunk.subarray(0, n));
			onRead?.(n);
			position += n;
		}
		return digest;
	} finally { closeSync(fd); }
}
export function chargeIdentity(entry: Row): string {
	// Pi copies entries into child histories. Reparenting is not a new charge;
	// a different payload with the same short id is. Never persist the payload.
	const { parentId: _parent, ...payload } = entry;
	return hash([entry.type, entry.id ?? null, entry.timestamp ?? null, payload]);
}
export function eventUsageRecord(entry: Row, project: string, sessionId: string): UsageRecord | null {
 const usage = entry.type === "message" ? entry.message?.usage : entry.usage;
 if (!usage || (entry.type === "message" && !["assistant", "toolResult"].includes(entry.message?.role))) return null;
 return usageRecord(entry, usage, entry.message?.provider ?? entry.provider ?? "unattributed", entry.message?.model ?? entry.model ?? "unattributed", project, sessionId);
}
function usageRecord(entry: Row, usage: Row, provider: string, model: string, project: string, sessionId: string): UsageRecord | null {
	if (!Number.isFinite(usage.input) || !Number.isFinite(usage.output)) return null;
	const ts = typeof entry.message?.timestamp === "number" ? entry.message.timestamp : Date.parse(entry.timestamp);
	if (!Number.isFinite(ts)) return null;
	const cacheRead = Number.isFinite(usage.cacheRead) ? usage.cacheRead : 0;
	const cacheWrite = Number.isFinite(usage.cacheWrite) ? usage.cacheWrite : 0;
	return { timestamp: ts, isoTimestamp: typeof entry.timestamp === "string" ? entry.timestamp : new Date(ts).toISOString(),
		provider, model, project, sessionId, input: usage.input, output: usage.output, cacheRead, cacheWrite,
		totalTokens: Number.isFinite(usage.totalTokens) ? usage.totalTokens : usage.input + usage.output + cacheRead + cacheWrite,
		costTotal: Number.isFinite(usage.cost?.total) ? usage.cost.total : 0 };
}

/** Worker-owned synchronous SQLite/FS engine. No transcript text is persisted. */
export class UsageIndexCore {
	private db: DatabaseSync;
	private checked = false;
	private warning?: string;
	readonly sessions: string;
	readonly databasePath: string;
	readonly agentRoot: string;
	private hooks: IndexHooks;
	constructor(agentRoot: string, hooks: IndexHooks = {}) {
		this.agentRoot = agentRoot;
		this.hooks = hooks;
		this.sessions = join(agentRoot, "sessions");
		this.databasePath = join(agentRoot, INDEX_NAME);
		mkdirSync(agentRoot, { recursive: true });
		this.db = this.openWithRecovery();
	}
	private openWithRecovery(): DatabaseSync {
		const open = () => {
			const db = new DatabaseSync(this.databasePath);
			try {
				db.exec("PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
				const integrity = db.prepare("PRAGMA quick_check").get() as Row;
				if (Object.values(integrity)[0] !== "ok") throw Error("index integrity check failed");
				const v = db.prepare("PRAGMA user_version").get() as Row;
				if (Number(Object.values(v)[0]) !== 0 && Number(Object.values(v)[0]) !== VERSION) throw Error("index version mismatch");
				db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, dev INTEGER, ino INTEGER, size INTEGER, mtime REAL, ctime REAL, offset INTEGER NOT NULL, project TEXT NOT NULL, session TEXT NOT NULL, generation INTEGER NOT NULL, prefix TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS contexts (path TEXT NOT NULL, id TEXT NOT NULL, parent TEXT, provider TEXT, model TEXT, PRIMARY KEY(path,id), FOREIGN KEY(path) REFERENCES files(path) ON DELETE CASCADE);
				CREATE TABLE IF NOT EXISTS charges (path TEXT NOT NULL, position INTEGER NOT NULL, key TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(path,position), FOREIGN KEY(path) REFERENCES files(path) ON DELETE CASCADE);
				CREATE INDEX IF NOT EXISTS charges_key ON charges(key);
				CREATE TABLE IF NOT EXISTS pending (path TEXT NOT NULL, key TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(path,key));
				PRAGMA user_version=3;`);
				return db;
			} catch (e) { db.close(); throw e; }
		};
		try { return open(); }
		catch (e) {
			// A busy/unwritable index is not corruption. Never replace another live writer's DB.
			if (!/malformed|not a database|integrity check failed|index version mismatch|file is not a database/i.test(String(e))) throw e;
			this.warning = `Derived index rebuilt: ${String(e)}`;
			// The index is disposable. Preserve a corrupt copy for diagnosis; never touch session JSONL.
			for (const suffix of ["", "-wal", "-shm"]) {
				const path = this.databasePath + suffix;
				if (existsSync(path)) renameSync(path, `${path}.broken-${process.pid}-${Date.now()}`);
			}
			const rebuilt = open();
			// Until a real sessions-tree walk succeeds, a rebuilt empty index is not
			// evidence that previously indexed history has disappeared. Persist this
			// across process restarts as well as the current recovery attempt.
			rebuilt.prepare("INSERT INTO meta(key,value) VALUES('rebuilding','1')").run();
			return rebuilt;
		}
	}
	private generation(): number { return Number((this.db.prepare("SELECT value FROM meta WHERE key='generation'").get() as Row | undefined)?.value ?? 0); }
	private nextGeneration(): number {
		const n = this.generation() + 1;
		this.db.prepare("INSERT INTO meta(key,value) VALUES('generation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(n));
		return n;
	}
	private transaction<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try { const result = fn(); this.db.exec("COMMIT"); return result; }
		catch (e) { this.db.exec("ROLLBACK"); throw e; }
	}
	private file(path: string): Row | undefined { return this.db.prepare("SELECT * FROM files WHERE path=?").get(path) as Row | undefined; }
	private walk(dir: string, found: string[]): void {
		for (const item of readdirSync(dir).sort()) {
			const path = join(dir, item);
			const s = lstatSync(path); // A disappearing/unreadable member invalidates this walk.
			if (s.isDirectory()) this.walk(path, found);
			else if (s.isFile() && item.endsWith(".jsonl")) found.push(path);
		}
	}
	private *lines(path: string, offset: number, size: number, onChunk?: (bytes: Buffer, position: number) => void): Generator<{ text: string; position: number; end: number }> {
		const fd = openSync(path, "r");
		const decoder = new TextDecoder("utf-8", { fatal: true });
		let pending = Buffer.alloc(0);
		let position = offset;
		try {
			for (let pos = offset; pos < size;) {
				const chunk = Buffer.allocUnsafe(Math.min(256 * 1024, size - pos));
				const n = readSync(fd, chunk, 0, chunk.length, pos);
				if (!n) throw Error(`Short read: ${path}`);
				this.hooks.onBodyRead?.(path, n);
				onChunk?.(chunk.subarray(0, n), pos);
				pos += n;
				const bytes = pending.length ? Buffer.concat([pending, chunk.subarray(0, n)]) : chunk.subarray(0, n);
				let start = 0;
				for (let newline = bytes.indexOf(10, start); newline >= 0; newline = bytes.indexOf(10, start)) {
					const end = position + newline - start + 1;
					yield { text: decoder.decode(bytes.subarray(start, newline)), position, end };
					position = end; start = newline + 1;
				}
				pending = bytes.subarray(start);
			}
		} finally { closeSync(fd); }
	}
	/** Best-effort fast event write. The next successful file import supersedes it; JSONL remains authoritative. */
	ingest(charges: EventCharge[], todayOnly = false): UsageSnapshot {
		this.transaction(() => {
			for (const { filePath, project, entry, identity } of charges) {
				if (typeof identity !== "string" || !/^[a-f0-9]{64}$/.test(identity) || relative(this.sessions, filePath).startsWith("..") || !filePath.endsWith(".jsonl")) continue;
				const usage = entry.type === "message" ? entry.message?.usage : entry.usage;
				if (!usage || (entry.type === "message" && !["assistant", "toolResult"].includes(entry.message?.role))) continue;
				const record = usageRecord(entry, usage, entry.message?.provider ?? entry.provider ?? "unattributed", entry.message?.model ?? entry.model ?? "unattributed", project, extractSessionId(filePath));
				if (record) this.db.prepare("INSERT OR REPLACE INTO pending(path,key,record) VALUES(?,?,?)").run(filePath, identity, JSON.stringify(record));
			}
		});
		return todayOnly ? this.today() : this.snapshot();
	}
	private async importFile(path: string): Promise<boolean> {
		const stat = version(statSync(path));
		const old = this.file(path);
		if (old && same(stat, { dev: old.dev, ino: old.ino, size: old.size, mtimeMs: old.mtime, ctimeMs: old.ctime })) return old.offset === old.size;
		const appendCandidate = !!old && old.dev === stat.dev && old.ino === stat.ino && stat.size > old.size && stat.size >= old.offset;
		let digest = appendCandidate ? prefixHasher(path, old.size, (n) => this.hooks.onBodyRead?.(path, n)) : createHash("sha256");
		const append = appendCandidate && digest.copy().digest("hex") === old.prefix;
		if (!append) digest = createHash("sha256");
		const start = append ? old.offset : 0;
		let end = start;
		const parts = relative(this.sessions, path).split(sep);
		let project = append ? old.project : parts.length > 1 ? decodeProjectDir(parts[0]!) : "unknown";
		const session = extractSessionId(path);
		const contexts = new Map<string, Context>();
		const charges: Charge[] = [];
		for (const { text: raw, position, end: lineEnd } of this.lines(path, start, stat.size, (bytes, position) => {
			// A partial prior line is parsed again, but its bytes are already in
			// the verified prefix. Hash only the newly appended suffix.
			const skip = append ? Math.max(0, old!.size - position) : 0;
			if (skip < bytes.length) digest.update(bytes.subarray(skip));
		})) {
			end = lineEnd;
			if (!raw.trim()) continue;
			let entry: Row;
			try { entry = JSON.parse(raw); } catch { throw Error(`Malformed JSONL: ${path}:${position}`); }
			if (!entry || typeof entry !== "object") throw Error(`Invalid JSONL: ${path}:${position}`);
			if (entry.type === "session" && typeof entry.cwd === "string" && entry.cwd) project = entry.cwd;
			if (typeof entry.id === "string" && entry.id) {
				const parentId = typeof entry.parentId === "string" ? entry.parentId : null;
				const parent = parentId ? contexts.get(parentId) ?? this.db.prepare("SELECT id,parent AS parentId,provider,model FROM contexts WHERE path=? AND id=?").get(path, parentId) as Context | undefined : undefined;
				let provider = parent?.provider ?? null;
				let model = parent?.model ?? null;
				if (entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") { provider = entry.provider; model = entry.modelId; }
				if (entry.type === "message" && entry.message?.role === "assistant" && typeof entry.message.provider === "string" && typeof entry.message.model === "string") { provider = entry.message.provider; model = entry.message.model; }
				contexts.set(entry.id, { id: entry.id, parentId, provider, model });
			}
			const usage = entry.type === "message" ? entry.message?.usage : entry.usage;
			if (usage && typeof usage === "object" && (entry.type !== "message" || ["assistant", "toolResult"].includes(entry.message?.role))) {
				const ctx = contexts.get(entry.id);
				const provider = entry.type === "message" ? entry.message?.provider : entry.provider;
				const model = entry.type === "message" ? entry.message?.model : entry.model;
				const record = usageRecord(entry, usage, provider ?? ctx?.provider ?? "unattributed", model ?? ctx?.model ?? "unattributed", project, session);
				if (record) {
					// Hash the charge's source entry, not just Pi's short id. Exclude ancestry (which a copy may reparent).
					charges.push({ ...record, key: chargeIdentity(entry), position });
				}
			}
		}
		const prefix = digest.digest("hex");
		if (!same(stat, version(statSync(path)))) throw Error(`Changed while reading: ${path}`);
		await this.hooks.beforeImport?.(path);
		let committed = false;
		this.transaction(() => {
			const current = this.file(path);
			// A prior import may have completed after this read. Never overwrite its newer checkpoint.
			if ((current?.generation ?? 0) !== (old?.generation ?? 0)) return;
			if (!same(stat, version(statSync(path)))) return;
			const gen = this.nextGeneration();
			if (!append) this.db.prepare("DELETE FROM files WHERE path=?").run(path);
			this.db.prepare(`INSERT INTO files(path,dev,ino,size,mtime,ctime,offset,project,session,generation,prefix) VALUES(?,?,?,?,?,?,?,?,?,?,?)
				ON CONFLICT(path) DO UPDATE SET dev=excluded.dev,ino=excluded.ino,size=excluded.size,mtime=excluded.mtime,ctime=excluded.ctime,offset=excluded.offset,project=excluded.project,session=excluded.session,generation=excluded.generation,prefix=excluded.prefix`).run(path, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, end, project, session, gen, prefix);
			for (const c of contexts.values()) this.db.prepare("INSERT INTO contexts(path,id,parent,provider,model) VALUES(?,?,?,?,?) ON CONFLICT(path,id) DO UPDATE SET parent=excluded.parent,provider=excluded.provider,model=excluded.model").run(path, c.id, c.parentId, c.provider, c.model);
			for (const { key, position, ...record } of charges) this.db.prepare("INSERT OR REPLACE INTO charges(path,position,key,record) VALUES(?,?,?,?)").run(path, position, key, JSON.stringify(record));
			// Only a fully consumed file can disprove a provisional event charge.
			if (end === stat.size) this.db.prepare("DELETE FROM pending WHERE path=?").run(path);
			committed = true;
		});
		if (!committed) {
			const current = this.file(path);
			return !!current && same(version(statSync(path)), { dev: current.dev, ino: current.ino, size: current.size, mtimeMs: current.mtime, ctimeMs: current.ctime }) && current.offset === current.size;
		}
		return end === stat.size;
	}
	/** Complete metadata walk; errors retain all prior charges and mark the snapshot incomplete. */
	async reconcile(todayOnly = false): Promise<UsageSnapshot> {
		this.checked = true;
		try {
			const startGeneration = this.generation();
			const found: string[] = [];
			try { this.walk(this.sessions, found); }
			catch (e) {
				if (!(e instanceof Error && "code" in e && e.code === "ENOENT" && !existsSync(this.sessions))) throw e;
				// A first-run absent tree is empty; an indexed tree disappearing is not a reliable deletion listing.
				if (this.db.prepare("SELECT 1 FROM files LIMIT 1").get() || this.db.prepare("SELECT 1 FROM pending LIMIT 1").get() || this.db.prepare("SELECT 1 FROM meta WHERE key='rebuilding'").get()) throw Error(`Sessions root unavailable: ${this.sessions}`);
			}
			for (const path of found) if (!await this.importFile(path)) throw Error(`Incomplete source: ${path}`);
			const present = new Set(found);
			for (const { path } of this.db.prepare("SELECT path FROM files").all() as Row[]) {
				if (present.has(path)) continue;
				await this.hooks.beforeDelete?.(path);
				this.transaction(() => {
					const row = this.file(path);
					if (!row || row.generation > startGeneration) return;
					try { statSync(path); return; }
					catch (e) { if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e; }
					this.db.prepare("DELETE FROM files WHERE path=?").run(path);
					this.db.prepare("DELETE FROM pending WHERE path=?").run(path);
					this.nextGeneration();
				});
			}
			for (const { path } of this.db.prepare("SELECT DISTINCT path FROM pending").all() as Row[]) {
				if (!present.has(path)) {
					try { statSync(path); } catch (e) {
						if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
						this.db.prepare("DELETE FROM pending WHERE path=?").run(path);
					}
				}
			}
			const published = this.transaction(() => {
				const failedAt = Number((this.db.prepare("SELECT value FROM meta WHERE key='health_failure_generation'").get() as Row | undefined)?.value ?? 0);
				// A complete but older walk cannot erase a newer process's failed scan.
				if (failedAt > startGeneration) return false;
				this.db.prepare("INSERT INTO meta(key,value) VALUES('health','complete') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
				this.db.prepare("DELETE FROM meta WHERE key='health_failure_generation'").run();
				if (existsSync(this.sessions)) this.db.prepare("DELETE FROM meta WHERE key='rebuilding'").run();
				return true;
			});
			this.warning = published ? undefined : "Concurrent incomplete source snapshot; retry catch-up";
		} catch (e) {
			this.warning = String(e);
			try {
				this.transaction(() => {
					const generation = this.nextGeneration();
					this.db.prepare("INSERT INTO meta(key,value) VALUES('health_failure_generation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(generation));
					this.db.prepare("INSERT INTO meta(key,value) VALUES('health','incomplete') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
				});
			} catch { /* query will report the failure */ }
		}
		return todayOnly ? this.today() : this.snapshot();
	}
	snapshot(): UsageSnapshot { return this.project(); }
	/** Today-only projection prevents periodic footer reads transferring all historical rows. */
	today(): TodaySnapshot { return this.project(todayStart(), true) as TodaySnapshot; }
	private project(since?: number, includeKeys = false): UsageSnapshot | TodaySnapshot {
		try {
			// Root files win over nested copies; filter in SQLite before transferring today's rows.
			const sources = this.db.prepare(`SELECT path,key,record FROM (SELECT path,key,record,position FROM charges UNION ALL SELECT path,key,record,-1 AS position FROM pending) ${since === undefined ? "" : "WHERE json_extract(record,'$.timestamp') >= ?"} ORDER BY length(path)-length(replace(path,'/','')),path,position`).all(...(since === undefined ? [] : [since])) as Row[];
			const seen = new Set<string>();
			const records: UsageRecord[] = [];
			for (const source of sources) if (!seen.has(source.key)) { seen.add(source.key); records.push(JSON.parse(source.record)); }
			records.sort((a, b) => a.timestamp - b.timestamp);
			const health = (this.db.prepare("SELECT value FROM meta WHERE key='health'").get() as Row | undefined)?.value;
			const status = !this.checked ? "loading" : health === "complete" && !this.warning ? "complete" : "incomplete";
			return { records, status, ...(status === "incomplete" ? { warning: this.warning ?? "Usage index catch-up incomplete" } : {}), ...(includeKeys ? { keys: [...seen] } : {}) };
		} catch (e) { return { records: [], status: "incomplete", warning: `Usage index unavailable: ${String(e)}`, ...(includeKeys ? { keys: [] } : {}) }; }
	}
	close(): void { this.db.close(); }
}
