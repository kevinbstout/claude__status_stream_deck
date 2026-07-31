import { describe, expect, it } from "vitest";

import { currency, duration, paceBand, paceGlyph, paceLabel, pct, perHour, resetIn, tokens } from "../src/core/format";

describe("pct", () => {
	it("rounds to whole percentages", () => {
		expect(pct(73.4)).toBe("73%");
		expect(pct(73.5)).toBe("74%");
	});

	it("clamps to 0..100", () => {
		expect(pct(140)).toBe("100%");
		expect(pct(-3)).toBe("0%");
	});

	it("shows -- when there is nothing to report", () => {
		expect(pct(undefined)).toBe("--");
		expect(pct(Number.NaN)).toBe("--");
	});
});

describe("duration", () => {
	it("formats hours and minutes", () => {
		expect(duration(2 * 3_600_000 + 14 * 60_000)).toBe("2h 14m");
	});

	it("drops the minutes when they are zero", () => {
		expect(duration(3 * 3_600_000)).toBe("3h");
	});

	it("formats minutes alone", () => {
		expect(duration(48 * 60_000)).toBe("48m");
	});

	it("collapses sub-minute durations", () => {
		expect(duration(30_000)).toBe("< 1m");
	});

	it("reads 'now' at or past zero", () => {
		expect(duration(0)).toBe("now");
		expect(duration(-5_000)).toBe("now");
	});

	it("switches to days past 24 hours, for the weekly window", () => {
		expect(duration(50 * 3_600_000)).toBe("2d 2h");
	});
});

describe("resetIn", () => {
	it("phrases the countdown", () => {
		const now = new Date("2026-07-31T10:00:00.000Z");
		expect(resetIn(new Date("2026-07-31T12:14:00.000Z"), now)).toBe("resets 2h 14m");
	});

	it("is empty when there is no reset time", () => {
		expect(resetIn(undefined)).toBe("");
	});
});

describe("currency", () => {
	it("shows cents below $100", () => {
		expect(currency(0.8)).toBe("$0.80");
		expect(currency(12.345)).toBe("$12.35");
	});

	it("drops cents at or above $100 so the figure fits the strip", () => {
		expect(currency(1234.56)).toBe("$1,235");
	});

	it("shows -- when unknown", () => {
		expect(currency(undefined)).toBe("--");
	});
});

describe("perHour", () => {
	it("suffixes the rate", () => {
		expect(perHour(4.2)).toBe("$4.20/hr");
	});
});

describe("pace", () => {
	it("bands above 1.3 as burning faster than the clock", () => {
		expect(paceBand(1.4)).toBe("ahead");
		expect(paceGlyph(1.4)).toBe("▲");
		expect(paceLabel(1.4)).toBe("▲ fast");
	});

	it("bands 0.8 to 1.3 as on pace", () => {
		expect(paceBand(0.8)).toBe("on");
		expect(paceBand(1.3)).toBe("on");
		expect(paceLabel(1)).toBe("● on pace");
	});

	it("bands below 0.8 as having headroom", () => {
		expect(paceBand(0.5)).toBe("behind");
		expect(paceLabel(0.5)).toBe("▼ easy");
	});

	it("hides itself when pace is unknowable", () => {
		expect(paceBand(undefined)).toBeUndefined();
		expect(paceGlyph(undefined)).toBe("");
		expect(paceLabel(undefined)).toBe("");
	});
});

describe("tokens", () => {
	it("compacts large counts", () => {
		expect(tokens(1_250_000)).toBe("1.3M");
		expect(tokens(48_300)).toBe("48.3k");
		expect(tokens(912)).toBe("912");
	});
});
