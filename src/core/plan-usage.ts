import fs from "node:fs";

import { planUsageFile } from "./paths";

/**
 * Reader for Claude desktop's own record of plan usage.
 *
 * `plan-usage-history.json` is written by the Claude desktop app roughly every five minutes and
 * holds the utilisation of both allowance windows:
 *
 *   { "version": 2, "samples": [ { "t": 1784639187219, "org": "...", "u": { "fh": 20, "sd": 2 } } ] }
 *
 *   t   epoch milliseconds
 *   fh  five-hour window, integer percent 0..100
 *   sd  seven-day window, integer percent 0..100
 *
 * This matters more than it looks. The allowance is shared across Claude desktop, claude.ai and
 * Claude Code, so this file reflects *all* of a subscriber's usage — whereas the Claude Code
 * statusline only reports while Claude Code itself is running. For anyone who works mainly in the
 * desktop or web apps, this is the only local source that tells the truth.
 *
 * It is a plain read of a file the official app already wrote. No network call, no credentials, no
 * OAuth token — the same posture as reading Claude Code's transcripts.
 */

export type PlanSample = {
	at: Date;
	fiveHourPct: number;
	sevenDayPct: number;
	/**
	 * Which account the sample belongs to. Only used to keep measurements within one account —
	 * never stored, logged, or displayed.
	 */
	org?: string;
};

/**
 * How much to trust an inferred reset time.
 *
 * `good` — the block was observed from its start; expect accuracy within about ten minutes.
 * `rough` — the first reading was already large, so usage almost certainly began before the first
 *           sample and the true reset is earlier than inferred. Safe to clip against, not to display.
 */
export type ResetConfidence = "good" | "rough";

export type PlanUsage = {
	latest: PlanSample;
	/** Percentage points per hour, measured from recent samples. Undefined when not yet knowable. */
	fiveHourRatePerHour?: number;
	sevenDayRatePerHour?: number;
	/** Inferred end of the current 5-hour block. Undefined when it cannot be established safely. */
	fiveHourResetsAt?: Date;
	fiveHourResetConfidence?: ResetConfidence;
};

/** How far back to look when measuring the current burn rate. */
const RATE_WINDOW_MS = 90 * 60 * 1000;
/** Minimum span between first and last sample before a rate means anything. */
const MIN_SPAN_MS = 15 * 60 * 1000;
/** Length of the rolling session window. */
const BLOCK_MS = 5 * 60 * 60 * 1000;
/**
 * Largest sampling gap tolerated inside a block, at a five-minute cadence.
 *
 * A wider gap means the desktop app was closed, and two separate blocks can then look like one
 * continuous run — the only way an inference can land *earlier* than the true reset.
 */
const MAX_BLOCK_GAP_MS = 15 * 60 * 1000;
/**
 * A first reading at or above this means usage accumulated before we ever sampled it, so the block
 * began earlier than it appears and the inferred reset will run late.
 */
const ROUGH_START_PCT = 3;

type Cache = { mtimeMs: number; size: number; value: PlanUsage | undefined };
let cache: Cache | undefined;

function isPct(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function parse(raw: string): PlanUsage | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return undefined;
	}
	const samplesRaw = (parsed as Record<string, unknown>).samples;
	if (!Array.isArray(samplesRaw)) {
		return undefined;
	}

	const samples: PlanSample[] = [];
	for (const entry of samplesRaw) {
		if (typeof entry !== "object" || entry === null) {
			continue;
		}
		const e = entry as Record<string, unknown>;
		const u = e.u as Record<string, unknown> | undefined;
		if (typeof e.t !== "number" || !Number.isFinite(e.t) || typeof u !== "object" || u === null) {
			continue;
		}
		if (!isPct(u.fh) || !isPct(u.sd)) {
			continue;
		}
		samples.push({
			at: new Date(e.t),
			fiveHourPct: u.fh,
			sevenDayPct: u.sd,
			org: typeof e.org === "string" ? e.org : undefined
		});
	}
	if (samples.length === 0) {
		return undefined;
	}

	samples.sort((a, b) => a.at.getTime() - b.at.getTime());
	const latest = samples[samples.length - 1]!;

	// Signing into a different Claude account leaves both accounts' samples interleaved in one
	// file. Measuring a rate across that boundary compares unrelated allowances and produces a
	// meaningless number, so scope the measurement to the account the latest sample belongs to.
	const scoped = latest.org === undefined ? samples : samples.filter((s) => s.org === latest.org);

	const reset = inferFiveHourReset(scoped);

	return {
		latest,
		fiveHourRatePerHour: measureRate(scoped, (s) => s.fiveHourPct),
		sevenDayRatePerHour: measureRate(scoped, (s) => s.sevenDayPct),
		fiveHourResetsAt: reset?.at,
		fiveHourResetConfidence: reset?.confidence
	};
}

/**
 * Measure how fast an allowance is being consumed, in percentage points per hour.
 *
 * This is a genuine measurement across a span of real samples rather than an extrapolation from a
 * single reading, which is what makes the projection trustworthy. A flat or falling series returns
 * zero: both windows roll, so utilisation decays when you stop working, and a negative "burn rate"
 * would be nonsense.
 */
export function measureRate(samples: PlanSample[], pick: (s: PlanSample) => number): number | undefined {
	if (samples.length < 2) {
		return undefined;
	}
	const latest = samples[samples.length - 1]!;
	const cutoff = latest.at.getTime() - RATE_WINDOW_MS;
	const recent = samples.filter((s) => s.at.getTime() >= cutoff);
	if (recent.length < 2) {
		return undefined;
	}
	const first = recent[0]!;
	const spanMs = latest.at.getTime() - first.at.getTime();
	if (spanMs < MIN_SPAN_MS) {
		return undefined;
	}
	const delta = pick(latest) - pick(first);
	if (delta <= 0) {
		return 0;
	}
	return delta / (spanMs / 3_600_000);
}

/**
 * Why the last read produced nothing, for the diagnostic and the log.
 * Never contains file contents — only which step failed.
 */
export type PlanUsageFailure = "ok" | "not-found" | "unreadable" | "unparseable" | `stat-${string}` | `read-${string}`;

let lastFailure: PlanUsageFailure = "ok";

export function lastPlanUsageFailure(): PlanUsageFailure {
	return lastFailure;
}

/**
 * Infer when the current 5-hour block ends.
 *
 * The window hard-resets rather than decaying: across eleven days of real samples, twelve of
 * thirteen decreases dropped straight to zero in a single five-minute step. So the block can be
 * located by walking back through the current run of non-zero readings, and it ends five hours
 * after it began.
 *
 * The inference is deliberately one-sided. The first non-zero sample is at or after the true start
 * — usage below half a percent reads as zero — so the inferred reset is at or *after* the true one.
 * It runs late, never early, which is the safe direction for both clipping and display.
 *
 * @param samples ascending, already scoped to one account
 * @returns the inferred reset, or undefined when it cannot be established safely
 */
export function inferFiveHourReset(
	samples: PlanSample[],
	now: Date = new Date()
): { at: Date; confidence: ResetConfidence } | undefined {
	if (samples.length === 0) {
		return undefined;
	}
	const latest = samples[samples.length - 1]!;
	// No active block: nothing is running, so there is nothing to reset.
	if (latest.fiveHourPct <= 0) {
		return undefined;
	}

	// Walk back through the contiguous run of non-zero readings to find where the block opened.
	let start = samples.length - 1;
	for (let i = samples.length - 1; i > 0; i--) {
		const previous = samples[i - 1]!;
		if (previous.fiveHourPct <= 0) {
			break;
		}
		// A gap this wide means the desktop app was closed, and two blocks either side of it are
		// indistinguishable from one. Refuse rather than risk anchoring to the older one.
		if (samples[i]!.at.getTime() - previous.at.getTime() > MAX_BLOCK_GAP_MS) {
			return undefined;
		}
		start = i - 1;
	}

	const at = new Date(samples[start]!.at.getTime() + BLOCK_MS);
	// A reset in the past contradicts an active block, so the anchor must be wrong.
	if (at.getTime() <= now.getTime()) {
		return undefined;
	}

	return {
		at,
		confidence: samples[start]!.fiveHourPct >= ROUGH_START_PCT ? "rough" : "good"
	};
}

/** Read Claude desktop's plan usage history, cached by file mtime and size. */
export function readPlanUsage(): PlanUsage | undefined {
	const file = planUsageFile();
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch (error) {
		// Record the real errno: a missing file and a permissions or sharing failure need very
		// different advice, and collapsing them into "not found" sends people hunting the wrong bug.
		const code = (error as NodeJS.ErrnoException)?.code;
		lastFailure = code === "ENOENT" ? "not-found" : `stat-${code ?? "unknown"}`;
		cache = undefined;
		return undefined;
	}
	if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
		return cache.value;
	}
	let value: PlanUsage | undefined;
	try {
		value = parse(fs.readFileSync(file, "utf8"));
		lastFailure = value === undefined ? "unparseable" : "ok";
	} catch (error) {
		// Claude desktop rewrites this file while we read it, so a transient lock is expected on
		// Windows. Do not cache a failed read — the next poll, five seconds later, will succeed.
		lastFailure = `read-${(error as NodeJS.ErrnoException)?.code ?? "unknown"}`;
		return cache?.value;
	}
	cache = { mtimeMs: stat.mtimeMs, size: stat.size, value };
	return value;
}

/** Drop the cache. Used when the desktop directory override changes. */
export function resetPlanUsageCache(): void {
	cache = undefined;
}
