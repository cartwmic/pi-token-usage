import { Worker } from "node:worker_threads";
import { dirname } from "node:path";
import { getSessionsDir } from "./paths.ts";
import type { EventCharge, UsageSnapshot, TodaySnapshot } from "./usage-index-core.ts";
export type { EventCharge, UsageSnapshot, TodaySnapshot } from "./usage-index-core.ts";
export { chargeIdentity } from "./usage-index-core.ts";

/** One worker per Pi process. All file reads and SQLite calls stay off the UI thread. */
export function createUsageIndex(agentRoot = dirname(getSessionsDir())) {
	const worker = new Worker(new URL("./usage-worker.ts", import.meta.url), { workerData: { agentRoot } });
	let serial = 0;
	let closed = false;
	let failure: Error | undefined;
	const pending = new Map<number, { resolve: (snapshot: any) => void; reject: (e: Error) => void }>();
	worker.on("message", ({ id, result, error }) => {
		const request = pending.get(id);
		if (!request) return;
		pending.delete(id);
		if (error) request.reject(new Error(error)); else request.resolve(result);
	});
	const fail = (error: Error) => { failure = error; closed = true; for (const request of pending.values()) request.reject(error); pending.clear(); };
	worker.on("error", fail);
	worker.on("exit", (code) => fail(new Error(`Usage index worker exited (${code})`)));
	const send = <T = UsageSnapshot>(action: string, charges?: EventCharge[]): Promise<T> => {
		if (closed) return Promise.reject(failure ?? new Error("Usage index closed"));
		return new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); worker.postMessage({ id, action, charges }); });
	};
	return {
		reconcile: () => send("reconcile"),
		reconcileToday: () => send<TodaySnapshot>("reconcileToday"),
		snapshot: () => send("snapshot"),
		today: () => send<TodaySnapshot>("today"),
		// Fire-and-forget is safe for turn_end; the adapter owns a local overlay until
		// this settles, and reconciliation repairs a missed event write.
		ingest: (charges: EventCharge[]) => send("ingest", charges),
		ingestToday: (charges: EventCharge[]) => send<TodaySnapshot>("ingestToday", charges),
		close: async () => {
			if (closed) return;
			// Queue behind earlier operations; terminate after a bounded grace period if one is stalled.
			const closing = send("close"); closed = true;
			let timeout: ReturnType<typeof setTimeout>;
			try { await Promise.race([closing, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("close timeout")), 3000); })]); }
			finally { clearTimeout(timeout!); await worker.terminate(); }
		},
	};
}
