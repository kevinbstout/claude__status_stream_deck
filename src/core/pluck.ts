/**
 * Tolerant nested-key probing.
 *
 * The statusline JSON shape changed repeatedly through 2026 and will change again, so nothing in
 * this plugin ever binds to a single path. Every read goes through a candidate list.
 */

/** Resolve a single dot-path against an object. Returns undefined for anything missing or null. */
function get(obj: unknown, dotPath: string): unknown {
	let cursor: unknown = obj;
	for (const segment of dotPath.split(".")) {
		if (cursor === null || cursor === undefined || typeof cursor !== "object") {
			return undefined;
		}
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	return cursor === null ? undefined : cursor;
}

/** Returns the value at the first candidate path that resolves to a non-null, non-undefined value. */
export function pluck<T>(obj: unknown, paths: string[]): T | undefined {
	for (const p of paths) {
		const value = get(obj, p);
		if (value !== undefined) {
			return value as T;
		}
	}
	return undefined;
}

/** As {@link pluck}, but only accepts finite numbers. Numeric strings are coerced. */
export function pluckNumber(obj: unknown, paths: string[]): number | undefined {
	for (const p of paths) {
		const value = get(obj, p);
		if (typeof value === "number" && Number.isFinite(value)) {
			return value;
		}
		if (typeof value === "string" && value.trim() !== "") {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) {
				return parsed;
			}
		}
	}
	return undefined;
}

/** As {@link pluck}, but only accepts non-empty strings. */
export function pluckString(obj: unknown, paths: string[]): string | undefined {
	for (const p of paths) {
		const value = get(obj, p);
		if (typeof value === "string" && value.trim() !== "") {
			return value;
		}
	}
	return undefined;
}

/**
 * Normalize a reset timestamp to an ISO string.
 *
 * Resets arrive as ISO strings *or* Unix epoch seconds. A number below 1e12 is seconds, not
 * milliseconds — the millisecond epoch passed 1e12 in 2001, so anything smaller cannot be one.
 */
export function normalizeReset(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		const ms = value < 1e12 ? value * 1000 : value;
		const date = new Date(ms);
		return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
	}
	if (typeof value === "string" && value.trim() !== "") {
		const asNumber = Number(value);
		if (Number.isFinite(asNumber) && /^\d+(\.\d+)?$/.test(value.trim())) {
			return normalizeReset(asNumber);
		}
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
	}
	return undefined;
}

/**
 * Rescale fractional percentages to 0..100.
 *
 * Some payload versions report `0.73` where others report `73`. Rescaling a lone value is unsafe —
 * a legitimate 0.5% would become 50%. So a value is only rescaled when it is in (0, 1] *and* at
 * least one sibling metric is also <= 1, which is the signal that the whole payload is fractional.
 *
 * @param value the percentage to normalize
 * @param siblings other percentages from the same payload, used only as corroboration
 */
export function normalizePct(value: number | undefined, siblings: (number | undefined)[]): number | undefined {
	if (value === undefined || !Number.isFinite(value)) {
		return undefined;
	}
	if (value > 0 && value <= 1) {
		const corroborated = siblings.some((s) => s !== undefined && Number.isFinite(s) && s > 0 && s <= 1);
		if (corroborated) {
			return clampPct(value * 100);
		}
	}
	return clampPct(value);
}

export function clampPct(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.min(100, Math.max(0, value));
}

// ---------------------------------------------------------------------------
// Candidate path lists. Shared conceptually with bin/statusline-hook.mjs, which
// duplicates them inline because it runs outside the plugin bundle.
// ---------------------------------------------------------------------------

export const FIVE_HOUR_PCT = [
	"rate_limits.five_hour.used_percentage",
	"rate_limits.session.used_percentage",
	"rate_limits.fiveHour.usedPercentage",
	"rate_limit.session.utilization",
	"rate_limit.session.used_percentage",
	"rate_limits.five_hour.utilization"
];

export const SEVEN_DAY_PCT = [
	"rate_limits.seven_day.used_percentage",
	"rate_limits.weekly.used_percentage",
	"rate_limits.sevenDay.usedPercentage",
	"rate_limit.weekly.utilization",
	"rate_limits.seven_day.utilization"
];

export const FIVE_HOUR_RESET = [
	"rate_limits.five_hour.resets_at",
	"rate_limits.session.resets_at",
	"rate_limits.five_hour.reset_time_iso",
	"rate_limit.session.resets_at"
];

export const SEVEN_DAY_RESET = [
	"rate_limits.seven_day.resets_at",
	"rate_limits.weekly.resets_at",
	"rate_limit.weekly.resets_at"
];

export const CONTEXT_PCT = ["context_window.used_percentage", "context_window.usedPercentage"];
export const SESSION_COST = ["cost.total_cost_usd", "cost.totalCostUsd"];
export const MODEL_NAME = ["model.display_name", "model.id"];
