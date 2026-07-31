import fs from "node:fs";

import { APP_DIR, STATE_FILE } from "./paths";

export type LimitState = {
	/** ISO timestamp of the last write by the statusline shim. */
	updatedAt: string;
	model?: string;
	contextUsedPct?: number;
	sessionCostUsd?: number;
	fiveHour?: { usedPct: number; resetsAt?: string };
	sevenDay?: { usedPct: number; resetsAt?: string };
};

const DEBOUNCE_MS = 250;
const SAFETY_REREAD_MS = 10_000;

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * Read the state file written by the statusline shim.
 *
 * The file may be missing, empty, mid-write or truncated. Every failure path returns undefined —
 * this must never throw into the action layer.
 */
export function readState(): LimitState | undefined {
	try {
		const raw = fs.readFileSync(STATE_FILE, "utf8");
		if (raw.trim() === "") {
			return undefined;
		}
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) {
			return undefined;
		}
		const obj = parsed as Record<string, unknown>;
		if (typeof obj.updatedAt !== "string") {
			return undefined;
		}

		const state: LimitState = { updatedAt: obj.updatedAt };
		if (typeof obj.model === "string") {
			state.model = obj.model;
		}
		if (isFiniteNumber(obj.contextUsedPct)) {
			state.contextUsedPct = obj.contextUsedPct;
		}
		if (isFiniteNumber(obj.sessionCostUsd)) {
			state.sessionCostUsd = obj.sessionCostUsd;
		}
		state.fiveHour = readWindow(obj.fiveHour);
		state.sevenDay = readWindow(obj.sevenDay);
		return state;
	} catch {
		return undefined;
	}
}

function readWindow(value: unknown): { usedPct: number; resetsAt?: string } | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	const obj = value as Record<string, unknown>;
	if (!isFiniteNumber(obj.usedPct)) {
		return undefined;
	}
	const window: { usedPct: number; resetsAt?: string } = { usedPct: obj.usedPct };
	if (typeof obj.resetsAt === "string") {
		window.resetsAt = obj.resetsAt;
	}
	return window;
}

/**
 * Watch the state file for changes.
 *
 * Watches the directory rather than the file, because the shim writes atomically via rename — a
 * file watch would be left pointing at the replaced inode. A 10s safety re-read covers the Windows
 * configurations where `fs.watch` silently stops delivering events.
 *
 * @returns a function that stops the watcher.
 */
export function watchState(onChange: () => void): () => void {
	let debounce: NodeJS.Timeout | undefined;
	let watcher: fs.FSWatcher | undefined;

	const fire = (): void => {
		if (debounce) {
			clearTimeout(debounce);
		}
		debounce = setTimeout(onChange, DEBOUNCE_MS);
	};

	const attach = (): void => {
		try {
			fs.mkdirSync(APP_DIR, { recursive: true });
			watcher = fs.watch(APP_DIR, { persistent: false }, () => fire());
			// A dropped watch surfaces as an error event; the safety interval carries us until then.
			watcher.on("error", () => {
				watcher?.close();
				watcher = undefined;
			});
		} catch {
			watcher = undefined;
		}
	};

	attach();
	const safety = setInterval(() => {
		if (!watcher) {
			attach();
		}
		onChange();
	}, SAFETY_REREAD_MS);
	safety.unref?.();

	return () => {
		clearInterval(safety);
		if (debounce) {
			clearTimeout(debounce);
		}
		watcher?.close();
		watcher = undefined;
	};
}
