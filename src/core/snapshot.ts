import { BLOCK_MS, activeBlock, buildBlocks } from "./blocks";
import { type UsageEntry, readTranscripts } from "./jsonl";
import { type PlanUsage, type ResetConfidence, readPlanUsage } from "./plan-usage";
import { type LimitState, readState } from "./state";

export const STALE_AFTER_MS = 5 * 60 * 1000;
/** Claude desktop samples every five minutes, so it needs a looser staleness threshold. */
export const PLAN_STALE_AFTER_MS = 12 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;
/** Minimum elapsed time before a burn rate is meaningful rather than an artefact of a tiny divisor. */
const MIN_RATE_HOURS = 5 / 60;

export type Metric = {
	/** 0..100. Undefined when the statusline never reported this window. */
	usedPct?: number;
	resetsAt?: Date;
	windowStart?: Date;
	/** usedPct / elapsedPct. Undefined when the window position is unknowable. */
	pace?: number;
	/** Percentage points of the allowance consumed per hour so far in this window. */
	ratePerHour?: number;
	/**
	 * True when `resetsAt` was inferred from sample history rather than reported by the statusline.
	 * An inferred reset runs late, never early, and must never be presented as fact.
	 */
	resetsAtInferred?: boolean;
	/** How far the inferred reset can be trusted. Absent when `resetsAt` is authoritative. */
	resetConfidence?: ResetConfidence;
	/**
	 * When the allowance runs out if consumption continues at `ratePerHour`.
	 * Only set when that lands before the window resets — otherwise the cap is not in reach.
	 */
	exhaustsAt?: Date;
};

export type Snapshot = {
	updatedAt: Date;
	/** True when the statusline data is older than five minutes. */
	stale: boolean;
	/** False when the statusline never produced rate limits — limit displays must show `--`. */
	hasLimitData: boolean;
	model?: string;
	fiveHour: Metric;
	sevenDay: Metric;
	/**
	 * Which allowance window runs out first at the current rate — the one that will actually stop
	 * you. Undefined when neither is on course to hit its cap before it resets.
	 */
	binding?: "five_hour" | "seven_day";
	context: { usedPct?: number };
	/**
	 * API list-price value of local token usage. **Not** subscription spend and unrelated to the
	 * Pro/Max allowance above — subscribers pay a flat fee and never see this as a bill. It is what
	 * these tokens would have cost on pay-as-you-go, which is why every surface labels it "API".
	 */
	spend: {
		today: number;
		week: number;
		month: number;
		activeBlock: number;
		burnPerHour: number;
		exactness: "exact" | "estimated";
	};
};

export const EMPTY_SNAPSHOT: Snapshot = {
	updatedAt: new Date(0),
	stale: true,
	hasLimitData: false,
	fiveHour: {},
	sevenDay: {},
	context: {},
	spend: { today: 0, week: 0, month: 0, activeBlock: 0, burnPerHour: 0, exactness: "estimated" }
};

function startOfDay(now: Date): Date {
	const d = new Date(now.getTime());
	d.setHours(0, 0, 0, 0);
	return d;
}

function startOfMonth(now: Date): Date {
	const d = new Date(now.getTime());
	d.setDate(1);
	d.setHours(0, 0, 0, 0);
	return d;
}

function sumSince(entries: UsageEntry[], since: Date): number {
	const cutoff = since.getTime();
	let total = 0;
	for (const entry of entries) {
		if (entry.timestamp.getTime() >= cutoff) {
			total += entry.costUsd;
		}
	}
	return total;
}

/**
 * Build a metric from a state-file window.
 *
 * `windowStart` is derived as `resetsAt - windowLength`, which is the only way to locate the
 * rolling window locally. Without `resetsAt` there is no elapsed fraction and therefore no pace.
 */
export function buildMetric(
	window: { usedPct: number; resetsAt?: string } | undefined,
	windowLengthMs: number,
	now: Date
): Metric {
	if (!window) {
		return {};
	}
	const metric: Metric = { usedPct: Math.min(100, Math.max(0, window.usedPct)) };
	if (!window.resetsAt) {
		return metric;
	}
	const resetsAt = new Date(window.resetsAt);
	if (Number.isNaN(resetsAt.getTime())) {
		return metric;
	}
	metric.resetsAt = resetsAt;
	metric.windowStart = new Date(resetsAt.getTime() - windowLengthMs);

	const elapsedMs = now.getTime() - metric.windowStart.getTime();
	const elapsedPct = (elapsedMs / windowLengthMs) * 100;
	if (elapsedPct <= 0 || elapsedPct > 100) {
		return metric;
	}
	metric.pace = metric.usedPct! / Math.max(elapsedPct, 1);

	// Burn rate against the allowance itself, and the projection that follows from it. Below a few
	// minutes elapsed the divisor is too small to mean anything — a single early request would
	// imply an absurd rate — so we simply do not claim a rate yet.
	const elapsedHours = elapsedMs / 3_600_000;
	if (elapsedHours < MIN_RATE_HOURS || metric.usedPct! <= 0) {
		return metric;
	}
	metric.ratePerHour = metric.usedPct! / elapsedHours;

	const remainingPct = 100 - metric.usedPct!;
	if (remainingPct <= 0) {
		metric.exhaustsAt = now;
		return metric;
	}
	const exhaustsAt = new Date(now.getTime() + (remainingPct / metric.ratePerHour) * 3_600_000);
	// Only a projection that lands before the reset is a real risk; past that the window refills.
	if (exhaustsAt.getTime() < resetsAt.getTime()) {
		metric.exhaustsAt = exhaustsAt;
	}
	return metric;
}

/** Whichever window is projected to hit its cap first — the one that will actually stop you. */
export function bindingWindow(fiveHour: Metric, sevenDay: Metric): "five_hour" | "seven_day" | undefined {
	const five = fiveHour.exhaustsAt?.getTime();
	const seven = sevenDay.exhaustsAt?.getTime();
	if (five === undefined && seven === undefined) {
		return undefined;
	}
	if (seven === undefined) {
		return "five_hour";
	}
	if (five === undefined) {
		return "seven_day";
	}
	return five <= seven ? "five_hour" : "seven_day";
}

/**
 * Overlay a measured burn rate onto a metric, replacing the rate derived from window position.
 *
 * A rate measured across real samples beats one extrapolated from a single reading, and it needs no
 * reset time — remaining allowance divided by observed rate is the projection. Where a reset time
 * *is* known, a projection landing after it is dropped: the window refills first.
 */
function applyMeasuredRate(metric: Metric, ratePerHour: number | undefined, now: Date): Metric {
	if (ratePerHour === undefined || metric.usedPct === undefined) {
		return metric;
	}
	const merged: Metric = { ...metric, ratePerHour };
	delete merged.exhaustsAt;

	const remainingPct = 100 - metric.usedPct;
	if (remainingPct <= 0) {
		merged.exhaustsAt = now;
		return merged;
	}
	if (ratePerHour <= 0) {
		return merged;
	}
	const exhaustsAt = new Date(now.getTime() + (remainingPct / ratePerHour) * 3_600_000);
	if (merged.resetsAt === undefined || exhaustsAt.getTime() < merged.resetsAt.getTime()) {
		merged.exhaustsAt = exhaustsAt;
	}
	return merged;
}

export type SnapshotInputs = {
	state: LimitState | undefined;
	/** Claude desktop's own plan usage record, when present. */
	plan?: PlanUsage | undefined;
	entries: UsageEntry[];
	exactness: "exact" | "estimated";
	now?: Date;
};

/**
 * Merge every local source into the single object every action reads.
 *
 * Two sources report the same plan allowance, and they are complementary rather than redundant:
 *
 *  - **Claude desktop's `plan-usage-history.json`** covers the whole plan — desktop, claude.ai and
 *    Claude Code all draw on one allowance — and keeps sampling every five minutes while the
 *    desktop app is open. For anyone who does not live in Claude Code, this is the only source that
 *    reflects their real usage.
 *  - **The Claude Code statusline** reports the same percentages but only while Claude Code is
 *    running, and adds what desktop does not record: window reset times, context usage, model.
 *
 * Percentages come from whichever source is fresher. Reset times, context and model come from the
 * statusline whenever it has them. Neither is ever derived from token counts — the plan's true
 * denominator is not knowable locally, and a confidently wrong number is worse than no number.
 */
export function buildSnapshot({ state, plan, entries, exactness, now = new Date() }: SnapshotInputs): Snapshot {
	const stateAt = state?.updatedAt ? new Date(state.updatedAt) : new Date(0);
	const validStateAt = Number.isNaN(stateAt.getTime()) ? new Date(0) : stateAt;
	const planAt = plan?.latest.at ?? new Date(0);
	const validUpdatedAt = planAt.getTime() > validStateAt.getTime() ? planAt : validStateAt;

	// The statusline carries reset times, so build from it first and let the fresher source's
	// percentages win — keeping the reset countdown even when desktop supplies the number.
	const planIsFresher = planAt.getTime() > validStateAt.getTime();
	const fiveHourSource =
		planIsFresher && plan
			? { usedPct: plan.latest.fiveHourPct, resetsAt: state?.fiveHour?.resetsAt }
			: state?.fiveHour;

	// Fall back to the reset inferred from sample history, but only when the statusline reported
	// none — a statusline reset is authoritative and always wins. Applying it before buildMetric
	// means the window start, pace, and clipping are all derived from one consistent reset time.
	const inferred = plan?.fiveHourResetsAt;
	const useInferred = fiveHourSource !== undefined && fiveHourSource.resetsAt === undefined && inferred !== undefined;

	let fiveHour = buildMetric(
		useInferred ? { ...fiveHourSource, resetsAt: inferred.toISOString() } : fiveHourSource,
		BLOCK_MS,
		now
	);
	if (useInferred) {
		fiveHour.resetsAtInferred = true;
		fiveHour.resetConfidence = plan?.fiveHourResetConfidence;
	}

	let sevenDay = buildMetric(
		planIsFresher && plan
			? { usedPct: plan.latest.sevenDayPct, resetsAt: state?.sevenDay?.resetsAt }
			: state?.sevenDay,
		SEVEN_DAY_MS,
		now
	);

	if (plan) {
		fiveHour = applyMeasuredRate(fiveHour, plan.fiveHourRatePerHour, now);
		sevenDay = applyMeasuredRate(sevenDay, plan.sevenDayRatePerHour, now);
	}

	const blocks = buildBlocks(entries, now);
	const current = activeBlock(blocks);
	const blockCost = current?.costUsd ?? 0;

	let burnPerHour = 0;
	if (current) {
		const elapsedHours = Math.max((now.getTime() - current.start.getTime()) / 3_600_000, 1 / 60);
		burnPerHour = blockCost / elapsedHours;
	}

	const dayStart = startOfDay(now);
	const weekStart = new Date(dayStart.getTime() - 6 * 24 * 60 * 60 * 1000);

	// Desktop only samples every five minutes, so judging it by the statusline's threshold would
	// flash "stale" in the gap before each new sample. Allow two intervals plus slack.
	const staleAfter = planIsFresher ? PLAN_STALE_AFTER_MS : STALE_AFTER_MS;

	return {
		updatedAt: validUpdatedAt,
		stale: now.getTime() - validUpdatedAt.getTime() > staleAfter,
		hasLimitData: fiveHour.usedPct !== undefined || sevenDay.usedPct !== undefined,
		model: state?.model,
		fiveHour,
		sevenDay,
		binding: bindingWindow(fiveHour, sevenDay),
		context: { usedPct: state?.contextUsedPct },
		spend: {
			today: sumSince(entries, dayStart),
			week: sumSince(entries, weekStart),
			month: sumSince(entries, startOfMonth(now)),
			activeBlock: blockCost,
			burnPerHour,
			exactness
		}
	};
}

/** Read every source and build the current snapshot. */
export async function computeSnapshot(now: Date = new Date()): Promise<Snapshot> {
	const state = readState();
	const plan = readPlanUsage();
	const { entries, exactness } = await readTranscripts();
	return buildSnapshot({ state, plan, entries, exactness, now });
}
