import type { UsageEntry } from "./jsonl";

export const BLOCK_MS = 5 * 60 * 60 * 1000;

export type Block = {
	/** First entry's timestamp, floored to the hour. */
	start: Date;
	/** `start` + 5h. */
	end: Date;
	entries: UsageEntry[];
	costUsd: number;
	tokens: number;
	/** True when `now` falls inside the window. At most one block is active. */
	isActive: boolean;
};

function floorToHour(date: Date): Date {
	const floored = new Date(date.getTime());
	floored.setMinutes(0, 0, 0);
	return floored;
}

function tokensOf(entry: UsageEntry): number {
	return entry.input + entry.output + entry.cacheWrite + entry.cacheRead;
}

/**
 * Group usage entries into the rolling 5-hour blocks Claude Code bills against.
 *
 * A block opens at an entry's timestamp floored to the hour and runs for five hours. A new block
 * opens when an entry falls at or past the current block's end, or when five hours pass with no
 * entries at all — an idle gap ends the block just as reaching the boundary does.
 */
export function buildBlocks(entries: UsageEntry[], now: Date = new Date()): Block[] {
	if (entries.length === 0) {
		return [];
	}

	const sorted = [...entries].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
	const blocks: Block[] = [];
	let current: Block | undefined;
	let lastTimestamp = 0;

	for (const entry of sorted) {
		const at = entry.timestamp.getTime();
		const startsNewBlock =
			current === undefined || at >= current.end.getTime() || at - lastTimestamp >= BLOCK_MS;

		if (startsNewBlock) {
			const start = floorToHour(entry.timestamp);
			current = {
				start,
				end: new Date(start.getTime() + BLOCK_MS),
				entries: [],
				costUsd: 0,
				tokens: 0,
				isActive: false
			};
			blocks.push(current);
		}

		current!.entries.push(entry);
		current!.costUsd += entry.costUsd;
		current!.tokens += tokensOf(entry);
		lastTimestamp = at;
	}

	const nowMs = now.getTime();
	for (const block of blocks) {
		block.isActive = nowMs >= block.start.getTime() && nowMs < block.end.getTime();
	}

	return blocks;
}

/** The block whose window contains `now`, if any. */
export function activeBlock(blocks: Block[]): Block | undefined {
	return blocks.find((b) => b.isActive);
}
