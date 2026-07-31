import streamDeck from "@elgato/streamdeck";

import { resetTranscriptCache } from "./jsonl";
import {
	getClaudeDirOverride,
	getDesktopDirOverride,
	setClaudeDirOverride,
	setDesktopDirOverride
} from "./paths";
import { resetPlanUsageCache } from "./plan-usage";

/** Settings shared by every action, so each Property Inspector stays simple. */
export type GlobalSettings = {
	/** Override for the Claude Code data directory. Empty means "use the default". */
	claudeDir?: string;
	/** Override for the Claude desktop data directory. Empty means "use the default". */
	desktopDir?: string;
};

/** Apply global settings to the modules that care about them. Returns true if anything changed. */
export function applyGlobalSettings(settings: GlobalSettings | undefined): boolean {
	let changed = false;

	const nextClaude = settings?.claudeDir?.trim() || undefined;
	if (nextClaude !== getClaudeDirOverride()) {
		setClaudeDirOverride(nextClaude);
		resetTranscriptCache();
		changed = true;
	}

	const nextDesktop = settings?.desktopDir?.trim() || undefined;
	if (nextDesktop !== getDesktopDirOverride()) {
		setDesktopDirOverride(nextDesktop);
		resetPlanUsageCache();
		changed = true;
	}

	return changed;
}

/** Read global settings once at startup and keep them in sync afterwards. */
export async function watchGlobalSettings(onChange: () => void): Promise<void> {
	streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
		if (applyGlobalSettings(ev.settings)) {
			onChange();
		}
	});
	try {
		const initial = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
		if (applyGlobalSettings(initial)) {
			onChange();
		}
	} catch {
		// Falling back to defaults is fine; nothing here is required to render.
	}
}
