import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { decodeProjectDir, extractSessionId, getSessionsDir } from "./paths";
import { UsageRecord } from "./types";

let cachedRecords: UsageRecord[] | null = null;

interface SessionFileEntry {
	filePath: string;
	fallbackProject: string;
}

export function refreshCachedRecords(): void {
	cachedRecords = null;
}

function collectSessionFiles(rootDir: string, currentDir = rootDir): SessionFileEntry[] {
	let entries: string[];
	try {
		entries = readdirSync(currentDir).sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}

	const files: SessionFileEntry[] = [];
	for (const entry of entries) {
		const entryPath = join(currentDir, entry);
		let stat;
		try {
			stat = statSync(entryPath);
		} catch {
			continue;
		}

		if (stat.isDirectory()) {
			files.push(...collectSessionFiles(rootDir, entryPath));
			continue;
		}

		if (!stat.isFile() || !entry.endsWith(".jsonl")) continue;

		const parts = relative(rootDir, entryPath).split(sep).filter(Boolean);
		const fallbackProject = parts.length > 1 ? decodeProjectDir(parts[0]!) : "unknown";
		files.push({ filePath: entryPath, fallbackProject });
	}

	return files;
}

function getDedupeKey(entry: { id?: unknown; timestamp?: unknown }, sessionId: string, totalTokens: number): string {
	if (typeof entry.id === "string" && entry.id.length > 0) return `id:${entry.id}`;
	return `fallback:${sessionId}:${String(entry.timestamp ?? "")}:${totalTokens}`;
}

export function scanAllSessions(): UsageRecord[] {
	if (cachedRecords) return cachedRecords;

	const sessionsDir = getSessionsDir();
	if (!existsSync(sessionsDir)) {
		cachedRecords = [];
		return cachedRecords;
	}

	const records: UsageRecord[] = [];
	const seen = new Set<string>();
	const sessionFiles = collectSessionFiles(sessionsDir).sort((a, b) => {
		const aRelative = relative(sessionsDir, a.filePath);
		const bRelative = relative(sessionsDir, b.filePath);
		const aDepth = aRelative.split(sep).filter(Boolean).length;
		const bDepth = bRelative.split(sep).filter(Boolean).length;
		if (aDepth !== bDepth) return aDepth - bDepth;
		return aRelative.localeCompare(bRelative);
	});

	for (const { filePath, fallbackProject } of sessionFiles) {
		const sessionId = extractSessionId(filePath);

		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const lines = content.split("\n");
		let project = fallbackProject;
		for (const line of lines) {
			if (!line.trim()) continue;

			if (line.includes('"type":"session"') && line.includes('"cwd"')) {
				try {
					const header = JSON.parse(line);
					if (typeof header.cwd === "string" && header.cwd.length > 0) {
						project = header.cwd;
					}
				} catch {
					// ignore invalid header lines
				}
				continue;
			}

			if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;

			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}

			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (!msg || msg.role !== "assistant" || !msg.usage) continue;

			const usage = msg.usage;
			if (typeof usage.input !== "number" || typeof usage.output !== "number") continue;

			const totalTokens = usage.totalTokens ?? usage.input + usage.output + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
			const dedupeKey = getDedupeKey(entry, sessionId, totalTokens);
			if (seen.has(dedupeKey)) continue;
			seen.add(dedupeKey);

			records.push({
				timestamp: msg.timestamp ?? new Date(entry.timestamp).getTime(),
				isoTimestamp: entry.timestamp,
				provider: msg.provider ?? "unknown",
				model: msg.model ?? "unknown",
				project,
				sessionId,
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead ?? 0,
				cacheWrite: usage.cacheWrite ?? 0,
				totalTokens,
				costTotal: usage.cost?.total ?? 0,
			});
		}
	}

	records.sort((a, b) => a.timestamp - b.timestamp);
	cachedRecords = records;
	return records;
}
