import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chargeIdentity, INDEX_NAME, UsageIndexCore } from "../src/usage-index-core.ts";
import { createUsageIndex } from "../src/usage-index.ts";
import { toDateStr, toMonthStr } from "../src/dates.ts";

const time = "2026-04-02T10:00:00.000Z";
function entry(id: string, input: number, more: Record<string, unknown> = {}) {
	return { type: "message", id, parentId: null, timestamp: time, message: { role: "assistant", provider: "anthropic", model: "sonnet", timestamp: Date.parse(time), usage: { input, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: input / 100 } } }, ...more };
}
function session(root: string, path: string, cwd: string, entries: object[] = []) {
	const filename = join(root, "sessions", path);
	mkdirSync(join(filename, ".."), { recursive: true });
	writeFileSync(filename, [{ type: "session", cwd, id: path }, ...entries].map(x => JSON.stringify(x)).join("\n") + "\n");
	return filename;
}
function add(path: string, e: object) { appendFileSync(path, JSON.stringify(e) + "\n"); }
function deferred() { let release!: () => void; const gate = new Promise<void>(r => { release = r; }); return { gate, release }; }

describe("shared derived usage index", () => {
	let root: string;
	let cores: UsageIndexCore[];
	beforeEach(() => { root = mkdtempSync(join(tmpdir(), "pi-usage-index-")); cores = []; });
	afterEach(() => { for (const c of cores) c.close(); rmSync(root, { recursive: true, force: true }); });
	const open = (root: string, hooks: ConstructorParameters<typeof UsageIndexCore>[1] = {}) => {
		const core = new UsageIndexCore(root, hooks); cores.push(core); return core;
	};

	it("extracts all recorded usage kinds, branch model ancestry, child cwd, and unattributed compaction", async () => {
		const parentEntry = entry("parent", 10);
		(parentEntry.message as Record<string, unknown>).content = "SECRET_TRANSCRIPT_CONTENT";
		const file = session(root, "parent/parent.jsonl", "/parent", [parentEntry]);
		const child = session(root, "parent/child/child.jsonl", "/other/child", [
			{ type: "model_change", id: "m", parentId: null, timestamp: time, provider: "openai", modelId: "gpt" },
			{ type: "message", id: "t", parentId: "m", timestamp: time, message: { role: "toolResult", usage: { input: 5, output: 1, cost: { total: 0.05 } } } },
			{ type: "compaction", id: "c", parentId: "t", timestamp: time, usage: { input: 6, output: 2, cost: { total: 0.06 } } },
			{ type: "branch_summary", id: "b", parentId: "c", timestamp: time, usage: { input: 7, output: 2 } },
			{ type: "usage", id: "u", parentId: "b", timestamp: time, usage: { input: 8, output: 2 } },
			{ type: "compaction", id: "unknown", parentId: null, timestamp: time, usage: { input: 9, output: 2 } },
		]);
		const idx = open(root);
		const result = await idx.reconcile();
		expect(result.status).toBe("complete");
		expect(result.records.map(r => r.input).sort((a,b) => a-b)).toEqual([5,6,7,8,9,10]);
		expect(result.records.find(r => r.input === 6)).toMatchObject({ provider: "openai", model: "gpt", project: "/other/child", sessionId: "child" });
		expect(result.records.find(r => r.input === 9)).toMatchObject({ provider: "unattributed", model: "unattributed" });
		expect(readFileSync(join(root, INDEX_NAME)).includes(Buffer.from("SECRET_TRANSCRIPT_CONTENT"))).toBe(false);
		expect(file).toBeTruthy(); expect(child).toBeTruthy();
	});

	it("deduplicates copied charge payload, preserves independent short-ID collisions, and reassigns on source deletion", async () => {
		const shared = entry("same", 10);
		const a = session(root, "a.jsonl", "/alpha", [shared]);
		const distinct = entry("same", 10);
		(distinct.message as Record<string, unknown>).content = "independent work despite equal usage and id";
		const b = session(root, "nested/b.jsonl", "/beta", [shared, entry("same", 30), distinct]);
		const idx = open(root);
		let result = await idx.reconcile();
		expect(result.records.map(r => r.input).sort((x,y) => x-y)).toEqual([10,10,30]);
		expect(result.records.find(r => r.input === 10)?.sessionId).toBe("a");
		unlinkSync(a); result = await idx.reconcile();
		expect(result.records.map(r => r.input).sort((x,y) => x-y)).toEqual([10,10,30]);
		expect(result.records.find(r => r.input === 10)?.sessionId).toBe("b");
		unlinkSync(b); result = await idx.reconcile();
		expect(result).toMatchObject({ status: "complete", records: [] });
	});

	it("verifies a changed file's full prior prefix; unchanged and deletion-only sweeps read no old bodies", async () => {
		const a = session(root, "p/a.jsonl", "/a", [entry("a", 1)]);
		const b = session(root, "p/b.jsonl", "/b", [entry("b", 2)]);
		const trace: Array<[string, number]> = [];
		const idx = open(root, { onBodyRead: (p,n) => trace.push([p,n]) });
		await idx.reconcile(); expect(trace.length).toBeGreaterThan(0);
		trace.length = 0;
		const second = open(root, { onBodyRead: (p,n) => trace.push([p,n]) });
		expect((await second.reconcile()).status).toBe("complete");
		await idx.reconcile(); expect(trace).toEqual([]);
		const before = readFileSync(a).length;
		add(a, entry("new", 3));
		const appended = readFileSync(a).length - before;
		expect((await second.reconcile()).records).toHaveLength(3);
		expect(trace).toEqual([[a, before], [a, appended]]);
		trace.length = 0; unlinkSync(b);
		expect((await idx.reconcile()).records).toHaveLength(2);
		expect(trace).toEqual([]);
	});

	it("does not publish partial lines; rewrites and truncations replace file provenance", async () => {
		const a = session(root, "a.jsonl", "/a", [entry("a", 1)]);
		const idx = open(root);
		appendFileSync(a, JSON.stringify(entry("later", 2)).slice(0, 70));
		const partial = await idx.reconcile();
		expect(partial.status).toBe("incomplete");
		expect(partial.records.map(r => r.input)).toEqual([1]);
		const remaining = JSON.stringify(entry("later", 2)).slice(70);
		appendFileSync(a, remaining + "\n");
		expect((await idx.reconcile()).records.map(r => r.input)).toEqual([1,2]);
		session(root, "a.jsonl", "/new", [entry("replacement", 4)]);
		expect(await idx.reconcile()).toMatchObject({ status: "complete", records: [{ input: 4, project: "/new" }] });
	});

	it("rebuilds a same-inode growing rewrite rather than reading from the old append offset", async () => {
		const a = session(root, "a.jsonl", "/old", [entry("old", 1)]);
		const idx = open(root);
		expect(await idx.reconcile()).toMatchObject({ status: "complete", records: [{ input: 1 }] });
		const inode = statSync(a).ino;
		const previousSize = statSync(a).size;
		const trace: number[] = [];
		const b = open(root, { onBodyRead: (p, n) => { if (p === a) trace.push(n); } });
		writeFileSync(a, [
			JSON.stringify({ type: "session", cwd: "/replacement-with-a-longer-session-header", id: "a.jsonl" }),
			JSON.stringify(entry("new", 4)), JSON.stringify(entry("newer", 5)), "",
		].join("\n"));
		expect(statSync(a).ino).toBe(inode);
		expect(statSync(a).size).toBeGreaterThan(previousSize);
		expect(await b.reconcile()).toMatchObject({ status: "complete", records: [{ input: 4, project: "/replacement-with-a-longer-session-header" }, { input: 5 }] });
		expect(trace.reduce((total, bytes) => total + bytes, 0)).toBe(previousSize + statSync(a).size);
		trace.length = 0;
		const beforeAppend = statSync(a).size;
		add(a, entry("appended", 6));
		expect((await b.reconcile()).records.map(r => r.input)).toEqual([4, 5, 6]);
		expect(trace.reduce((total, bytes) => total + bytes, 0)).toBe(statSync(a).size);
	});

	it("rebuilds a growing same-inode rewrite that changes only an unsampled middle charge", async () => {
		const a = session(root, "a.jsonl", "/a", [
			{ type: "custom", id: "pad-before", data: "x".repeat(5000) },
			entry("middle", 11),
			{ type: "custom", id: "pad-after", data: "y".repeat(5000) },
		]);
		const idx = open(root);
		expect(await idx.reconcile()).toMatchObject({ status: "complete", records: [{ input: 11 }] });
		const before = statSync(a);
		writeFileSync(a, readFileSync(a, "utf8").replace('"input":11', '"input":44') + JSON.stringify(entry("tail", 3)) + "\n");
		expect(statSync(a).ino).toBe(before.ino);
		expect(statSync(a).size).toBeGreaterThan(before.size);
		expect(await idx.reconcile()).toMatchObject({ status: "complete", records: [{ input: 44 }, { input: 3 }] });
	});

	it("retains indexed charges while the sessions root is absent, then recovers", async () => {
		const idx = open(root);
		expect(await idx.reconcile()).toMatchObject({ status: "complete", records: [] }); // fresh absent tree
		session(root, "a.jsonl", "/a", [entry("a", 1)]);
		expect(await idx.reconcile()).toMatchObject({ status: "complete", records: [{ input: 1 }] });
		const sessions = join(root, "sessions");
		renameSync(sessions, join(root, "temporarily-hidden"));
		expect(await idx.reconcile()).toMatchObject({ status: "incomplete", records: [{ input: 1 }] });
		renameSync(join(root, "temporarily-hidden"), sessions);
		expect(await idx.reconcile()).toMatchObject({ status: "complete", records: [{ input: 1 }] });
		unlinkSync(join(sessions, "a.jsonl"));
		expect(await idx.reconcile()).toMatchObject({ status: "complete", records: [] });
	});

	it("retains charges and warns on malformed line and failed traversal, then recovers", async () => {
		const a = session(root, "p/a.jsonl", "/a", [entry("a", 1)]);
		const idx = open(root);
		await idx.reconcile();
		appendFileSync(a, "{bad json}\n");
		expect(await idx.reconcile()).toMatchObject({ status: "incomplete", records: [{ input: 1 }] });
		session(root, "p/a.jsonl", "/a", [entry("a", 1), entry("b", 2)]);
		expect(await idx.reconcile()).toMatchObject({ status: "complete", records: [{ input: 1 }, { input: 2 }] });
		chmodSync(a, 0);
		try { expect(await idx.reconcile()).toMatchObject({ status: "incomplete", records: [{ input: 1 }, { input: 2 }] }); }
		finally { chmodSync(a, 0o600); }
		const sessions = join(root, "sessions");
		renameSync(sessions, join(root, "hidden"));
		writeFileSync(sessions, "not a directory");
		expect(await idx.reconcile()).toMatchObject({ status: "incomplete", records: [{ input: 1 }, { input: 2 }] });
		unlinkSync(sessions); renameSync(join(root, "hidden"), sessions);
		expect((await idx.reconcile()).status).toBe("complete");
	});

	it("uses local day/month boundaries from original event time", async () => {
		const oldTZ = process.env.TZ; process.env.TZ = "America/Los_Angeles";
		try {
			const a = entry("a", 1, { timestamp: "2026-04-01T06:59:00.000Z" });
			const b = entry("b", 2, { timestamp: "2026-04-01T07:01:00.000Z" });
			delete (a.message as { timestamp?: number }).timestamp;
			delete (b.message as { timestamp?: number }).timestamp;
			session(root, "a.jsonl", "/a", [a,b]);
			const rows = (await open(root).reconcile()).records;
			expect(rows.map(r => toDateStr(r.timestamp))).toEqual(["2026-03-31", "2026-04-01"]);
			expect(rows.map(r => toMonthStr(r.timestamp))).toEqual(["2026-03", "2026-04"]);
		} finally { if (oldTZ === undefined) delete process.env.TZ; else process.env.TZ = oldTZ; }
	});

	it("older complete walk cannot delete a newer imported child", async () => {
		const a = session(root, "child.jsonl", "/child", [entry("a", 1)]);
		const gate = deferred(); const entered = deferred();
		const older = open(root, { beforeDelete: async () => { entered.release(); await gate.gate; } });
		const newer = open(root);
		await older.reconcile(); unlinkSync(a);
		const walk = older.reconcile(); await entered.gate;
		session(root, "child.jsonl", "/child", [entry("new", 9)]);
		expect((await newer.reconcile()).records.map(r => r.input)).toEqual([9]);
		gate.release(); expect((await walk).records.map(r => r.input)).toEqual([9]);
	});

	it("stale same-file parsed import cannot overwrite a later append commit", async () => {
		const a = session(root, "a.jsonl", "/a", [entry("one", 1)]);
		const gate = deferred(); const entered = deferred();
		const older = open(root, { beforeImport: async () => { entered.release(); await gate.gate; } });
		const newer = open(root);
		const oldWalk = older.reconcile(); await entered.gate;
		add(a, entry("two", 2));
		expect((await newer.reconcile()).records.map(r => r.input)).toEqual([1,2]);
		gate.release();
		expect((await oldWalk).records.map(r => r.input)).toEqual([1,2]);
		expect((await older.reconcile()).records.map(r => r.input)).toEqual([1,2]);
		const db = new DatabaseSync(join(root, INDEX_NAME));
		try { expect(db.prepare("SELECT size,offset FROM files WHERE path=?").get(a)).toEqual({ size: statSync(a).size, offset: statSync(a).size }); }
		finally { db.close(); }
	});

	it("rebuilds the unshipped v1 index schema from authoritative JSONL", async () => {
		session(root, "a.jsonl", "/a", [entry("one", 1)]);
		const first = open(root);
		expect((await first.reconcile()).records).toHaveLength(1);
		first.close(); cores.pop();
		const legacy = new DatabaseSync(join(root, INDEX_NAME));
		try { legacy.exec("ALTER TABLE files DROP COLUMN prefix; PRAGMA user_version=1;"); }
		finally { legacy.close(); }
		expect(await open(root).reconcile()).toMatchObject({ status: "complete", records: [{ input: 1 }] });
	});

	it("does not claim an empty complete tree when schema recovery coincides with a missing sessions root", async () => {
		session(root, "a.jsonl", "/a", [entry("one", 1)]);
		const first = open(root);
		expect((await first.reconcile()).records).toHaveLength(1);
		first.close(); cores.pop();
		const legacy = new DatabaseSync(join(root, INDEX_NAME));
		try { legacy.exec("ALTER TABLE files DROP COLUMN prefix; PRAGMA user_version=1;"); }
		finally { legacy.close(); }
		renameSync(join(root, "sessions"), join(root, "sessions-held"));
		const rebuilt = open(root);
		expect(await rebuilt.reconcile()).toMatchObject({ status: "incomplete", records: [] });
		rebuilt.close(); cores.pop();
		const restarted = open(root);
		expect(await restarted.reconcile()).toMatchObject({ status: "incomplete", records: [] });
		renameSync(join(root, "sessions-held"), join(root, "sessions"));
		expect(await restarted.reconcile()).toMatchObject({ status: "complete", records: [{ input: 1 }] });
	});

	it("rebuilds a corrupt disposable index from retained JSONL", async () => {
		session(root, "a.jsonl", "/a", [entry("one", 1)]);
		const first = open(root);
		expect((await first.reconcile()).records).toHaveLength(1);
		first.close(); cores.pop();
		writeFileSync(join(root, INDEX_NAME), "not a SQLite database");
		const rebuilt = open(root);
		expect((await rebuilt.reconcile())).toMatchObject({ status: "complete", records: [{ input: 1 }] });
	});

	it("idempotent slim event charges merge with the later JSONL source and expire on deletion", async () => {
		const record = entry("one", 5);
		const a = session(root, "a.jsonl", "/a", []);
		const idx = open(root);
		const event = { filePath: a, project: "/a", identity: chargeIdentity(record), entry: { type: record.type, id: record.id, timestamp: record.timestamp, message: { role: "assistant", provider: "anthropic", model: "sonnet", usage: record.message.usage, timestamp: record.message.timestamp } } };
		expect(idx.ingest([event, event]).records.map(r => r.input)).toEqual([5]);
		add(a, record);
		expect((await idx.reconcile()).records.map(r => r.input)).toEqual([5]);
		unlinkSync(a);
		expect((await idx.reconcile()).records).toEqual([]);
	});

	it("today-only worker operations return canonical keys and no historical records", async () => {
		const old = entry("old", 100);
		const recent = { ...entry("recent", 2), timestamp: new Date().toISOString(), message: { ...entry("recent", 2).message, timestamp: Date.now() } };
		const path = session(root, "a.jsonl", "/a", [old, recent]);
		const service = createUsageIndex(root);
		try {
			const value = await service.reconcileToday();
			expect(value).toMatchObject({ status: "complete", records: [{ input: 2 }] });
			expect(value.keys).toEqual([chargeIdentity(recent)]);
			expect((await service.snapshot()).records).toHaveLength(2);
			expect((await service.today()).records).toHaveLength(1);
			expect((await service.ingestToday([{ filePath: path, project: "/a", identity: chargeIdentity(recent), entry: recent }])).records).toHaveLength(1);
		} finally { await service.close(); }
	});

	it("worker API reconciles and queries snapshots without main-thread filesystem work", async () => {
		const record = entry("one", 1);
		const path = session(root, "a.jsonl", "/a", []);
		const service = createUsageIndex(root);
		try {
			expect((await service.snapshot()).status).toBe("loading");
			const { content: _content, ...message } = record.message;
			expect((await service.ingest([{ filePath: path, project: "/a", identity: chargeIdentity(record), entry: { ...record, message } }])).records).toHaveLength(1);
			add(path, record);
			expect(await service.reconcile()).toMatchObject({ status: "complete", records: [{ input: 1 }] });
			expect((await service.snapshot()).records).toHaveLength(1);
		} finally { await service.close(); }
	});
});
