import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { refreshCachedRecords, scanAllSessions } from "../src/scan";

function writeSessionFile(baseDir: string, relativeDir: string, filename: string, lines: Array<Record<string, unknown> | string>) {
	const dir = join(baseDir, "sessions", relativeDir);
	mkdirSync(dir, { recursive: true });
	const content = lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n");
	writeFileSync(join(dir, filename), `${content}\n`, "utf-8");
}

function writeRootSessionFile(baseDir: string, filename: string, lines: Array<Record<string, unknown> | string>) {
	const dir = join(baseDir, "sessions");
	mkdirSync(dir, { recursive: true });
	const content = lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n");
	writeFileSync(join(dir, filename), `${content}\n`, "utf-8");
}

describe("scanAllSessions", () => {
	let tempDir: string;
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		tempDir = mkdtempSync(join(tmpdir(), "pi-token-usage-"));
		process.env.PI_CODING_AGENT_DIR = tempDir;
		refreshCachedRecords();
	});

	afterEach(() => {
		refreshCachedRecords();
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("parses root and nested session files, uses session cwd, deduplicates by entry id, and sorts chronologically", () => {
		writeRootSessionFile(tempDir, "2026-04-02T13-54-08-857Z_root-session.jsonl", [
			{ type: "session", cwd: "/Users/test/root-project" },
			{
				type: "message",
				id: "root-msg-1",
				timestamp: "2026-04-02T09:58:00.000Z",
				message: {
					role: "assistant",
					provider: "openai-codex",
					model: "gpt-5.4",
					usage: {
						input: 5,
						output: 7,
						cost: { total: 0.02 },
					},
				},
			},
		]);

		writeSessionFile(tempDir, "fallback-project", "2026-04-02T13-55-08-857Z_session-a.jsonl", [
			{ type: "session", cwd: "/Users/test/real-project" },
			{ type: "message", timestamp: "2026-04-02T10:00:00.000Z", message: { role: "user", content: "hi" } },
			{
				type: "message",
				id: "shared-msg-1",
				timestamp: "2026-04-02T10:01:00.000Z",
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude-haiku-4-5-20251001",
					timestamp: new Date("2026-04-02T10:01:00.000Z").getTime(),
					usage: {
						input: 100,
						output: 50,
						cacheRead: 25,
						cacheWrite: 10,
						totalTokens: 185,
						cost: { total: 0.42 },
					},
				},
			},
		]);

		writeSessionFile(tempDir, "2026-04-02T13-55-08-857Z_session-a/abcd1234/run-0", "2026-04-02T13-56-08-857Z_nested-session.jsonl", [
			{ type: "session", cwd: "/Users/test/nested-project" },
			"not json",
			{
				type: "message",
				id: "nested-msg-1",
				timestamp: "2026-04-02T09:59:00.000Z",
				message: {
					role: "assistant",
					provider: "openai-codex",
					model: "gpt-5.4",
					usage: {
						input: 10,
						output: 20,
						cacheRead: 0,
						cacheWrite: 0,
						cost: { total: 0.05 },
					},
				},
			},
			{
				// duplicate of session-a assistant message copied into a branched subagent session
				type: "message",
				id: "shared-msg-1",
				timestamp: "2026-04-02T10:01:00.000Z",
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude-haiku-4-5-20251001",
					usage: {
						input: 100,
						output: 50,
						cacheRead: 25,
						cacheWrite: 10,
						totalTokens: 185,
						cost: { total: 0.42 },
					},
				},
			},
		]);

		const records = scanAllSessions();
		expect(records).toHaveLength(3);
		expect(records.map((r) => r.timestamp)).toEqual([
			new Date("2026-04-02T09:58:00.000Z").getTime(),
			new Date("2026-04-02T09:59:00.000Z").getTime(),
			new Date("2026-04-02T10:01:00.000Z").getTime(),
		]);
		expect(records[0].project).toBe("/Users/test/root-project");
		expect(records[1].project).toBe("/Users/test/nested-project");
		expect(records[2].project).toBe("/Users/test/real-project");
		expect(records[2].sessionId).toBe("session-a");
		expect(records[1].sessionId).toBe("nested-session");
		expect(records[0].sessionId).toBe("root-session");
		expect(records[1].totalTokens).toBe(30);
	});

	it("uses cache until refreshCachedRecords is called", () => {
		writeSessionFile(tempDir, "project-a", "2026-04-02T13-55-08-857Z_session-a.jsonl", [
			{
				type: "message",
				timestamp: "2026-04-02T10:01:00.000Z",
				message: {
					role: "assistant",
					usage: { input: 1, output: 2, cost: { total: 0.01 } },
				},
			},
		]);

		const first = scanAllSessions();
		expect(first).toHaveLength(1);

		writeSessionFile(tempDir, "project-b", "2026-04-02T13-56-08-857Z_session-b.jsonl", [
			{
				type: "message",
				timestamp: "2026-04-02T10:02:00.000Z",
				message: {
					role: "assistant",
					usage: { input: 3, output: 4, cost: { total: 0.02 } },
				},
			},
		]);

		const second = scanAllSessions();
		expect(second).toHaveLength(1);

		refreshCachedRecords();
		const third = scanAllSessions();
		expect(third).toHaveLength(2);
	});

	it("ignores malformed and incomplete usage entries", () => {
		writeSessionFile(tempDir, "project-a", "2026-04-02T13-55-08-857Z_session-a.jsonl", [
			{ type: "message", timestamp: "2026-04-02T10:00:00.000Z", message: { role: "assistant" } },
			{ type: "message", timestamp: "2026-04-02T10:01:00.000Z", message: { role: "assistant", usage: { input: "bad", output: 1 } } },
			{ type: "message", timestamp: "2026-04-02T10:02:00.000Z", message: { role: "assistant", usage: { input: 5, output: 6 } } },
		]);

		const records = scanAllSessions();
		expect(records).toHaveLength(1);
		expect(records[0].costTotal).toBe(0);
		expect(records[0].provider).toBe("unknown");
		expect(records[0].model).toBe("unknown");
		expect(records[0].totalTokens).toBe(11);
	});
});
