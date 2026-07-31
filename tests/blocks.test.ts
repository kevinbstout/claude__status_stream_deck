import { describe, expect, it } from "vitest";

import { BLOCK_MS, activeBlock, buildBlocks } from "../src/core/blocks";
import type { UsageEntry } from "../src/core/jsonl";

let counter = 0;

function entry(iso: string, costUsd = 1): UsageEntry {
	counter += 1;
	return {
		key: `k${counter}`,
		timestamp: new Date(iso),
		model: "claude-sonnet-4-6",
		input: 10,
		output: 20,
		cacheWrite: 0,
		cacheRead: 0,
		costUsd,
		exact: false
	};
}

describe("buildBlocks", () => {
	it("returns nothing for empty input", () => {
		expect(buildBlocks([])).toEqual([]);
	});

	it("opens one block for a single entry, floored to the hour", () => {
		const blocks = buildBlocks([entry("2026-07-31T10:37:00.000Z")], new Date("2026-07-31T11:00:00.000Z"));
		expect(blocks).toHaveLength(1);
		expect(blocks[0]!.start.toISOString()).toBe("2026-07-31T10:00:00.000Z");
		expect(blocks[0]!.end.getTime() - blocks[0]!.start.getTime()).toBe(BLOCK_MS);
		expect(blocks[0]!.entries).toHaveLength(1);
	});

	it("opens a new block for an entry exactly at the 5h boundary", () => {
		// Block one starts at 10:00 and ends at 15:00; an entry at 15:00 belongs to the next block.
		const blocks = buildBlocks(
			[entry("2026-07-31T10:30:00.000Z"), entry("2026-07-31T15:00:00.000Z")],
			new Date("2026-07-31T15:10:00.000Z")
		);
		expect(blocks).toHaveLength(2);
		expect(blocks[1]!.start.toISOString()).toBe("2026-07-31T15:00:00.000Z");
	});

	it("keeps an entry just inside the boundary in the same block", () => {
		const blocks = buildBlocks(
			[entry("2026-07-31T10:30:00.000Z"), entry("2026-07-31T14:59:00.000Z")],
			new Date("2026-07-31T15:00:00.000Z")
		);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]!.entries).toHaveLength(2);
	});

	it("opens a new block after a 6h idle gap", () => {
		const blocks = buildBlocks(
			[entry("2026-07-31T01:10:00.000Z"), entry("2026-07-31T07:10:00.000Z")],
			new Date("2026-07-31T08:00:00.000Z")
		);
		expect(blocks).toHaveLength(2);
		expect(blocks[1]!.start.toISOString()).toBe("2026-07-31T07:00:00.000Z");
	});

	it("sorts out-of-order input before grouping", () => {
		const blocks = buildBlocks(
			[entry("2026-07-31T12:00:00.000Z"), entry("2026-07-31T10:30:00.000Z"), entry("2026-07-31T11:00:00.000Z")],
			new Date("2026-07-31T12:30:00.000Z")
		);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]!.start.toISOString()).toBe("2026-07-31T10:00:00.000Z");
		expect(blocks[0]!.entries.map((e) => e.timestamp.toISOString())).toEqual([
			"2026-07-31T10:30:00.000Z",
			"2026-07-31T11:00:00.000Z",
			"2026-07-31T12:00:00.000Z"
		]);
	});

	it("marks at most one block active, and only when now falls inside it", () => {
		const blocks = buildBlocks(
			[entry("2026-07-31T01:10:00.000Z"), entry("2026-07-31T09:10:00.000Z")],
			new Date("2026-07-31T10:00:00.000Z")
		);
		expect(blocks.filter((b) => b.isActive)).toHaveLength(1);
		expect(activeBlock(blocks)!.start.toISOString()).toBe("2026-07-31T09:00:00.000Z");
	});

	it("reports no active block once every window has passed", () => {
		const blocks = buildBlocks([entry("2026-07-30T01:10:00.000Z")], new Date("2026-07-31T10:00:00.000Z"));
		expect(activeBlock(blocks)).toBeUndefined();
	});

	it("accumulates cost and tokens per block", () => {
		const blocks = buildBlocks(
			[entry("2026-07-31T10:00:00.000Z", 0.5), entry("2026-07-31T11:00:00.000Z", 0.25)],
			new Date("2026-07-31T12:00:00.000Z")
		);
		expect(blocks[0]!.costUsd).toBeCloseTo(0.75);
		expect(blocks[0]!.tokens).toBe(60);
	});
});
