import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { dedupe, entryFromLine, readTranscripts, resetTranscriptCache } from "../src/core/jsonl";

const temps: string[] = [];

function tempProjects(files: Record<string, string[]>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "aum-test-"));
	temps.push(root);
	for (const [name, lines] of Object.entries(files)) {
		const file = path.join(root, name);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, lines.join("\n"), "utf8");
	}
	return root;
}

function assistantLine(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "assistant",
		timestamp: "2026-07-31T10:00:00.000Z",
		requestId: "req_1",
		message: {
			id: "msg_1",
			model: "claude-sonnet-4-6",
			usage: {
				input_tokens: 100,
				output_tokens: 200,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0
			}
		},
		...overrides
	});
}

afterEach(() => {
	resetTranscriptCache();
	for (const dir of temps.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("entryFromLine", () => {
	it("skips a line with no usage object", () => {
		expect(entryFromLine({ type: "queue-operation", timestamp: "2026-07-31T10:00:00.000Z" })).toBeUndefined();
	});

	it("skips a usage object with no tokens at all", () => {
		expect(
			entryFromLine({
				timestamp: "2026-07-31T10:00:00.000Z",
				message: { usage: { input_tokens: 0, output_tokens: 0 } }
			})
		).toBeUndefined();
	});

	it("skips an entry with no usable timestamp", () => {
		expect(entryFromLine({ message: { usage: { input_tokens: 10, output_tokens: 5 } } })).toBeUndefined();
	});

	it("keys on message id plus request id", () => {
		expect(entryFromLine(JSON.parse(assistantLine()))!.key).toBe("msg_1:req_1");
	});

	it("falls back to a timestamp and token key when both ids are missing", () => {
		const entry = entryFromLine({
			timestamp: "2026-07-31T10:00:00.000Z",
			usage: { input_tokens: 100, output_tokens: 200 }
		})!;
		expect(entry.key).toBe("2026-07-31T10:00:00.000Z:100:200");
	});

	it("uses a pre-computed cost verbatim and marks it exact", () => {
		const entry = entryFromLine(JSON.parse(assistantLine({ costUSD: 0.42 })))!;
		expect(entry.costUsd).toBe(0.42);
		expect(entry.exact).toBe(true);
	});

	it("estimates cost when the transcript carries none", () => {
		const entry = entryFromLine(JSON.parse(assistantLine()))!;
		// Fallback rates: $3/M input, $15/M output.
		expect(entry.costUsd).toBeCloseTo((100 * 3 + 200 * 15) / 1_000_000, 10);
		expect(entry.exact).toBe(false);
	});
});

describe("dedupe", () => {
	it("drops repeats of the same key and sorts ascending", () => {
		const later = entryFromLine(JSON.parse(assistantLine({ timestamp: "2026-07-31T12:00:00.000Z" })))!;
		const earlier = entryFromLine(
			JSON.parse(assistantLine({ timestamp: "2026-07-31T09:00:00.000Z", requestId: "req_2" }))
		)!;
		const duplicate = { ...later };
		const result = dedupe([later, duplicate, earlier]);
		expect(result).toHaveLength(2);
		expect(result[0]!.timestamp.toISOString()).toBe("2026-07-31T09:00:00.000Z");
	});
});

describe("readTranscripts", () => {
	it("skips malformed lines and still returns the good ones", async () => {
		const root = tempProjects({ "a/session.jsonl": ["{not json", assistantLine(), '{"partial":'] });
		const result = await readTranscripts(root);
		expect(result.entries).toHaveLength(1);
	});

	it("drops a duplicate message that appears in two transcripts", async () => {
		// This is real: the same message lands in several files when a session is resumed or forked.
		const root = tempProjects({
			"a/one.jsonl": [assistantLine()],
			"b/two.jsonl": [assistantLine()]
		});
		const result = await readTranscripts(root);
		expect(result.fileCount).toBe(2);
		expect(result.entries).toHaveLength(1);
	});

	it("marks the rollup estimated when any single entry was estimated", async () => {
		const root = tempProjects({
			"a/one.jsonl": [
				assistantLine({ costUSD: 0.5 }),
				assistantLine({ requestId: "req_2", message: { id: "msg_2", model: "claude-opus-4-6", usage: { input_tokens: 5, output_tokens: 5 } } })
			]
		});
		const result = await readTranscripts(root);
		expect(result.entries).toHaveLength(2);
		expect(result.exactness).toBe("estimated");
	});

	it("reports exact when every entry carried a pre-computed cost", async () => {
		const root = tempProjects({ "a/one.jsonl": [assistantLine({ costUSD: 0.5 })] });
		expect((await readTranscripts(root)).exactness).toBe("exact");
	});

	it("returns empty rather than throwing when the directory does not exist", async () => {
		const result = await readTranscripts(path.join(os.tmpdir(), "aum-does-not-exist-12345"));
		expect(result.entries).toEqual([]);
		expect(result.fileCount).toBe(0);
	});
});
