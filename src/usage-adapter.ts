import type { ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { chargeIdentity, createUsageIndex, type EventCharge, type TodaySnapshot, type UsageSnapshot } from "./usage-index.ts";
import { eventUsageRecord } from "./usage-index-core.ts";
import { extractSessionId } from "./paths.ts";
import { applyFooterTheme, buildFooterStatus, loadFooterConfig } from "./footer.ts";
import type { UsageRecord } from "./types.ts";

const STATUS_KEY = "token-usage";
export type UsageIndex = Pick<ReturnType<typeof createUsageIndex>, "reconcile" | "reconcileToday" | "snapshot" | "today" | "ingestToday" | "close">;
export const CATCH_UP_MS = 2500;
export const RECONCILE_MS = 50_000;

/** The only retained UI state is scoped to the current session, never its ExtensionContext. */
export function createUsageAdapter(indexFactory: () => UsageIndex = createUsageIndex, intervalMs = RECONCILE_MS) {
 let index: UsageIndex | undefined;
 let generation = 0;
 let sink: { setStatus: ExtensionContext["ui"]["setStatus"]; theme: ExtensionContext["ui"]["theme"]; cwd: string; file?: string; generation: number } | undefined;
 let timer: ReturnType<typeof setInterval> | undefined;
 let sweeping = false;
 let today: TodaySnapshot = { records: [], keys: [], status: "loading" };
 let last: UsageSnapshot = { records: [], status: "loading" };
 const overlay = new Map<string, UsageRecord>();
 const valid = (token: number) => !!sink && sink.generation === token && generation === token;
 const drop = (active: UsageIndex) => {
  if (index === active) { index = undefined; void active.close().catch(() => { /* retry from JSONL */ }); }
 };
 const render = (token: number) => {
  if (!valid(token)) return;
  const { setStatus, theme, cwd } = sink!;
  const config = loadFooterConfig(cwd);
  const known = new Set(today.keys);
  const records = [...today.records, ...[...overlay].filter(([key]) => !known.has(key)).map(([, record]) => record)];
  const status = buildFooterStatus(records, cwd, config);
  const label = today.status === "complete" ? "" : today.status === "loading" ? "Usage loading · " : "Usage stale/incomplete · ";
  setStatus(STATUS_KEY, status ? applyFooterTheme(label + status, config.style, theme) : undefined);
 };
 const acceptToday = (value: TodaySnapshot, token: number) => {
  if (!valid(token)) return;
  today = value;
  for (const key of value.keys) overlay.delete(key);
  render(token);
 };
 const refreshToday = (token: number) => {
  if (!index) return;
  void index.today().then((value) => acceptToday(value, token)).catch(() => { /* retry at the next sweep */ });
 };
 const sweep = (token: number) => {
  if (!valid(token) || sweeping) return;
  if (!index) {
   try { index = indexFactory(); }
   catch (error) { acceptToday({ ...today, status: "incomplete", warning: `Usage index unavailable: ${String(error)}` }, token); return; }
  }
  sweeping = true;
  const active = index;
  void active.reconcileToday().then((value) => acceptToday(value, token))
   .catch((error) => {
    if (!valid(token)) return;
    drop(active);
    acceptToday({ ...today, status: "incomplete", warning: `Usage index unavailable: ${String(error)}` }, token);
   })
   .finally(() => { if (generation === token) sweeping = false; });
 };
 const start = (ctx: ExtensionContext) => {
  if (timer) clearInterval(timer);
  sink?.setStatus(STATUS_KEY, undefined);
  generation++;
  const token = generation;
  const { setStatus, theme } = ctx.ui;
  sink = { setStatus: setStatus.bind(ctx.ui), theme, cwd: ctx.cwd, file: ctx.sessionManager.getSessionFile(), generation: token };
  overlay.clear(); sweeping = false; today = { records: [], keys: [], status: "loading" }; last = { records: [], status: "loading" };
  render(token);
  sweep(token);
  timer = setInterval(() => sweep(token), intervalMs);
  timer.unref?.();
 };
 const shutdown = () => {
  generation++;
  if (timer) clearInterval(timer);
  timer = undefined;
  sink?.setStatus(STATUS_KEY, undefined);
  sink = undefined; overlay.clear();
  const old = index; index = undefined;
  if (old) void old.close().catch(() => { /* reconciliation repairs interrupted writes */ });
 };
 const onTurn = (event: Pick<TurnEndEvent, "messageEntryId" | "toolResultEntryIds">, ctx: ExtensionContext) => {
  if (!sink || sink.file !== ctx.sessionManager.getSessionFile()) start(ctx);
  const token = generation;
  const filePath = ctx.sessionManager.getSessionFile();
  if (!filePath) return;
  const charges: EventCharge[] = [];
  // Pi supplies the persisted IDs at turn_end. Never traverse or serialize the
  // prior conversation just to rediscover this turn's entries.
  for (const id of new Set([event.messageEntryId, ...event.toolResultEntryIds])) {
   const entry = ctx.sessionManager.getEntry(id);
   if (entry?.type !== "message") continue;
   const full = entry as unknown as Record<string, any>;
   const project = ctx.sessionManager.getCwd();
   const record = eventUsageRecord(full, project, extractSessionId(filePath));
   if (!record) continue;
   const identity = chargeIdentity(full);
   overlay.set(identity, record);
   // Identity MUST precede slimming. No transcript content crosses the worker boundary.
   charges.push({ filePath, project, identity, entry: {
    type: full.type, id: full.id, timestamp: full.timestamp,
    message: { role: full.message.role, timestamp: full.message.timestamp, provider: full.message.provider,
     model: full.message.model, usage: full.message.usage },
   } });
  }
  render(token);
  if (charges.length && index) {
   const active = index;
   void active.ingestToday(charges).then((value) => acceptToday(value, token))
    .catch(() => { if (valid(token)) drop(active); /* JSONL reconciliation repairs missed events */ });
  }
 };
 const catchUp = async (): Promise<UsageSnapshot> => {
  if (!index) {
   try { index = indexFactory(); }
   catch (error) { return { records: [], status: "incomplete", warning: `Usage index unavailable: ${String(error)}` }; }
  }
  const active = index;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
   const result = await Promise.race([
    active.reconcile(),
    new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error("catch-up timed out")), CATCH_UP_MS); }),
   ]);
   last = result;
   refreshToday(generation);
   return result;
  } catch (error) {
   if (!(error instanceof Error && error.message === "catch-up timed out")) drop(active);
   return { ...last, status: "incomplete", warning: `Usage index stale/incomplete: ${String(error)}` };
  } finally { if (timeout) clearTimeout(timeout); }
 };
 return { start, shutdown, onTurn, catchUp, render: () => render(generation) };
}

export function usageWarning(snapshot: UsageSnapshot): string {
 if (snapshot.status === "complete") return "";
 return `⚠ Usage ${snapshot.status === "loading" ? "loading" : "stale/incomplete"}: ${snapshot.warning ?? "catch-up has not completed"}. Totals may be partial.\n\n`;
}
