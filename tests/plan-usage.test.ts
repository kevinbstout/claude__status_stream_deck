import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { setDesktopDirOverride } from "../src/core/paths";
import { type PlanSample, measureRate, readPlanUsage, resetPlanUsageCache } from "../src/core/plan-usage";

const T0 = new Date("2026-07-31T12:00:00.000Z").getTime();

/** Build a sample series at five-minute intervals, matching Claude desktop's real cadence. */
function series(values: [fh: number, sd: number][], stepMinutes = 5): PlanSample[] {
	return values.map(([fh, sd], i) => ({
		at: new Date(T0 + i * stepMinutes * 60_000),
		fiveHourPct: fh,
		sevenDayPct: sd
	}));
}

const fh = (s: PlanSample): number => s.fiveHourPct;

const dirs: string[] = [];

/** Write a history file in Claude desktop's real on-disk shape and point the reader at it. */
function withHistory(body: unknown): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aum-plan-"));
	dirs.push(dir);
	fs.writeFileSync(path.join(dir, "plan-usage-history.json"), JSON.stringify(body), "utf8");
	resetPlanUsageCache();
	setDesktopDirOverride(dir);
}

function sample(minutesAgo: number, fhPct: number, sdPct: number, org = "org-a"): unknown {
	return { t: T0 - minutesAgo * 60_000, org, u: { fh: fhPct, sd: sdPct } };
}

afterEach(() => {
	setDesktopDirOverride(undefined);
	resetPlanUsageCache();
	for (const dir of dirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("readPlanUsage", () => {
	it("parses Claude desktop's real file shape", () => {
		withHistory({ version: 2, samples: [sample(10, 20, 2), sample(5, 22, 2), sample(0, 25, 3)] });
		const usage = readPlanUsage()!;
		expect(usage.latest.fiveHourPct).toBe(25);
		expect(usage.latest.sevenDayPct).toBe(3);
	});

	it("returns nothing when the file is absent", () => {
		setDesktopDirOverride(path.join(os.tmpdir(), "aum-plan-does-not-exist"));
		resetPlanUsageCache();
		expect(readPlanUsage()).toBeUndefined();
	});

	it("returns nothing rather than throwing on malformed JSON", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aum-plan-"));
		dirs.push(dir);
		fs.writeFileSync(path.join(dir, "plan-usage-history.json"), "{not json", "utf8");
		resetPlanUsageCache();
		setDesktopDirOverride(dir);
		expect(readPlanUsage()).toBeUndefined();
	});

	it("skips entries with missing or out-of-range values", () => {
		withHistory({
			version: 2,
			samples: [
				sample(30, 10, 1),
				{ t: T0 - 20 * 60_000, org: "org-a" }, // no usage object
				{ t: T0 - 15 * 60_000, org: "org-a", u: { fh: 400, sd: 2 } }, // out of range
				sample(0, 20, 2)
			]
		});
		const usage = readPlanUsage()!;
		expect(usage.latest.fiveHourPct).toBe(20);
	});

	it("does not measure a rate across an account switch", () => {
		// A different account's history sits in the same file. Comparing across the boundary would
		// subtract one plan's utilisation from another's and report nonsense.
		withHistory({
			version: 2,
			samples: [
				sample(60, 90, 40, "org-old"),
				sample(45, 95, 45, "org-old"),
				sample(30, 5, 1, "org-new"),
				sample(0, 11, 1, "org-new")
			]
		});
		const usage = readPlanUsage()!;
		expect(usage.latest.fiveHourPct).toBe(11);
		// 5% → 11% over 30 minutes within org-new = 12%/hr, untouched by org-old's figures.
		expect(usage.fiveHourRatePerHour).toBeCloseTo(12, 5);
	});
});

describe("measureRate", () => {
	it("measures percentage points per hour across the sampled span", () => {
		// 20% → 26% over six 5-minute steps = 30 minutes → 12%/hr.
		const samples = series([
			[20, 2],
			[21, 2],
			[22, 2],
			[23, 2],
			[24, 2],
			[25, 2],
			[26, 2]
		]);
		expect(measureRate(samples, fh)).toBeCloseTo(12, 5);
	});

	it("returns zero for a flat series rather than inventing a trend", () => {
		expect(measureRate(series([[20, 2], [20, 2], [20, 2], [20, 2], [20, 2]]), fh)).toBe(0);
	});

	it("returns zero while a rolling window decays, never a negative rate", () => {
		// Both windows roll, so utilisation falls when you stop working. A negative burn rate would
		// project a cap in the past.
		expect(measureRate(series([[40, 8], [35, 8], [30, 8], [25, 8], [20, 8]]), fh)).toBe(0);
	});

	it("refuses to guess from too short a span", () => {
		// Two samples ten minutes apart is under the fifteen-minute floor.
		expect(measureRate(series([[20, 2], [24, 2]], 10), fh)).toBeUndefined();
	});

	it("refuses to guess from a single sample", () => {
		expect(measureRate(series([[20, 2]]), fh)).toBeUndefined();
	});

	it("ignores history older than the measurement window", () => {
		// A burst four hours ago must not drag the current rate; only the last 90 minutes count.
		const old: PlanSample[] = [
			{ at: new Date(T0 - 4 * 3_600_000), fiveHourPct: 0, sevenDayPct: 0 },
			{ at: new Date(T0 - 3.5 * 3_600_000), fiveHourPct: 60, sevenDayPct: 5 }
		];
		const recent = series([
			[70, 6],
			[70, 6],
			[70, 6],
			[70, 6],
			[70, 6]
		]);
		expect(measureRate([...old, ...recent], fh)).toBe(0);
	});

	it("tracks the seven-day window independently of the five-hour one", () => {
		const samples = series([
			[20, 2],
			[30, 2],
			[40, 3],
			[50, 3],
			[60, 4]
		]);
		// sd rises 2 → 4 over 20 minutes = 6%/hr, while fh rises far faster.
		expect(measureRate(samples, (s) => s.sevenDayPct)).toBeCloseTo(6, 5);
		expect(measureRate(samples, fh)).toBeCloseTo(120, 5);
	});
});
