import { describe, expect, it } from "vitest";

import { BLOCK_MS } from "../src/core/blocks";
import type { UsageEntry } from "../src/core/jsonl";
import { STALE_AFTER_MS, bindingWindow, buildMetric, buildSnapshot } from "../src/core/snapshot";

const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

const NOW = new Date("2026-07-31T12:00:00.000Z");

let counter = 0;

function entry(iso: string, costUsd: number): UsageEntry {
	counter += 1;
	return {
		key: `k${counter}`,
		timestamp: new Date(iso),
		input: 1,
		output: 1,
		cacheWrite: 0,
		cacheRead: 0,
		costUsd,
		exact: false
	};
}

describe("buildMetric", () => {
	it("derives the window start from the reset time", () => {
		const metric = buildMetric({ usedPct: 50, resetsAt: "2026-07-31T14:00:00.000Z" }, BLOCK_MS, NOW);
		expect(metric.windowStart!.toISOString()).toBe("2026-07-31T09:00:00.000Z");
	});

	it("computes pace as consumed over elapsed", () => {
		// 3h of a 5h window elapsed (60%), 30% consumed → pace 0.5, comfortably behind the clock.
		const metric = buildMetric({ usedPct: 30, resetsAt: "2026-07-31T14:00:00.000Z" }, BLOCK_MS, NOW);
		expect(metric.pace).toBeCloseTo(0.5, 5);
	});

	it("has no pace without a reset time, because the window position is unknowable", () => {
		expect(buildMetric({ usedPct: 30 }, BLOCK_MS, NOW).pace).toBeUndefined();
	});

	it("ignores an unparseable reset time but keeps the percentage", () => {
		const metric = buildMetric({ usedPct: 30, resetsAt: "later" }, BLOCK_MS, NOW);
		expect(metric.usedPct).toBe(30);
		expect(metric.resetsAt).toBeUndefined();
	});

	it("is empty when the statusline reported no window", () => {
		expect(buildMetric(undefined, BLOCK_MS, NOW)).toEqual({});
	});
});

describe("allowance burn rate", () => {
	it("computes percentage points consumed per hour", () => {
		// Window opened 09:00, now 12:00 → 3h elapsed, 30% used → 10%/hr.
		const metric = buildMetric({ usedPct: 30, resetsAt: "2026-07-31T14:00:00.000Z" }, BLOCK_MS, NOW);
		expect(metric.ratePerHour).toBeCloseTo(10, 5);
	});

	it("projects when the cap is reached at the current rate", () => {
		// 10%/hr with 70% left → 7h away, which is past the 14:00 reset, so it is not a risk.
		const easy = buildMetric({ usedPct: 30, resetsAt: "2026-07-31T14:00:00.000Z" }, BLOCK_MS, NOW);
		expect(easy.exhaustsAt).toBeUndefined();

		// 3h elapsed, 75% used → 25%/hr, 25% left → 1h away, comfortably before the reset.
		const risky = buildMetric({ usedPct: 75, resetsAt: "2026-07-31T14:00:00.000Z" }, BLOCK_MS, NOW);
		expect(risky.exhaustsAt!.toISOString()).toBe("2026-07-31T13:00:00.000Z");
	});

	it("reports an already-exhausted allowance as capped now", () => {
		const metric = buildMetric({ usedPct: 100, resetsAt: "2026-07-31T14:00:00.000Z" }, BLOCK_MS, NOW);
		expect(metric.exhaustsAt!.getTime()).toBe(NOW.getTime());
	});

	it("claims no rate in the first few minutes, where the divisor is meaningless", () => {
		// Window opened one minute ago: a single request would imply a wild extrapolation.
		const metric = buildMetric(
			{ usedPct: 2, resetsAt: new Date(NOW.getTime() + BLOCK_MS - 60_000).toISOString() },
			BLOCK_MS,
			NOW
		);
		expect(metric.ratePerHour).toBeUndefined();
		expect(metric.exhaustsAt).toBeUndefined();
	});

	it("claims no rate at zero consumption", () => {
		const metric = buildMetric({ usedPct: 0, resetsAt: "2026-07-31T14:00:00.000Z" }, BLOCK_MS, NOW);
		expect(metric.ratePerHour).toBeUndefined();
	});

	it("has no rate without a reset time, since the window start is unknowable", () => {
		expect(buildMetric({ usedPct: 30 }, BLOCK_MS, NOW).ratePerHour).toBeUndefined();
	});
});

describe("Claude desktop plan usage as a source", () => {
	const plan = {
		latest: { at: NOW, fiveHourPct: 40, sevenDayPct: 12 },
		fiveHourRatePerHour: 20,
		sevenDayRatePerHour: 1
	};

	it("supplies limits with no statusline at all — the desktop-only user's whole case", () => {
		const snapshot = buildSnapshot({ state: undefined, plan, entries: [], exactness: "exact", now: NOW });
		expect(snapshot.hasLimitData).toBe(true);
		expect(snapshot.fiveHour.usedPct).toBe(40);
		expect(snapshot.sevenDay.usedPct).toBe(12);
		expect(snapshot.stale).toBe(false);
	});

	it("projects the cap from the measured rate, without needing a reset time", () => {
		const snapshot = buildSnapshot({ state: undefined, plan, entries: [], exactness: "exact", now: NOW });
		// 60% left at 20%/hr → three hours away.
		expect(snapshot.fiveHour.exhaustsAt!.toISOString()).toBe("2026-07-31T15:00:00.000Z");
		expect(snapshot.binding).toBe("five_hour");
	});

	it("prefers the fresher source when both report", () => {
		const staleState = {
			updatedAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
			fiveHour: { usedPct: 5, resetsAt: "2026-07-31T14:00:00.000Z" }
		};
		const snapshot = buildSnapshot({ state: staleState, plan, entries: [], exactness: "exact", now: NOW });
		// Desktop sampled just now; the hour-old statusline reading must not win.
		expect(snapshot.fiveHour.usedPct).toBe(40);
		// ...but its reset time is still the only one we have, so it is kept.
		expect(snapshot.fiveHour.resetsAt!.toISOString()).toBe("2026-07-31T14:00:00.000Z");
	});

	it("lets a fresher statusline win over older desktop samples", () => {
		const freshState = {
			updatedAt: NOW.toISOString(),
			fiveHour: { usedPct: 55, resetsAt: "2026-07-31T14:00:00.000Z" }
		};
		const olderPlan = { ...plan, latest: { ...plan.latest, at: new Date(NOW.getTime() - 10 * 60 * 1000) } };
		const snapshot = buildSnapshot({
			state: freshState,
			plan: olderPlan,
			entries: [],
			exactness: "exact",
			now: NOW
		});
		expect(snapshot.fiveHour.usedPct).toBe(55);
	});

	it("allows desktop's five-minute cadence before calling it stale", () => {
		const sampled = (minutesAgo: number) => ({
			...plan,
			latest: { ...plan.latest, at: new Date(NOW.getTime() - minutesAgo * 60_000) }
		});
		// A 5-minute-old sample is simply the normal cadence, not staleness.
		expect(buildSnapshot({ state: undefined, plan: sampled(6), entries: [], exactness: "exact", now: NOW }).stale).toBe(false);
		expect(buildSnapshot({ state: undefined, plan: sampled(20), entries: [], exactness: "exact", now: NOW }).stale).toBe(true);
	});

	it("does not project a cap when the rate is zero", () => {
		const idle = { ...plan, fiveHourRatePerHour: 0, sevenDayRatePerHour: 0 };
		const snapshot = buildSnapshot({ state: undefined, plan: idle, entries: [], exactness: "exact", now: NOW });
		expect(snapshot.fiveHour.ratePerHour).toBe(0);
		expect(snapshot.fiveHour.exhaustsAt).toBeUndefined();
		expect(snapshot.binding).toBeUndefined();
	});
});

describe("bindingWindow", () => {
	it("picks whichever window runs out first when both are at risk", () => {
		// Session: 3h elapsed, 75% used → 25%/hr, 25% left → capped in 1h.
		const five = buildMetric({ usedPct: 75, resetsAt: "2026-07-31T14:00:00.000Z" }, BLOCK_MS, NOW);
		// Weekly: 96h elapsed of 168, 90% used → 0.9375%/hr, 10% left → capped in ~10h40m.
		const seven = buildMetric({ usedPct: 90, resetsAt: "2026-08-03T12:00:00.000Z" }, SEVEN_DAY_MS, NOW);

		expect(five.exhaustsAt!.toISOString()).toBe("2026-07-31T13:00:00.000Z");
		expect(seven.exhaustsAt!.toISOString()).toBe("2026-07-31T22:40:00.000Z");
		// The session limit bites first, so that is the one worth putting on the dial.
		expect(bindingWindow(five, seven)).toBe("five_hour");
	});

	it("names the weekly window when it is the one that bites first", () => {
		// Session is relaxed enough to clear its window; the weekly cap is not.
		const five = buildMetric({ usedPct: 30, resetsAt: "2026-07-31T14:00:00.000Z" }, BLOCK_MS, NOW);
		const seven = buildMetric({ usedPct: 90, resetsAt: "2026-08-03T12:00:00.000Z" }, SEVEN_DAY_MS, NOW);
		expect(five.exhaustsAt).toBeUndefined();
		expect(bindingWindow(five, seven)).toBe("seven_day");
	});

	it("does not flag a window that resets before the cap would be reached", () => {
		// 99% used but the weekly window resets in an hour — the allowance refills first.
		const seven = buildMetric(
			{ usedPct: 99, resetsAt: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString() },
			SEVEN_DAY_MS,
			NOW
		);
		expect(seven.exhaustsAt).toBeUndefined();
	});

	it("falls to whichever window is at risk when only one is", () => {
		const atRisk = buildMetric({ usedPct: 75, resetsAt: "2026-07-31T14:00:00.000Z" }, BLOCK_MS, NOW);
		expect(bindingWindow(atRisk, {})).toBe("five_hour");
		expect(bindingWindow({}, atRisk)).toBe("seven_day");
	});

	it("names no binding window when neither is on course to hit its cap", () => {
		const relaxed = buildMetric({ usedPct: 30, resetsAt: "2026-07-31T14:00:00.000Z" }, BLOCK_MS, NOW);
		expect(bindingWindow(relaxed, relaxed)).toBeUndefined();
		expect(bindingWindow({}, {})).toBeUndefined();
	});
});

describe("buildSnapshot", () => {
	it("never fabricates limits from token counts", () => {
		const snapshot = buildSnapshot({
			state: undefined,
			entries: [entry("2026-07-31T11:00:00.000Z", 5)],
			exactness: "estimated",
			now: NOW
		});
		expect(snapshot.hasLimitData).toBe(false);
		expect(snapshot.fiveHour.usedPct).toBeUndefined();
		expect(snapshot.sevenDay.usedPct).toBeUndefined();
		// Spend keeps working with no statusline at all.
		expect(snapshot.spend.today).toBeCloseTo(5);
	});

	it("marks data stale past five minutes", () => {
		const fresh = buildSnapshot({
			state: { updatedAt: new Date(NOW.getTime() - 1_000).toISOString(), fiveHour: { usedPct: 10 } },
			entries: [],
			exactness: "exact",
			now: NOW
		});
		const stale = buildSnapshot({
			state: { updatedAt: new Date(NOW.getTime() - STALE_AFTER_MS - 1_000).toISOString(), fiveHour: { usedPct: 10 } },
			entries: [],
			exactness: "exact",
			now: NOW
		});
		expect(fresh.stale).toBe(false);
		expect(stale.stale).toBe(true);
		// A stale reading still reports hasLimitData — the UI dims it rather than blanking it.
		expect(stale.hasLimitData).toBe(true);
	});

	it("rolls spend up by day, week and month", () => {
		const snapshot = buildSnapshot({
			state: undefined,
			entries: [
				entry("2026-07-31T11:00:00.000Z", 1), // today
				entry("2026-07-28T11:00:00.000Z", 2), // this week
				entry("2026-07-02T11:00:00.000Z", 4), // this month only
				entry("2026-06-15T11:00:00.000Z", 8) // outside every window
			],
			exactness: "estimated",
			now: NOW
		});
		expect(snapshot.spend.today).toBeCloseTo(1);
		expect(snapshot.spend.week).toBeCloseTo(3);
		expect(snapshot.spend.month).toBeCloseTo(7);
	});

	it("computes burn rate from the active block only", () => {
		// Block opens at 10:00, now is 12:00 → two hours elapsed, $4 spent.
		const snapshot = buildSnapshot({
			state: undefined,
			entries: [entry("2026-07-31T10:30:00.000Z", 4)],
			exactness: "estimated",
			now: NOW
		});
		expect(snapshot.spend.activeBlock).toBeCloseTo(4);
		expect(snapshot.spend.burnPerHour).toBeCloseTo(2);
	});

	it("reports a zero burn rate when no block is active", () => {
		const snapshot = buildSnapshot({
			state: undefined,
			entries: [entry("2026-07-30T10:30:00.000Z", 4)],
			exactness: "estimated",
			now: NOW
		});
		expect(snapshot.spend.activeBlock).toBe(0);
		expect(snapshot.spend.burnPerHour).toBe(0);
	});

	it("survives an unparseable updatedAt", () => {
		const snapshot = buildSnapshot({
			state: { updatedAt: "nonsense", fiveHour: { usedPct: 10 } },
			entries: [],
			exactness: "exact",
			now: NOW
		});
		expect(snapshot.stale).toBe(true);
		expect(snapshot.fiveHour.usedPct).toBe(10);
	});
});
