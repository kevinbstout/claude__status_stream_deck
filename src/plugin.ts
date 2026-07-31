import fs from "node:fs";

import streamDeck from "@elgato/streamdeck";

import { ThresholdAlert } from "./actions/alert";
import { DualMeter } from "./actions/dual";
import { UsageMeter } from "./actions/meter";
import { SpendTracker } from "./actions/spend";
import { APP_DIR, claudeDesktopCandidates, claudeProjects, planUsageFile } from "./core/paths";
import { readPlanUsage } from "./core/plan-usage";
import { invalidate } from "./core/poller";
import { watchGlobalSettings } from "./core/settings";
import { inspectHook, installHook, uninstallHook } from "./hook/install";

// Plugin logs land on disk in plaintext. Percentages and timestamps only — never file contents,
// prompts, project paths, or session identifiers.
streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new UsageMeter());
streamDeck.actions.registerAction(new DualMeter());
streamDeck.actions.registerAction(new SpendTracker());
streamDeck.actions.registerAction(new ThresholdAlert());

type InspectorMessage = { event?: string } | null;

/**
 * Send the current data-source status to the Property Inspector.
 *
 * Two independent sources feed the limit dials, so the panel reports both: Claude desktop's plan
 * usage record needs no setup at all, and the statusline hook is an optional addition that
 * contributes reset times and context usage.
 */
async function reportHookStatus(): Promise<void> {
	const status = inspectHook();
	const plan = readPlanUsage();
	await streamDeck.ui.sendToPropertyInspector({
		event: "hookStatus",
		...status,
		planAvailable: plan !== undefined,
		planSampledAt: plan?.latest.at.toISOString(),
		planFiveHourPct: plan?.latest.fiveHourPct,
		planSevenDayPct: plan?.latest.sevenDayPct
	});
}

streamDeck.ui.onSendToPlugin(async (ev) => {
	const payload = ev.payload as InspectorMessage;
	switch (payload?.event) {
		case "getHookStatus":
			await reportHookStatus();
			break;
		case "installHook": {
			const result = installHook();
			if (!result.ok) {
				await ev.action.showAlert();
			}
			await streamDeck.ui.sendToPropertyInspector({ event: "installResult", ...result });
			await reportHookStatus();
			break;
		}
		case "uninstallHook": {
			const result = uninstallHook();
			if (!result.ok) {
				await ev.action.showAlert();
			}
			await streamDeck.ui.sendToPropertyInspector({ event: "uninstallResult", ...result });
			await reportHookStatus();
			break;
		}
		default:
			break;
	}
});

// Connect first. Anything that *asks* Stream Deck for something — global settings included — sends
// a command over a socket that does not exist until this resolves, leaving a promise that never
// settles. With nothing else holding the event loop open, Node exits with code 13 and Stream Deck
// restarts the plugin every ten seconds forever.
await streamDeck.connect();
streamDeck.logger.info("connected");

// One-shot probe of the paths this plugin depends on. Stream Deck may run plugins with a
// restricted view of the filesystem, and a denial can surface as ENOENT rather than EACCES — which
// looks exactly like a missing file. Logging which roots are visible turns that into a five-second
// diagnosis. Booleans and fixed application paths only; never user content.
{
	const probes: [string, string][] = [
		["transcripts", claudeProjects()],
		["stateDir", APP_DIR],
		["planFile", planUsageFile()]
	];
	const seen = probes.map(([name, p]) => `${name}=${fs.existsSync(p) ? "y" : "n"}`).join(" ");
	streamDeck.logger.info(`path probe: ${seen} desktopCandidates=${claudeDesktopCandidates().length}`);
}

// Deliberately not awaited. Global settings are a convenience — the plugin renders fine without
// them — and a top-level `await` that never settles empties the event loop, at which point Node
// exits with code 13 and Stream Deck restarts us every ten seconds until it gives up and disables
// the plugin. Nothing at startup is worth that risk.
void watchGlobalSettings(() => {
	void invalidate();
});
