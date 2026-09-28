import { parentPort, workerData } from "node:worker_threads";
import { appendFileSync, existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { UsageIndexCore, type EventCharge } from "./usage-index-core.ts";

const readTrace = process.env.PI_TOKEN_USAGE_TEST_READ_TRACE;
const index = new UsageIndexCore(workerData.agentRoot, readTrace ? {
	onBodyRead: (path, bytes) => appendFileSync(readTrace, `${JSON.stringify({ path, bytes })}\n`),
} : {});
let queue = Promise.resolve();
parentPort!.on("message", ({ id, action, charges }: { id: number; action: string; charges?: EventCharge[] }) => {
	queue = queue.then(async () => {
		try {
			// Test-only import gate: the PTY scenario holds historical reconciliation
			// while Pi must still settle a turn and render its local usage overlay.
			const gate = process.env.PI_TOKEN_USAGE_TEST_GATE;
			if (gate && (action === "reconcile" || action === "reconcileToday")) {
				while (existsSync(gate)) await delay(20);
			}
			const result = action === "reconcile" ? await index.reconcile() : action === "reconcileToday" ? await index.reconcile(true) : action === "snapshot" ? index.snapshot() : action === "today" ? index.today() : action === "ingest" ? index.ingest(charges ?? []) : action === "ingestToday" ? index.ingest(charges ?? [], true) : undefined;
			if (action === "close") index.close();
			parentPort!.postMessage({ id, result });
			if (action === "close") parentPort!.close();
		} catch (error) { parentPort!.postMessage({ id, error: String(error) }); }
	});
});
