/** Round a percentage for display. Returns `--` when there is nothing to show. */
export function pct(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) {
		return "--";
	}
	return `${Math.round(Math.min(100, Math.max(0, value)))}%`;
}

/**
 * Humanize a duration in milliseconds: `2h 14m`, `48m`, `< 1m`.
 * Anything at or below zero reads `now`.
 */
export function duration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) {
		return "--";
	}
	if (ms <= 0) {
		return "now";
	}
	const totalMinutes = Math.floor(ms / 60_000);
	if (totalMinutes < 1) {
		return "< 1m";
	}
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours === 0) {
		return `${minutes}m`;
	}
	if (hours >= 24) {
		const days = Math.floor(hours / 24);
		return `${days}d ${hours % 24}h`;
	}
	return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** Time remaining until a reset, phrased for the touch strip. */
export function resetIn(resetsAt: Date | undefined, now: Date = new Date()): string {
	if (!resetsAt) {
		return "";
	}
	return `resets ${duration(resetsAt.getTime() - now.getTime())}`;
}

/**
 * The reset countdown for a window, or an empty string when there is none worth showing.
 *
 * An inferred reset is marked `~` and shown only at `good` confidence. At `rough` confidence the
 * block almost certainly opened before the first sample, so the countdown would run late by hours —
 * still safe to clip projections against, but not a number to put on a dial.
 *
 * Structurally typed rather than taking a `Metric`, to keep this module free of upward imports.
 */
export function resetLine(
	metric: { resetsAt?: Date; resetsAtInferred?: boolean; resetConfidence?: "good" | "rough" },
	now: Date = new Date()
): string {
	if (!metric.resetsAt) {
		return "";
	}
	if (!metric.resetsAtInferred) {
		return resetIn(metric.resetsAt, now);
	}
	return metric.resetConfidence === "good" ? `~${resetIn(metric.resetsAt, now)}` : "";
}

/** USD, two decimals below $100 and none above, so the figure always fits the strip. */
export function currency(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) {
		return "--";
	}
	const abs = Math.abs(value);
	if (abs >= 100) {
		return `$${Math.round(value).toLocaleString("en-US")}`;
	}
	return `$${value.toFixed(2)}`;
}

/** API cost rate, formatted for the spend subtitle. */
export function perHour(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) {
		return "--";
	}
	return `${currency(value)}/hr`;
}

/**
 * Allowance burn rate: percentage points of the plan limit consumed per hour.
 * Sub-1%/hr keeps one decimal, because the difference between 0.2 and 0.8 matters over a week.
 */
export function pctPerHour(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) {
		return "--";
	}
	if (value > 0 && value < 1) {
		return `${value.toFixed(1)}%/hr`;
	}
	return `${Math.round(value)}%/hr`;
}

export type PaceBand = "ahead" | "on" | "behind";

/**
 * Band a pace ratio.
 *
 * Pace compares percent consumed against percent of the window elapsed. Above 1.3 the user is
 * burning faster than the clock and will hit the wall early; below 0.8 they have headroom.
 */
export function paceBand(pace: number | undefined): PaceBand | undefined {
	if (pace === undefined || !Number.isFinite(pace)) {
		return undefined;
	}
	if (pace > 1.3) {
		return "ahead";
	}
	if (pace < 0.8) {
		return "behind";
	}
	return "on";
}

/** Glyph for a pace band: ▲ burning fast, ● on pace, ▼ headroom. */
export function paceGlyph(pace: number | undefined): string {
	switch (paceBand(pace)) {
		case "ahead":
			return "▲";
		case "on":
			return "●";
		case "behind":
			return "▼";
		default:
			return "";
	}
}

/** Full pace line for the meter layout, empty when pace is unknowable. */
export function paceLabel(pace: number | undefined): string {
	const band = paceBand(pace);
	if (band === undefined) {
		return "";
	}
	const glyph = paceGlyph(pace);
	switch (band) {
		case "ahead":
			return `${glyph} fast`;
		case "behind":
			return `${glyph} easy`;
		default:
			return `${glyph} on pace`;
	}
}

/** Compact token count: `1.2M`, `48.3k`, `912`. */
export function tokens(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) {
		return "--";
	}
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(1)}M`;
	}
	if (value >= 1_000) {
		return `${(value / 1_000).toFixed(1)}k`;
	}
	return `${Math.round(value)}`;
}
