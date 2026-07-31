import { type Band, MUTED, TEXT, TRACK, colorFor } from "./colors";

const SIZE = 144;
const CX = 72;
const CY = 66;
const R = 48;
const STROKE = 12;

/** The gauge sweeps 270°, from bottom-left clockwise over the top to bottom-right. */
const START_ANGLE = 135;
const SWEEP = 270;

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";

function escapeText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function point(angleDeg: number): [number, number] {
	const rad = (angleDeg * Math.PI) / 180;
	return [CX + R * Math.cos(rad), CY + R * Math.sin(rad)];
}

/** Path data for an arc of the gauge track, from the start angle through `sweepDeg`. */
function arcPath(sweepDeg: number): string {
	const clamped = Math.min(SWEEP, Math.max(0, sweepDeg));
	const [x0, y0] = point(START_ANGLE);
	const [x1, y1] = point(START_ANGLE + clamped);
	const largeArc = clamped > 180 ? 1 : 0;
	return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 ${largeArc} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** Small clock glyph drawn in the top-right corner whenever the data is stale. */
function staleGlyph(): string {
	return [
		`<g transform="translate(118,18)" fill="none" stroke="${MUTED}" stroke-width="2">`,
		`<circle cx="0" cy="0" r="9"/>`,
		`<path d="M0 -5 L0 0 L4 3" stroke-linecap="round"/>`,
		`</g>`
	].join("");
}

export type GaugeOptions = {
	label: string;
	value: string;
	/** 0..100. Undefined draws the track only. */
	pct?: number;
	stale: boolean;
	band: Band;
};

/**
 * Render the keypad gauge as an SVG string, sized 144 × 144 for the @2x key slot.
 *
 * Stale data is dimmed to 40% and carries a clock glyph, so a frozen number can never be mistaken
 * for a live one.
 */
export function gauge({ label, value, pct, stale, band }: GaugeOptions): string {
	const hasValue = pct !== undefined && Number.isFinite(pct);
	const clamped = hasValue ? Math.min(100, Math.max(0, pct)) : 0;
	// Below half a percent there is no arc to draw, and a zero-length one would still paint its
	// round cap as a stray dot on the track.
	const progress =
		hasValue && clamped >= 0.5
			? `<path d="${arcPath((clamped / 100) * SWEEP)}" fill="none" stroke="${colorFor(band)}" stroke-width="${STROKE}" stroke-linecap="round"/>`
			: "";

	const body = [
		`<path d="${arcPath(SWEEP)}" fill="none" stroke="${TRACK}" stroke-width="${STROKE}" stroke-linecap="round"/>`,
		progress,
		`<text x="${CX}" y="78" fill="${TEXT}" font-family="${FONT}" font-size="34" font-weight="600" text-anchor="middle">${escapeText(hasValue ? value : "--")}</text>`,
		`<text x="${CX}" y="128" fill="${MUTED}" font-family="${FONT}" font-size="13" font-weight="500" text-anchor="middle">${escapeText(label)}</text>`
	].join("");

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
		`<g${stale ? ' opacity="0.4"' : ""}>${body}</g>`,
		stale ? staleGlyph() : "",
		`</svg>`
	].join("");
}

export type AlertKeyOptions = {
	label: string;
	value: string;
	stale: boolean;
	band: Band;
};

/** Solid-fill key for the threshold alert: near-black below warn, amber, then red. */
export function alertKey({ label, value, stale, band }: AlertKeyOptions): string {
	const fill = band === "ok" || band === "none" ? "#141414" : colorFor(band);
	const ink = band === "warn" ? "#1a1a1a" : TEXT;
	const sub = band === "warn" ? "#3a3a3a" : band === "critical" ? "#ffd6d6" : MUTED;

	const body = [
		`<rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="16" fill="${fill}"/>`,
		`<text x="${CX}" y="80" fill="${ink}" font-family="${FONT}" font-size="40" font-weight="700" text-anchor="middle">${escapeText(value)}</text>`,
		`<text x="${CX}" y="110" fill="${sub}" font-family="${FONT}" font-size="14" font-weight="500" text-anchor="middle">${escapeText(label)}</text>`
	].join("");

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
		`<g${stale ? ' opacity="0.4"' : ""}>${body}</g>`,
		stale ? staleGlyph() : "",
		`</svg>`
	].join("");
}

/** Wrap an SVG string for `setImage`, which expects a data URI. */
export function toDataUri(svg: string): string {
	return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}
