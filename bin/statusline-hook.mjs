#!/usr/bin/env node
/**
 * Agent Usage Meter — Claude Code statusline shim.
 *
 * Reads the statusline payload Claude Code writes to stdin, mirrors the interesting fields to a
 * state file the Stream Deck plugin watches, and prints a one-line statusline so the user still
 * gets one.
 *
 * Hard rules, in order of importance:
 *   - No network. No `fetch`, no `http`, no sockets.
 *   - No credentials. Never open `.credentials.json`, a keychain, or an API key.
 *   - No child processes. `node:child_process` is not imported and must not be.
 *   - Never throw. Any failure path still prints something and exits 0, or the user's statusline
 *     breaks and they blame us.
 *
 * This file runs under whatever Node is on the user's PATH, outside the plugin bundle, so it has
 * zero imports beyond `node:fs`, `node:path` and `node:os`, and duplicates the candidate-path
 * logic from `src/core/pluck.ts` inline rather than importing it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = os.homedir();

const APP_DIR =
	process.platform === "win32"
		? path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "agent-usage-meter")
		: path.join(home, ".config", "agent-usage-meter");

const STATE_FILE = path.join(APP_DIR, "state.json");
const TMP_FILE = path.join(APP_DIR, "state.json.tmp");

// --- Candidate paths (mirrors src/core/pluck.ts) ----------------------------

const FIVE_HOUR_PCT = [
	"rate_limits.five_hour.used_percentage",
	"rate_limits.session.used_percentage",
	"rate_limits.fiveHour.usedPercentage",
	"rate_limit.session.utilization",
	"rate_limit.session.used_percentage",
	"rate_limits.five_hour.utilization"
];
const SEVEN_DAY_PCT = [
	"rate_limits.seven_day.used_percentage",
	"rate_limits.weekly.used_percentage",
	"rate_limits.sevenDay.usedPercentage",
	"rate_limit.weekly.utilization",
	"rate_limits.seven_day.utilization"
];
const FIVE_HOUR_RESET = [
	"rate_limits.five_hour.resets_at",
	"rate_limits.session.resets_at",
	"rate_limits.five_hour.reset_time_iso",
	"rate_limit.session.resets_at"
];
const SEVEN_DAY_RESET = [
	"rate_limits.seven_day.resets_at",
	"rate_limits.weekly.resets_at",
	"rate_limit.weekly.resets_at"
];
const CONTEXT_PCT = ["context_window.used_percentage", "context_window.usedPercentage"];
const SESSION_COST = ["cost.total_cost_usd", "cost.totalCostUsd"];
const MODEL_NAME = ["model.display_name", "model.id"];

// --- Tolerant probing -------------------------------------------------------

function get(obj, dotPath) {
	let cursor = obj;
	for (const segment of dotPath.split(".")) {
		if (cursor === null || cursor === undefined || typeof cursor !== "object") return undefined;
		cursor = cursor[segment];
	}
	return cursor === null ? undefined : cursor;
}

function pluckNumber(obj, paths) {
	for (const p of paths) {
		const value = get(obj, p);
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim() !== "") {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return undefined;
}

function pluckString(obj, paths) {
	for (const p of paths) {
		const value = get(obj, p);
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return undefined;
}

/** ISO string, or epoch seconds (anything under 1e12 cannot be a millisecond epoch). */
function normalizeReset(obj, paths) {
	for (const p of paths) {
		const value = get(obj, p);
		if (typeof value === "number" && Number.isFinite(value)) {
			const d = new Date(value < 1e12 ? value * 1000 : value);
			if (!Number.isNaN(d.getTime())) return d.toISOString();
		}
		if (typeof value === "string" && value.trim() !== "") {
			if (/^\d+(\.\d+)?$/.test(value.trim())) {
				const n = Number(value);
				const d = new Date(n < 1e12 ? n * 1000 : n);
				if (!Number.isNaN(d.getTime())) return d.toISOString();
			}
			const d = new Date(value);
			if (!Number.isNaN(d.getTime())) return d.toISOString();
		}
	}
	return undefined;
}

function clampPct(value) {
	if (!Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, value));
}

/**
 * Some payload versions report 0.73 where others report 73. Only rescale when the value is in
 * (0, 1] *and* a sibling metric is too — otherwise a legitimate 0.5% becomes 50%.
 */
function normalizePct(value, siblings) {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	if (value > 0 && value <= 1) {
		const corroborated = siblings.some((s) => s !== undefined && Number.isFinite(s) && s > 0 && s <= 1);
		if (corroborated) return clampPct(value * 100);
	}
	return clampPct(value);
}

// --- Output -----------------------------------------------------------------

function writeStateAtomically(state) {
	try {
		fs.mkdirSync(APP_DIR, { recursive: true });
		// Write then rename, so the plugin can never read a half-written file.
		fs.writeFileSync(TMP_FILE, JSON.stringify(state), "utf8");
		fs.renameSync(TMP_FILE, STATE_FILE);
	} catch {
		/* the statusline must keep working even if we cannot write */
	}
}

function statusLine(state) {
	const parts = [];
	if (state.model) parts.push(state.model);
	if (typeof state.contextUsedPct === "number") parts.push(`ctx ${Math.round(state.contextUsedPct)}%`);
	if (typeof state.sessionCostUsd === "number") parts.push(`$${state.sessionCostUsd.toFixed(2)}`);
	if (state.fiveHour) parts.push(`5h ${Math.round(state.fiveHour.usedPct)}%`);
	if (state.sevenDay) parts.push(`7d ${Math.round(state.sevenDay.usedPct)}%`);
	const line = parts.join("  ");
	return line.length > 120 ? line.slice(0, 119) + "…" : line;
}

function readStdin() {
	return new Promise((resolve) => {
		let buffer = "";
		let settled = false;
		const done = () => {
			if (!settled) {
				settled = true;
				resolve(buffer);
			}
		};
		try {
			process.stdin.setEncoding("utf8");
			process.stdin.on("data", (chunk) => {
				buffer += chunk;
			});
			process.stdin.on("end", done);
			process.stdin.on("error", done);
			// Claude Code closes stdin promptly; the timeout only guards against a stuck pipe.
			const timeout = setTimeout(done, 2000);
			timeout.unref?.();
		} catch {
			done();
		}
	});
}

async function main() {
	let raw = "";
	try {
		raw = await readStdin();
	} catch {
		raw = "";
	}

	let payload;
	try {
		payload = JSON.parse(raw);
	} catch {
		// Unparseable input: print nothing meaningful, but exit clean.
		process.stdout.write("\n");
		return;
	}

	const rawFive = pluckNumber(payload, FIVE_HOUR_PCT);
	const rawSeven = pluckNumber(payload, SEVEN_DAY_PCT);
	const rawContext = pluckNumber(payload, CONTEXT_PCT);

	const fivePct = normalizePct(rawFive, [rawSeven, rawContext]);
	const sevenPct = normalizePct(rawSeven, [rawFive, rawContext]);
	const contextPct = normalizePct(rawContext, [rawFive, rawSeven]);

	const state = { updatedAt: new Date().toISOString() };

	const model = pluckString(payload, MODEL_NAME);
	if (model) state.model = model;
	if (contextPct !== undefined) state.contextUsedPct = contextPct;

	const cost = pluckNumber(payload, SESSION_COST);
	if (cost !== undefined) state.sessionCostUsd = cost;

	if (fivePct !== undefined) {
		state.fiveHour = { usedPct: fivePct };
		const resetsAt = normalizeReset(payload, FIVE_HOUR_RESET);
		if (resetsAt) state.fiveHour.resetsAt = resetsAt;
	}
	if (sevenPct !== undefined) {
		state.sevenDay = { usedPct: sevenPct };
		const resetsAt = normalizeReset(payload, SEVEN_DAY_RESET);
		if (resetsAt) state.sevenDay.resetsAt = resetsAt;
	}

	writeStateAtomically(state);
	process.stdout.write(`${statusLine(state)}\n`);
}

main().then(
	() => process.exit(0),
	() => {
		// Absolute last resort: still emit a line, still exit clean.
		try {
			process.stdout.write("\n");
		} catch {
			/* nothing left to do */
		}
		process.exit(0);
	}
);
