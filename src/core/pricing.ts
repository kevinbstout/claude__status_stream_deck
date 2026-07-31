import fs from "node:fs";
import path from "node:path";
import url from "node:url";

export type Rate = {
	/** USD per million tokens. */
	input: number;
	output: number;
	cacheWrite: number;
	cacheRead: number;
};

export type PricingTable = {
	default: Rate;
	models: { match: string; rate: Rate }[];
};

export type TokenCounts = {
	input: number;
	output: number;
	cacheWrite: number;
	cacheRead: number;
};

const FALLBACK: PricingTable = {
	default: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
	models: []
};

let cached: PricingTable | undefined;

/**
 * Locate `pricing.json`.
 *
 * In the shipped plugin the bundle sits at `<sdPlugin>/bin/plugin.js`, so the table is one level up
 * and stays user-editable in place. The diagnostic bundle sits elsewhere and keeps a copy beside
 * it — probing both means the diagnostic reports the same figures the dials do, rather than
 * silently falling back to default rates and disagreeing with the plugin.
 */
function pricingFile(): string | undefined {
	const here = path.dirname(url.fileURLToPath(import.meta.url));
	for (const candidate of [path.join(here, "..", "pricing.json"), path.join(here, "pricing.json")]) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function isRate(value: unknown): value is Rate {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const r = value as Record<string, unknown>;
	return ["input", "output", "cacheWrite", "cacheRead"].every(
		(k) => typeof r[k] === "number" && Number.isFinite(r[k] as number)
	);
}

/** Load the user-editable pricing table, falling back to conservative built-in rates. */
export function loadPricing(force = false): PricingTable {
	if (cached && !force) {
		return cached;
	}
	try {
		const file = pricingFile();
		if (file === undefined) {
			throw new Error("no pricing table found");
		}
		const raw = fs.readFileSync(file, "utf8");
		// The shipped file carries a leading `//` comment block explaining that rates are
		// user-maintained; strip whole-line comments before parsing.
		const stripped = raw
			.split("\n")
			.filter((line) => !line.trim().startsWith("//"))
			.join("\n");
		const parsed: unknown = JSON.parse(stripped);
		if (typeof parsed !== "object" || parsed === null) {
			throw new Error("not an object");
		}
		const obj = parsed as Record<string, unknown>;
		const table: PricingTable = {
			default: isRate(obj.default) ? obj.default : FALLBACK.default,
			models: []
		};
		if (Array.isArray(obj.models)) {
			for (const entry of obj.models) {
				if (typeof entry === "object" && entry !== null) {
					const e = entry as Record<string, unknown>;
					if (typeof e.match === "string" && isRate(e.rate)) {
						table.models.push({ match: e.match.toLowerCase(), rate: e.rate });
					}
				}
			}
		}
		cached = table;
		return table;
	} catch {
		cached = FALLBACK;
		return FALLBACK;
	}
}

/** Pick the rate for a model id by longest matching substring, falling back to `default`. */
export function rateFor(model: string | undefined, table: PricingTable = loadPricing()): Rate {
	if (!model) {
		return table.default;
	}
	const needle = model.toLowerCase();
	let best: { match: string; rate: Rate } | undefined;
	for (const entry of table.models) {
		if (needle.includes(entry.match) && (best === undefined || entry.match.length > best.match.length)) {
			best = entry;
		}
	}
	return best?.rate ?? table.default;
}

/** Estimate the USD cost of a token count under the given model's rate. */
export function estimateCost(tokens: TokenCounts, model: string | undefined, table: PricingTable = loadPricing()): number {
	const rate = rateFor(model, table);
	return (
		(tokens.input * rate.input +
			tokens.output * rate.output +
			tokens.cacheWrite * rate.cacheWrite +
			tokens.cacheRead * rate.cacheRead) /
		1_000_000
	);
}
