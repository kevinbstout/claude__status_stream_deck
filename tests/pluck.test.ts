import { describe, expect, it } from "vitest";

import { FIVE_HOUR_PCT, clampPct, normalizePct, normalizeReset, pluck, pluckNumber, pluckString } from "../src/core/pluck";

describe("pluck", () => {
	it("returns undefined when no candidate path resolves", () => {
		expect(pluck({ a: 1 }, ["b.c", "d"])).toBeUndefined();
	});

	it("takes the first path that resolves", () => {
		const obj = { rate_limits: { session: { used_percentage: 30 }, five_hour: { used_percentage: 42 } } };
		expect(pluckNumber(obj, FIVE_HOUR_PCT)).toBe(42);
	});

	it("falls through a null to a later candidate", () => {
		const obj = { rate_limits: { five_hour: { used_percentage: null }, session: { used_percentage: 12 } } };
		expect(pluckNumber(obj, FIVE_HOUR_PCT)).toBe(12);
	});

	it("treats null and undefined alike", () => {
		expect(pluck({ a: null }, ["a"])).toBeUndefined();
		expect(pluck({ a: undefined }, ["a"])).toBeUndefined();
	});

	it("does not walk into non-objects", () => {
		expect(pluck({ a: "string" }, ["a.b.c"])).toBeUndefined();
	});

	it("coerces numeric strings for numbers and rejects empty strings for strings", () => {
		expect(pluckNumber({ a: "73" }, ["a"])).toBe(73);
		expect(pluckNumber({ a: "abc" }, ["a"])).toBeUndefined();
		expect(pluckString({ a: "   " }, ["a", "b"])).toBeUndefined();
	});
});

describe("normalizeReset", () => {
	it("passes ISO strings through as ISO", () => {
		expect(normalizeReset("2026-07-31T12:00:00.000Z")).toBe("2026-07-31T12:00:00.000Z");
	});

	it("treats a number below 1e12 as epoch seconds", () => {
		// The millisecond epoch passed 1e12 in 2001, so anything smaller must be seconds.
		expect(normalizeReset(1_785_000_000)).toBe(new Date(1_785_000_000_000).toISOString());
	});

	it("treats a number at or above 1e12 as epoch milliseconds", () => {
		expect(normalizeReset(1_785_000_000_000)).toBe(new Date(1_785_000_000_000).toISOString());
	});

	it("normalizes epoch seconds delivered as a numeric string", () => {
		expect(normalizeReset("1785000000")).toBe(new Date(1_785_000_000_000).toISOString());
	});

	it("returns undefined for junk", () => {
		expect(normalizeReset("not a date")).toBeUndefined();
		expect(normalizeReset(null)).toBeUndefined();
		expect(normalizeReset({})).toBeUndefined();
	});
});

describe("normalizePct", () => {
	it("rescales a fractional value when a sibling corroborates it", () => {
		expect(normalizePct(0.73, [0.4])).toBeCloseTo(73);
	});

	it("leaves a lone sub-1 value alone, so a real 0.5% is not inflated to 50%", () => {
		expect(normalizePct(0.5, [73])).toBeCloseTo(0.5);
		expect(normalizePct(0.5, [undefined])).toBeCloseTo(0.5);
	});

	it("does not rescale a zero", () => {
		expect(normalizePct(0, [0.4])).toBe(0);
	});

	it("leaves values above 1 alone", () => {
		expect(normalizePct(73, [0.4])).toBe(73);
	});

	it("clamps out-of-range values", () => {
		expect(normalizePct(140, [])).toBe(100);
		expect(normalizePct(-5, [])).toBe(0);
		expect(clampPct(Number.NaN)).toBe(0);
	});

	it("returns undefined for undefined", () => {
		expect(normalizePct(undefined, [0.5])).toBeUndefined();
	});
});
