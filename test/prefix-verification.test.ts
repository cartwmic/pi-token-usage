import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INDEX_NAME, UsageIndexCore } from "../src/usage-index-core.ts";

// An append is trusted only if EVERY previously indexed byte still matches (full-prefix verification). These tests pin that invariant
// independently of how the prefix is read (one reusable buffer or many), so a change to the reading loop cannot weaken it.
const CHUNK = 256 * 1024;
const time = "2026-04-02T10:00:00.000Z";
const line = (o: object) => JSON.stringify(o) + "\n";
// Leading space: JSON tolerates whitespace, so the very first byte can be edited without making the file unparseable.
const header = (id: string) => " " + line({ type: "session", cwd: "/p", id });
const charge = (id: string, input: number) => ({ type: "message", id, parentId: null, timestamp: time, message: { role: "assistant", provider: "anthropic", model: "sonnet", timestamp: Date.parse(time), usage: { input, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: input / 100 } } } });
/** A header, one charge and one padding line sized so the whole file is exactly `size` bytes. */
function fileOfSize(size: number, input: number): string {
	const base = header("f") + line(charge("c", input));
	const empty = line({ type: "custom", id: "pad", data: "" }).length;
	const fill = size - base.length - empty;
	if (fill < 0) throw new Error("size too small: " + size);
	const text = base + line({ type: "custom", id: "pad", data: "x".repeat(fill) });
	if (text.length !== size) throw new Error("size arithmetic " + text.length + " != " + size);
	return text;
}
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
function stored(root: string, path: string) {
	const db = new DatabaseSync(join(root, INDEX_NAME), { readOnly: true });
	try { return db.prepare("SELECT size,offset,prefix FROM files WHERE path=?").get(path) as { size: number; offset: number; prefix: string } | undefined; } finally { db.close(); }
}

describe("full-prefix verification of grown session files", () => {
	let root: string; let cores: UsageIndexCore[]; let file: string;
	beforeEach(() => { root = mkdtempSync(join(tmpdir(), "pi-usage-prefix-")); cores = []; mkdirSync(join(root, "sessions"), { recursive: true }); file = join(root, "sessions", "a.jsonl"); });
	afterEach(() => { for (const c of cores) c.close(); rmSync(root, { recursive: true, force: true }); });
	const open = (hooks: ConstructorParameters<typeof UsageIndexCore>[1] = {}) => { const c = new UsageIndexCore(root, hooks); cores.push(c); return c; };
	const reads = () => { const trace: number[] = []; return { trace, hooks: { onBodyRead: (p: string, n: number) => { if (p === file) trace.push(n); } }, total: () => trace.reduce((a, b) => a + b, 0) }; };

	// Sizes around the 256 KiB chunk: below, exact, above, multiples, and a tiny file.
	const SIZES = [400, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK - 1, 2 * CHUNK, 2 * CHUNK + 1, 3 * CHUNK + 7];
	for (const size of SIZES) {
		it(`size ${size}: an append re-verifies exactly the old ${size} bytes, reads only the new suffix, and stores the full-file hash`, async () => {
			writeFileSync(file, fileOfSize(size, 101));
			const t = reads(); const idx = open(t.hooks);
			expect((await idx.reconcile()).records.map(r => r.input)).toEqual([101]);
			expect(t.total()).toBe(size); // first import reads the file once
			t.trace.length = 0;
			const extra = line(charge("n", 202));
			appendFileSync(file, extra);
			expect((await idx.reconcile()).records.map(r => r.input).sort()).toEqual([101, 202]);
			expect(t.total()).toBe(size + extra.length); // old prefix (verification) + new suffix, nothing more
			const row = stored(root, file)!;
			expect(row.size).toBe(size + extra.length); expect(row.offset).toBe(row.size);
			expect(row.prefix).toBe(sha(readFileSync(file)));
			// a second sweep with no change reads no body at all
			t.trace.length = 0; await idx.reconcile(); expect(t.total()).toBe(0);
		});
	}

	// Editing any single byte of the previously indexed region must defeat the append fast path (so the file is rebuilt, not trusted).
	const editCases: Array<[string, (b: Buffer) => number]> = [
		["first byte", () => 0],
		["last byte (the final newline)", (b) => b.length - 1],
		["a byte exactly at a chunk boundary", () => CHUNK],
		["the byte just before a chunk boundary", () => CHUNK - 1],
		["a byte in the second chunk", () => CHUNK + 5],
	];
	for (const [name, pick] of editCases) {
		it(`edit of ${name} in the old prefix is detected: no append shortcut, no stale data`, async () => {
			const size = 2 * CHUNK + 50;
			writeFileSync(file, fileOfSize(size, 100001));
			const t = reads(); const idx = open(t.hooks); await idx.reconcile(); t.trace.length = 0;
			const bytes = readFileSync(file); const at = pick(bytes);
			expect(at).toBeLessThan(bytes.length);
			// change one byte without changing the size or the number of lines
			const original = bytes[at]; bytes[at] = original === 0x20 ? 0x09 : original === 0x0a ? 0x20 : original === 0x78 ? 0x79 : 0x21; // space->tab, newline->space, x->y: always still valid JSON
			writeFileSync(file, bytes);
			expect(statSync(file).size).toBe(size);
			const extra = at === bytes.length - 1 ? "\n" + line(charge("n", 100002)) : line(charge("n", 100002)); // replacing the final newline needs a line break before the new entry
			appendFileSync(file, extra);
			const result = await idx.reconcile();
			expect(t.total()).toBe(size + statSync(file).size); // verified the old prefix, FOUND the mismatch, then re-read the whole file
			expect(stored(root, file)!.prefix).toBe(sha(readFileSync(file)));
			expect(result.records.map(r => r.input).sort()).toEqual([100001, 100002]);
		});
	}
	it("an in-place edit of an early charge value (same length) is reflected after an append, never kept stale", async () => {
		const entries = [charge("a", 111111), charge("b", 222222)];
		writeFileSync(file, header("f") + entries.map(line).join("") + line({ type: "custom", id: "pad", data: "y".repeat(CHUNK) }));
		const idx = open(); expect((await idx.reconcile()).records.map(r => r.input).sort()).toEqual([111111, 222222]);
		writeFileSync(file, readFileSync(file, "utf8").replace('"input":111111', '"input":111112'));
		appendFileSync(file, line(charge("c", 333333)));
		expect((await idx.reconcile()).records.map(r => r.input).sort()).toEqual([111112, 222222, 333333]);
	});

	// Model-based differential: a seeded random walk of appends, same-length edits, rewrites and deletions over three files.
	// After EVERY step the incremental index must equal what the files actually contain, and every fully-read file must store the true full-file hash.
	for (const seed of [1, 7, 42]) {
		it(`randomized walk (seed ${seed}): the incremental index always equals the files' contents and stored hashes equal full-file hashes`, async () => {
			let state = seed >>> 0; const rnd = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
			const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
			const names = ["x.jsonl", "y.jsonl", "z/w.jsonl"]; let next = 100000;
			const model = new Map<string, number[]>(); // file -> charge inputs in order
			const pads = new Map<string, number>(); // file -> padding bytes (to cross chunk boundaries)
			const paths = new Map(names.map(n => [n, join(root, "sessions", n)]));
			mkdirSync(join(root, "sessions", "z"), { recursive: true });
			const render = (n: string) => header(n) + (model.get(n) ?? []).map((v, i) => line(charge(n + i, v))).join("") + (pads.get(n) ? line({ type: "custom", id: "pad", data: "p".repeat(pads.get(n)!) }) : "");
			const idx = open();
			for (let step = 0; step < 36; step++) {
				const n = pick(names); const path = paths.get(n)!; const op = pick(["append", "append", "edit", "rewrite", "delete", "pad"]);
				const have = model.has(n);
				if (op === "delete" && have) { unlinkSync(path); model.delete(n); pads.delete(n); }
				else if (op === "rewrite" || !have) { model.set(n, Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => next++)); pads.set(n, Math.floor(rnd() * 3) * CHUNK + Math.floor(rnd() * 5)); writeFileSync(path, render(n)); }
				else if (op === "edit") { const xs = model.get(n)!; const i = Math.floor(rnd() * xs.length); const old = xs[i]; xs[i] = next++; writeFileSync(path, readFileSync(path, "utf8").replace('"input":' + old, '"input":' + xs[i])); }
				else if (op === "pad") { pads.set(n, (pads.get(n) ?? 0) + 1 + Math.floor(rnd() * CHUNK)); writeFileSync(path, render(n)); }
				else { const v = next++; model.get(n)!.push(v); const padLine = pads.get(n) ? line({ type: "custom", id: "pad", data: "p".repeat(pads.get(n)!) }) : ""; const text = readFileSync(path, "utf8"); writeFileSync(path, text.slice(0, text.length - padLine.length) + line(charge(n + (model.get(n)!.length - 1), v)) + padLine); }
				const expected = [...model.values()].flat().sort((a, b) => a - b);
				const got = (await idx.reconcile()); 
				expect(got.records.map(r => r.input).sort((a, b) => a - b), `seed ${seed} step ${step} ${op} ${n}`).toEqual(expected);
				for (const [name, p] of paths) if (model.has(name)) { const row = stored(root, p); expect(row?.prefix, `hash ${name} step ${step}`).toBe(sha(readFileSync(p))); expect(row?.offset).toBe(row?.size); }
			}
		});
	}
});
