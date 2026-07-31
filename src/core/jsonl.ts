import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { claudeProjects } from "./paths";
import { pluck, pluckNumber, pluckString } from "./pluck";
import { estimateCost, loadPricing } from "./pricing";

export type UsageEntry = {
	/** Stable identity used to drop the same message appearing in several transcripts. */
	key: string;
	timestamp: Date;
	model?: string;
	input: number;
	output: number;
	cacheWrite: number;
	cacheRead: number;
	costUsd: number;
	/** True when the transcript carried a pre-computed cost; false when we estimated it. */
	exact: boolean;
};

const USAGE_PATHS = ["message.usage", "usage"];
const TIMESTAMP_PATHS = ["timestamp", "message.timestamp"];
const MODEL_PATHS = ["message.model", "model"];
const COST_PATHS = ["costUSD", "cost_usd", "message.costUSD"];
const MESSAGE_ID_PATHS = ["message.id", "messageId", "id"];
const REQUEST_ID_PATHS = ["requestId", "request_id", "message.requestId"];

type CacheEntry = { mtimeMs: number; size: number; entries: UsageEntry[] };

const fileCache = new Map<string, CacheEntry>();

/** Recursively collect `*.jsonl` transcripts under the given root. */
function findTranscripts(root: string, out: string[] = []): string[] {
	let dirents: fs.Dirent[];
	try {
		dirents = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const dirent of dirents) {
		const full = path.join(root, dirent.name);
		if (dirent.isDirectory()) {
			findTranscripts(full, out);
		} else if (dirent.isFile() && dirent.name.endsWith(".jsonl")) {
			out.push(full);
		}
	}
	return out;
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Extract a usage entry from one parsed transcript line, or undefined if the line carries none. */
export function entryFromLine(parsed: unknown): UsageEntry | undefined {
	const usage = pluck<Record<string, unknown>>(parsed, USAGE_PATHS);
	if (typeof usage !== "object" || usage === null) {
		return undefined;
	}

	const input = num(usage.input_tokens);
	const output = num(usage.output_tokens);
	const cacheWrite = num(usage.cache_creation_input_tokens);
	const cacheRead = num(usage.cache_read_input_tokens);
	if (input + output + cacheWrite + cacheRead === 0) {
		return undefined;
	}

	const rawTimestamp = pluckString(parsed, TIMESTAMP_PATHS);
	const timestamp = rawTimestamp ? new Date(rawTimestamp) : undefined;
	if (!timestamp || Number.isNaN(timestamp.getTime())) {
		return undefined;
	}

	const model = pluckString(parsed, MODEL_PATHS);
	const precomputed = pluckNumber(parsed, COST_PATHS);
	const exact = precomputed !== undefined && precomputed > 0;

	// The same message appears across transcripts when a session is resumed or forked, and even
	// twice within one file when a request streams more than one frame. Counting those duplicates
	// is the single most common way tools like this report inflated numbers.
	const messageId = pluckString(parsed, MESSAGE_ID_PATHS);
	const requestId = pluckString(parsed, REQUEST_ID_PATHS);
	const key =
		messageId || requestId
			? `${messageId ?? ""}:${requestId ?? ""}`
			: `${timestamp.toISOString()}:${input}:${output}`;

	return {
		key,
		timestamp,
		model,
		input,
		output,
		cacheWrite,
		cacheRead,
		costUsd: exact ? precomputed : estimateCost({ input, output, cacheWrite, cacheRead }, model),
		exact
	};
}

/** Parse one transcript file line by line. Large files must never be read whole into memory. */
async function parseFile(file: string): Promise<UsageEntry[]> {
	const entries: UsageEntry[] = [];
	let stream: fs.ReadStream;
	try {
		stream = fs.createReadStream(file, { encoding: "utf8" });
	} catch {
		return entries;
	}

	const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of rl) {
			if (line.length === 0) {
				continue;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				// Partial trailing lines are normal on a file being appended to.
				continue;
			}
			const entry = entryFromLine(parsed);
			if (entry) {
				entries.push(entry);
			}
		}
	} catch {
		// A read error mid-file still yields whatever we already collected.
	} finally {
		rl.close();
		stream.destroy();
	}
	return entries;
}

export type TranscriptResult = {
	entries: UsageEntry[];
	exactness: "exact" | "estimated";
	fileCount: number;
};

/**
 * Read every transcript under the active Claude directory, deduplicated and sorted ascending.
 *
 * Files are cached by path + mtime + size, so a refresh only re-parses what actually changed.
 */
export async function readTranscripts(root: string = claudeProjects()): Promise<TranscriptResult> {
	loadPricing();
	const files = findTranscripts(root);
	const live = new Set(files);

	for (const cachedPath of [...fileCache.keys()]) {
		if (!live.has(cachedPath)) {
			fileCache.delete(cachedPath);
		}
	}

	for (const file of files) {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(file);
		} catch {
			fileCache.delete(file);
			continue;
		}
		const hit = fileCache.get(file);
		if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
			continue;
		}
		const entries = await parseFile(file);
		fileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, entries });
	}

	const seen = new Set<string>();
	const merged: UsageEntry[] = [];
	let anyEstimated = false;
	for (const cacheEntry of fileCache.values()) {
		for (const entry of cacheEntry.entries) {
			if (seen.has(entry.key)) {
				continue;
			}
			seen.add(entry.key);
			merged.push(entry);
			if (!entry.exact) {
				anyEstimated = true;
			}
		}
	}

	merged.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
	return {
		entries: merged,
		exactness: anyEstimated ? "estimated" : "exact",
		fileCount: files.length
	};
}

/** Drop the parse cache. Used when the Claude directory override changes. */
export function resetTranscriptCache(): void {
	fileCache.clear();
}

/** Deduplicate and sort a set of entries. Exposed for tests and for callers merging their own lists. */
export function dedupe(entries: UsageEntry[]): UsageEntry[] {
	const seen = new Set<string>();
	const out: UsageEntry[] = [];
	for (const entry of entries) {
		if (seen.has(entry.key)) {
			continue;
		}
		seen.add(entry.key);
		out.push(entry);
	}
	out.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
	return out;
}
