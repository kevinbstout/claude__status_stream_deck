import fs from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { alertKey, gauge, toDataUri } from "../src/render/gauge";

/**
 * The gauge sweeps 270° from bottom-left, clockwise over the top, to bottom-right, on a 144×144
 * canvas with centre (72, 66) and radius 48. Those endpoints are:
 *   135° → (72 + 48·cos135, 66 + 48·sin135) = (38.06, 99.94)
 *   405° → (72 + 48·cos405, 66 + 48·sin405) = (105.94, 99.94)
 * A broken arc path renders as a blank or wildly wrong key, and nothing else would catch it.
 */
const START = "M 38.06 99.94";
const FULL_END = "A 48 48 0 1 1 105.94 99.94";

const samples = [
	{ label: "5h", value: "0%", pct: 0, stale: false, band: "ok" as const },
	{ label: "5h", value: "42%", pct: 42, stale: false, band: "ok" as const },
	{ label: "7d", value: "78%", pct: 78, stale: false, band: "warn" as const },
	{ label: "7d", value: "96%", pct: 96, stale: false, band: "critical" as const },
	{ label: "5h", value: "100%", pct: 100, stale: false, band: "critical" as const },
	{ label: "5h", value: "61%", pct: 61, stale: true, band: "ok" as const },
	{ label: "ctx", value: "--", pct: undefined, stale: false, band: "none" as const }
];

describe("gauge", () => {
	it("draws the full track from the documented start to the documented end", () => {
		const svg = gauge(samples[1]!);
		expect(svg).toContain(`d="${START} ${FULL_END}"`);
	});

	it("closes the progress arc at the track's end when full", () => {
		expect(gauge(samples[4]!)).toContain(`stroke="#d50000" stroke-width="12"`);
		// A 100% progress arc traces the same geometry as the track.
		expect(gauge(samples[4]!).match(/d="M 38\.06 99\.94 A 48 48 0 1 1 105\.94 99\.94"/g)).toHaveLength(2);
	});

	it("flips the large-arc flag below the halfway point", () => {
		// 42% of 270° is 113.4° — under 180, so large-arc must be 0.
		expect(gauge(samples[1]!)).toContain(`${START} A 48 48 0 0 1`);
		// 78% is 210.6° — over 180, so it must be 1.
		expect(gauge(samples[2]!)).toContain(`${START} A 48 48 0 1 1`);
	});

	it("draws the track only, and --, when there is no percentage", () => {
		const svg = gauge(samples[6]!);
		expect(svg).toContain(">--<");
		expect(svg.match(/<path d="M 38\.06/g)).toHaveLength(1);
	});

	it("omits the progress arc entirely at 0%, so no stray line cap sits on the track", () => {
		const svg = gauge(samples[0]!);
		expect(svg.match(/<path d="M 38\.06/g)).toHaveLength(1);
		expect(svg).toContain(">0%<");
	});

	it("still draws an arc for a small but real percentage", () => {
		expect(gauge({ ...samples[0]!, pct: 2, value: "2%" })).toContain('stroke="#00c853"');
	});

	it("dims and marks stale readings, so a frozen number is never shown as live", () => {
		const stale = gauge(samples[5]!);
		expect(stale).toContain('opacity="0.4"');
		expect(stale).toContain("<circle cx=\"0\" cy=\"0\" r=\"9\"/>");
		expect(gauge(samples[1]!)).not.toContain('opacity="0.4"');
	});

	it("clamps out-of-range percentages instead of overshooting the arc", () => {
		expect(gauge({ ...samples[1]!, pct: 140 })).toContain("A 48 48 0 1 1 105.94 99.94");
		expect(gauge({ ...samples[1]!, pct: -20 }).match(/<path d="M 38\.06/g)).toHaveLength(1);
	});

	it("escapes text rather than emitting raw markup", () => {
		expect(gauge({ ...samples[1]!, label: "<b>&x" })).toContain("&lt;b&gt;&amp;x");
	});
});

describe("alertKey", () => {
	it("stays near-black in the ok band", () => {
		expect(alertKey({ label: "session", value: "12%", stale: false, band: "ok" })).toContain('fill="#141414"');
	});

	it("fills amber and red in the warn and critical bands", () => {
		expect(alertKey({ label: "session", value: "75%", stale: false, band: "warn" })).toContain('fill="#f4b675"');
		expect(alertKey({ label: "session", value: "95%", stale: false, band: "critical" })).toContain('fill="#d50000"');
	});

	it("darkens its ink on amber, which white text would be unreadable against", () => {
		expect(alertKey({ label: "session", value: "75%", stale: false, band: "warn" })).toContain('fill="#1a1a1a"');
	});
});

describe("toDataUri", () => {
	it("produces a data URI setImage accepts", () => {
		const uri = toDataUri(gauge(samples[1]!));
		expect(uri.startsWith("data:image/svg+xml;charset=utf8,")).toBe(true);
		expect(uri).not.toContain("<");
	});
});

// Opt-in visual check: `PREVIEW=<dir> npx vitest run tests/gauge.test.ts` writes a contact sheet.
afterAll(() => {
	const dir = process.env.PREVIEW;
	if (!dir) {
		return;
	}
	const tiles = [
		...samples.map((s) => `<figure><div>${gauge(s)}</div><figcaption>${s.label} ${s.value}${s.stale ? " stale" : ""}</figcaption></figure>`),
		...(["ok", "warn", "critical"] as const).map(
			(band) =>
				`<figure><div>${alertKey({ label: "session", value: band === "ok" ? "40%" : band === "warn" ? "75%" : "95%", stale: false, band })}</div><figcaption>alert ${band}</figcaption></figure>`
		)
	].join("");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "gauge-preview.html"),
		`<style>body{background:#1a1a1a;color:#ccc;font:13px system-ui;display:flex;flex-wrap:wrap;gap:20px;padding:24px}figure{margin:0;text-align:center}figcaption{margin-top:6px}</style>${tiles}`,
		"utf8"
	);
});
