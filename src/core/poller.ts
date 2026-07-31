import streamDeck from "@elgato/streamdeck";

import { resetTranscriptCache } from "./jsonl";
import { planUsageSourceIndex } from "./paths";
import { lastPlanUsageFailure, resetPlanUsageCache } from "./plan-usage";
import { EMPTY_SNAPSHOT, type Snapshot, computeSnapshot } from "./snapshot";
import { watchState } from "./state";

const POLL_MS = 5_000;

export type Listener = (snapshot: Snapshot) => void;

const listeners = new Set<Listener>();

let current: Snapshot = EMPTY_SNAPSHOT;
let signature = "";
let timer: NodeJS.Timeout | undefined;
let unwatch: (() => void) | undefined;
let running = false;

/**
 * Stable signature of a snapshot, used to skip redundant frames.
 *
 * Elgato caps programmatic updates at ten per second; we sit far below that, but there is still no
 * reason to push an identical frame to every action every five seconds.
 */
function signatureOf(snapshot: Snapshot): string {
	return JSON.stringify(snapshot);
}

async function refresh(force = false): Promise<void> {
	let next: Snapshot;
	try {
		next = await computeSnapshot();
	} catch (error) {
		// Log the shape of the failure, never its contents.
		streamDeck.logger.error(`snapshot refresh failed: ${(error as Error)?.name ?? "Error"}`);
		return;
	}

	const nextSignature = signatureOf(next);
	const first = signature === "";
	current = next;
	if (!force && nextSignature === signature) {
		return;
	}
	signature = nextSignature;

	if (first) {
		// One line at startup so a "no data" report can be diagnosed without guesswork.
		// Percentages and flags only — never file contents, paths, or session identifiers.
		streamDeck.logger.info(
			`first snapshot: limits=${next.hasLimitData} 5h=${next.fiveHour.usedPct ?? "--"} ` +
				`7d=${next.sevenDay.usedPct ?? "--"} stale=${next.stale} listeners=${listeners.size} ` +
				// Report whether the read worked and which candidate matched, not the resolved path —
				// that string carries the account name and the installed package identifier.
				`planRead=${lastPlanUsageFailure()} planSource=${planUsageSourceIndex()}`
		);
	}

	for (const listener of listeners) {
		try {
			listener(next);
		} catch (error) {
			streamDeck.logger.error(`listener failed: ${(error as Error)?.name ?? "Error"}`);
		}
	}
}

function start(): void {
	if (running) {
		return;
	}
	running = true;
	unwatch = watchState(() => {
		void refresh();
	});
	timer = setInterval(() => {
		void refresh();
	}, POLL_MS);
	timer.unref?.();
	void refresh(true);
}

function stop(): void {
	if (!running) {
		return;
	}
	running = false;
	if (timer) {
		clearInterval(timer);
		timer = undefined;
	}
	unwatch?.();
	unwatch = undefined;
}

/**
 * Subscribe to snapshot updates. The shared loop starts with the first subscriber and stops with
 * the last, so an unused plugin costs nothing.
 *
 * @returns an unsubscribe function.
 */
export function subscribe(listener: Listener): () => void {
	listeners.add(listener);
	start();
	// Hand the newcomer whatever we already have so it can paint immediately.
	if (current !== EMPTY_SNAPSHOT) {
		try {
			listener(current);
		} catch {
			/* a failing listener must not break subscription */
		}
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) {
			stop();
		}
	};
}

/** The most recently computed snapshot. */
export function currentSnapshot(): Snapshot {
	return current;
}

/** Force an immediate recompute and emit, regardless of whether anything changed. */
export async function forceRefresh(): Promise<void> {
	await refresh(true);
}

/** Drop caches and recompute — used when a directory override changes. */
export async function invalidate(): Promise<void> {
	resetTranscriptCache();
	resetPlanUsageCache();
	await refresh(true);
}
