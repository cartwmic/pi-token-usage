import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsageAdapter, type UsageIndex, usageWarning } from "../src/usage-adapter.ts";
import { createUsageIndex } from "../src/usage-index.ts";
import { registerUsage } from "../src/index.ts";
import { chargeIdentity, type UsageSnapshot } from "../src/usage-index-core.ts";
import type { UsageRecord } from "../src/types.ts";

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function deferred<T>() {
 let resolve!: (value: T) => void;
 const promise = new Promise<T>(r => { resolve = r; });
 return { promise, resolve };
}
function fixture() {
 const cwd = mkdtempSync(join(tmpdir(), "usage-adapter-")); roots.push(cwd);
 const file = join(cwd, "sessions", "2026_abc.jsonl");
 const timestamp = Date.now();
 const message = { role: "assistant", provider: "openai", model: "test", timestamp, content: [{ type: "text", text: "private transcript" }], usage: { input: 4, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: { total: 1.25 } } };
 const tool = { role: "toolResult", timestamp, usage: { input: 2, output: 1, cost: { total: .5 } } };
 const assistant = { type: "message", id: "a", parentId: null, timestamp: new Date(timestamp).toISOString(), message };
 const result = { type: "message", id: "b", parentId: "a", timestamp: new Date(timestamp).toISOString(), message: tool };
 const entries: Record<string, any> = { a: assistant, b: result };
 const statuses: (string | undefined)[] = []; const notices: string[] = [];
 const ctx: any = { cwd, ui: { setStatus: (_: string, status?: string) => statuses.push(status), theme: { fg: (_: string, s: string) => s }, notify: (s: string) => notices.push(s) }, sessionManager: { getSessionFile: () => file, getLeafId: () => "b", getEntry: (id: string) => entries[id], getCwd: () => cwd } };
 const event = { message, toolResults: [tool], messageEntryId: "a", toolResultEntryIds: ["b"] };
 return { cwd, file, entries, statuses, notices, ctx, event, assistant, result };
}
function worker() {
 const gate = deferred<UsageSnapshot>();
 const record: UsageRecord = { timestamp: Date.now(), isoTimestamp: new Date().toISOString(), provider: "openai", model: "test", project: "/external", sessionId: "other", input: 8, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 10, costTotal: 2 };
 let current: UsageSnapshot = { records: [], status: "loading" };
 const ingestToday = vi.fn(async () => ({ ...current, keys: [] }));
 const reconcile = vi.fn(() => gate.promise);
 const reconcileToday = vi.fn(() => gate.promise.then(value => ({ ...value, keys: [] })));
 const today = vi.fn(async () => ({ ...current, keys: [] }));
 const close = vi.fn(async () => {});
 return { gate, index: { ingestToday, reconcile, reconcileToday, today, close, snapshot: vi.fn(async () => current) } satisfies UsageIndex, publish: (value: UsageSnapshot) => { current = value; gate.resolve(value); }, record };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe("Pi usage adapter", () => {
 it("settles turn and displays assistant and tool usage before blocked import; identity uses full persisted entry before slimming", async () => {
  const f = fixture(), w = worker(); const adapter = createUsageAdapter(() => w.index);
  adapter.start(f.ctx);
  await Promise.race([Promise.resolve(adapter.onTurn(f.event, f.ctx)), new Promise((_, reject) => setTimeout(() => reject(Error("blocked")), 100))]);
  expect(f.statuses.at(-1)).toContain("$1.75");
  expect(w.index.ingestToday).toHaveBeenCalledOnce();
  const charges = w.index.ingestToday.mock.calls[0]![0];
  expect(charges).toHaveLength(2);
  expect(charges.map(c => c.identity)).toEqual([chargeIdentity(f.assistant), chargeIdentity(f.result)]);
  expect(JSON.stringify(charges)).not.toContain("private transcript");
  w.publish({ records: [], status: "complete" }); await tick(); adapter.shutdown();
 });
 it("does not collapse identical tool-result messages with distinct persisted ids", () => {
  const f = fixture(), w = worker();
  f.entries.c = { ...f.result, id: "c", parentId: "b" };
  f.ctx.sessionManager.getLeafId = () => "c";
  const adapter = createUsageAdapter(() => w.index);
  adapter.start(f.ctx);
  adapter.onTurn({ ...f.event, toolResults: [f.event.toolResults[0], f.event.toolResults[0]], toolResultEntryIds: ["c", "b"] }, f.ctx);
  expect(w.index.ingestToday.mock.calls[0]![0].map(c => c.identity)).toEqual([
   chargeIdentity(f.assistant), chargeIdentity(f.entries.c), chargeIdentity(f.result),
  ]);
  expect(f.statuses.at(-1)).toContain("$2.25");
  adapter.shutdown();
 });
 it("uses persisted turn IDs without walking deep ancestry or comparing large messages", () => {
  const f = fixture(), w = worker();
  f.assistant.message.content = [{ type: "text", text: "x".repeat(1_000_000) }];
  f.ctx.sessionManager.getLeafId = () => { throw Error("ancestor walk must not run"); };
  const adapter = createUsageAdapter(() => w.index);
  adapter.start(f.ctx);
  adapter.onTurn(f.event, f.ctx);
  expect(w.index.ingestToday.mock.calls[0]![0].map(c => c.identity)).toEqual([
   chargeIdentity(f.assistant), chargeIdentity(f.result),
  ]);
  expect(f.statuses.at(-1)).toContain("$1.75");
  adapter.shutdown();
 });
 it("disabled footer stays hidden; late generation cannot update replacement or shutdown sink", async () => {
  const f = fixture(), w = worker(), other = fixture(), next = worker();
  let started = 0; const adapter = createUsageAdapter(() => ++started === 1 ? w.index : next.index);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(f.cwd, ".pi-token-usage.json"), JSON.stringify({ enabled: false }));
  adapter.start(f.ctx); adapter.onTurn(f.event, f.ctx);
  expect(f.statuses.at(-1)).toBeUndefined();
  adapter.shutdown(); const prior = f.statuses.length;
  // The old pending completion arrives only after another session is active.
  adapter.start(other.ctx);
  w.publish({ records: [w.record], status: "complete" }); await tick();
  expect(f.statuses).toHaveLength(prior);
  next.publish({ records: [next.record], status: "complete" }); await tick();
  expect(f.statuses).toHaveLength(prior);
  adapter.shutdown();
 });
 it("passive idle timer consumes a shared-index update without a local turn", async () => {
  vi.useFakeTimers(); const f = fixture(); let current: UsageSnapshot = { records: [], status: "complete" };
  const w = worker(); w.index.reconcileToday.mockImplementation(async () => ({ ...current, keys: [] }));
  w.index.today.mockImplementation(async () => ({ ...current, keys: [] }));
  const adapter = createUsageAdapter(() => w.index, 50_000);
  adapter.start(f.ctx); await tick(); expect(f.statuses.at(-1)).toContain("$0.00");
  current = { records: [{ ...w.record, project: f.cwd }], status: "complete" };
  await vi.advanceTimersByTimeAsync(50_000); await tick();
  expect(f.statuses.at(-1)).toContain("$2.00"); adapter.shutdown();
 });
 it("idle passive worker reads a charge published through another worker's shared index", async () => {
  const f = fixture();
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(join(f.cwd, "sessions"));
  const producer = createUsageIndex(f.cwd);
  // The second Pi window opens the already initialized shared database.
  await producer.reconcile();
  const consumer = createUsageIndex(f.cwd);
  const adapter = createUsageAdapter(() => consumer, 30);
  try {
   adapter.start(f.ctx);
   const charge = { filePath: f.file, project: f.cwd, identity: chargeIdentity(f.assistant), entry: f.assistant };
   writeFileSync(f.file, JSON.stringify({ type: "session", cwd: f.cwd }) + "\n" + JSON.stringify(f.assistant) + "\n");
   await producer.reconcile();
   await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { clearInterval(check); reject(Error(`passive footer did not update: ${JSON.stringify(f.statuses)}`)); }, 3000);
    const check = setInterval(() => {
     if (f.statuses.at(-1)?.includes("$1.25") && !f.statuses.at(-1)?.includes("stale")) {
      clearTimeout(timeout); clearInterval(check); resolve();
     }
    }, 20);
   });
   expect((await producer.today()).keys).toEqual([charge.identity]);
  } finally { adapter.shutdown(); await producer.close(); }
 });
 it("bounded explicit catch-up warns on timeout, then recovers; loading is never complete", async () => {
  vi.useFakeTimers(); const f = fixture(), w = worker(); const adapter = createUsageAdapter(() => w.index);
  adapter.start(f.ctx);
  expect(usageWarning({ records: [], status: "loading" })).toContain("loading");
  const request = adapter.catchUp(); await vi.advanceTimersByTimeAsync(2500);
  expect(usageWarning(await request)).toMatch(/stale\/incomplete.*partial/);
  w.publish({ records: [w.record], status: "complete" }); await tick();
  expect((await adapter.catchUp()).records).toHaveLength(1);
  adapter.shutdown();
 });
 it("worker creation failure warns without failing the turn and recovers on retry", async () => {
  const f = fixture(), w = worker(); let attempts = 0;
  w.index.reconcileToday.mockImplementation(async () => ({ records: [], keys: [], status: "complete" }));
  w.index.reconcile.mockImplementation(async () => ({ records: [w.record], status: "complete" }));
  const adapter = createUsageAdapter(() => { if (++attempts === 1) throw Error("worker unavailable"); return w.index; });
  adapter.start(f.ctx);
  expect(f.statuses.at(-1)).toContain("stale/incomplete");
  expect((await adapter.catchUp()).status).toBe("complete");
  adapter.onTurn(f.event, f.ctx);
  expect(f.statuses.at(-1)).toContain("$1.75");
  adapter.shutdown();
 });
 it("command shows bounded timeout warning, then complete recovery", async () => {
  vi.useFakeTimers(); const f = fixture(), w = worker();
  const handlers: Record<string, any> = {};
  const pi: any = { on: (name: string, handler: any) => { handlers[name] = handler; }, registerCommand: (_: string, spec: any) => { handlers.usage = spec.handler; } };
  registerUsage(pi, createUsageAdapter(() => w.index)); handlers.session_start({}, f.ctx);
  const command = handlers.usage("models", f.ctx);
  await vi.advanceTimersByTimeAsync(2500); await command;
  expect(f.notices.at(-1)).toMatch(/stale\/incomplete.*partial[\s\S]*No usage data found/);
  w.publish({ records: [w.record], status: "complete" }); await tick();
  await handlers.usage("models", f.ctx);
  expect(f.notices.at(-1)).toContain("Usage by Model");
  expect(f.notices.at(-1)).not.toContain("incomplete");
  handlers.session_shutdown();
 });
 it("help and footer settings do not wait for a blocked history catch-up", async () => {
  const f = fixture(), w = worker();
  const handlers: Record<string, any> = {};
  const pi: any = { on: (name: string, handler: any) => { handlers[name] = handler; }, registerCommand: (_: string, spec: any) => { handlers.usage = spec.handler; } };
  registerUsage(pi, createUsageAdapter(() => w.index)); handlers.session_start({}, f.ctx);
  await Promise.race([handlers.usage("help", f.ctx), new Promise((_, reject) => setTimeout(() => reject(Error("help blocked")), 100))]);
  await Promise.race([handlers.usage("footer off", f.ctx), new Promise((_, reject) => setTimeout(() => reject(Error("footer blocked")), 100))]);
  expect(f.notices.at(-2)).toContain("Usage Commands");
  expect(f.notices.at(-1)).toContain("Footer disabled");
  expect(f.statuses.at(-1)).toBeUndefined();
  expect(w.index.reconcile).not.toHaveBeenCalled();
  w.publish({ records: [], status: "complete" }); await tick(); handlers.session_shutdown();
 });
 it("dispatches all existing report and footer routes against snapshots without scanning", async () => {
  const f = fixture(), w = worker();
  w.index.reconcile.mockImplementation(async () => ({ records: [w.record], status: "complete" }));
  w.index.today.mockImplementation(async () => ({ records: [], status: "complete", keys: [] }));
  const handlers: Record<string, any> = {};
  const pi: any = { on: (name: string, handler: any) => { handlers[name] = handler; }, registerCommand: (_: string, spec: any) => { handlers.usage = spec.handler; } };
  registerUsage(pi, createUsageAdapter(() => w.index)); handlers.session_start({}, f.ctx);
  const routes: [string, string][] = [["", "Token Usage"], ["models", "Usage by Model"], ["days 3", "Daily Usage"], ["months", "Monthly Usage"], ["sessions 4", "Sessions by Cost"], ["projects", "Usage by Project"], ["help", "Usage Commands"], ["?", "Usage Commands"], ["refresh", "Token Usage"], ["footer", "Footer"], ["footer vars", "projectToday"], ["footer off", "Footer disabled"], ["footer on", "Footer enabled"], ["footer items totalTodayCost", "Footer items updated"], ["footer preset full", "applied"], ["footer separator |", "separator updated"], ["footer style plain", "style updated"], ["footer template hello", "template updated"], ["footer untemplate", "template removed"], ["footer reset", "config removed"]];
  for (const [route, expected] of routes) {
   await handlers.usage(route, f.ctx); expect(f.notices.at(-1), route).toContain(expected);
   if (route === "footer off") expect(f.statuses.at(-1)).toBeUndefined();
   if (route === "footer on") expect(f.statuses.at(-1)).toContain("Proj today");
  }
  expect(w.index.reconcile).toHaveBeenCalled(); handlers.session_shutdown();
 });
});
