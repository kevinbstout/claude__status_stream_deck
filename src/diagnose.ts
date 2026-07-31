/**
 * Local diagnostic — prints exactly what the plugin would see on this machine.
 *
 * Answers which data sources resolved, whether this Claude Code build emits rate limits, and what
 * the transcript parser found, without needing a Stream Deck plugged in. It is the fastest way to
 * tell a data problem from a render problem. Built as its own bundle so it can run standalone:
 *
 *   npm run diagnose
 *
 * Development tool only — it is not part of `plugin.js` and never ships to the Marketplace.
 */

import { readTranscripts } from "./core/jsonl";
import { STATE_FILE, claudeProjects, planUsageFile } from "./core/paths";
import { readPlanUsage } from "./core/plan-usage";
import { buildSnapshot } from "./core/snapshot";
import { readState } from "./core/state";

const state = readState();
const plan = readPlanUsage();

const coldStart = process.hrtime.bigint();
const { entries, exactness, fileCount } = await readTranscripts();
const coldMs = Number(process.hrtime.bigint() - coldStart) / 1e6;

const warmStart = process.hrtime.bigint();
await readTranscripts();
const warmMs = Number(process.hrtime.bigint() - warmStart) / 1e6;

const snapshot = buildSnapshot({ state, plan, entries, exactness });
const iso = (date: Date | undefined): string => date?.toISOString() ?? "--";
const money = (value: number): string => value.toFixed(2);

console.log(`transcripts:  ${claudeProjects()}`);
console.log(`              ${fileCount} files, ${entries.length} entries, cold ${coldMs.toFixed(0)}ms, warm ${warmMs.toFixed(0)}ms`);
console.log(`state file:   ${STATE_FILE}`);
console.log(state ? `              updated ${state.updatedAt}` : "              absent — statusline hook not installed, or never run");
console.log(`plan usage:   ${planUsageFile()}`);
console.log(
	plan
		? `              sampled ${plan.latest.at.toISOString()}  fh ${plan.latest.fiveHourPct}%  sd ${plan.latest.sevenDayPct}%`
		: "              absent — Claude desktop not installed, or never run"
);
console.log("");
console.log(`hasLimitData: ${snapshot.hasLimitData}${snapshot.hasLimitData ? "" : "   (limit dials will show --)"}`);
console.log(`stale:        ${snapshot.stale}`);
console.log(`model:        ${snapshot.model ?? "--"}`);
const burn = (label: string, m: typeof snapshot.fiveHour): string =>
	`${label}  ${m.usedPct ?? "--"}%  resets ${iso(m.resetsAt)}  burn ${m.ratePerHour?.toFixed(2) ?? "--"}%/hr  cap ${iso(m.exhaustsAt)}`;
console.log(burn("5h:          ", snapshot.fiveHour));
console.log(burn("7d:          ", snapshot.sevenDay));
console.log(`binding:      ${snapshot.binding ?? "neither window is on course to cap"}`);
console.log(`context:      ${snapshot.context.usedPct ?? "--"}%`);
console.log(
	`spend:        today ${money(snapshot.spend.today)}  7d ${money(snapshot.spend.week)}  month ${money(snapshot.spend.month)}  block ${money(snapshot.spend.activeBlock)}  ${money(snapshot.spend.burnPerHour)}/hr  (${snapshot.spend.exactness})`
);
