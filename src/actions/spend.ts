import {
	type DialAction,
	type DialDownEvent,
	type DialRotateEvent,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
	action
} from "@elgato/streamdeck";

import { currency, perHour } from "../core/format";
import type { Snapshot } from "../core/snapshot";
import { OK, WARN } from "../render/colors";
import { gauge, toDataUri } from "../render/gauge";
import { applySettings, attach, cycle, detach, refresh, repaint } from "./base";

export const WINDOWS = ["today", "week", "month", "block"] as const;
export type SpendWindow = (typeof WINDOWS)[number];

export type SpendSettings = {
	window?: SpendWindow;
};

// The heading always leads with "API cost". This figure is the list price these tokens would have
// cost on pay-as-you-go — it is not subscription spend and has nothing to do with the Pro/Max
// allowance the other actions show. Naming the window second keeps that unambiguous at a glance.
const HEADINGS: Record<SpendWindow, string> = {
	today: "API cost · today",
	week: "API cost · 7 days",
	month: "API cost · month",
	block: "API cost · block"
};

const SHORT: Record<SpendWindow, string> = {
	today: "API today",
	week: "API 7d",
	month: "API month",
	block: "API block"
};

export function amountFor(window: SpendWindow, snapshot: Snapshot): number {
	switch (window) {
		case "today":
			return snapshot.spend.today;
		case "week":
			return snapshot.spend.week;
		case "month":
			return snapshot.spend.month;
		case "block":
			return snapshot.spend.activeBlock;
	}
}

async function paint(
	target: DialAction<SpendSettings> | KeyAction<SpendSettings>,
	snapshot: Snapshot,
	settings: SpendSettings
): Promise<void> {
	const window = settings.window ?? "today";
	// Figures derived from pricing.json rather than a transcript-provided cost carry a `~`.
	// An estimate is never presented as exact.
	const prefix = snapshot.spend.exactness === "estimated" ? "~" : "";
	const amount = `${prefix}${currency(amountFor(window, snapshot))}`;

	// Transcripts keep accruing whether or not the statusline is running, so spend is never dimmed
	// for staleness the way the limit meters are.
	if (target.isDial()) {
		const share = snapshot.spend.month > 0 ? (amountFor(window, snapshot) / snapshot.spend.month) * 100 : 0;
		await target.setFeedback({
			heading: HEADINGS[window],
			value: amount,
			sub: `${prefix}${perHour(snapshot.spend.burnPerHour)} · list price`,
			indicator: { value: Math.round(Math.min(100, share)), bar_fill_c: window === "month" ? WARN : OK }
		});
		return;
	}

	await target.setImage(toDataUri(gauge({ label: SHORT[window], value: amount, stale: false, band: "none" })));
}

/** Rolled-up spend from local transcripts, with the burn rate underneath. */
@action({ UUID: "com.revductive.usage-meter.spend" })
export class SpendTracker extends SingletonAction<SpendSettings> {
	override onWillAppear(ev: WillAppearEvent<SpendSettings>): void {
		attach(ev.action, ev.payload.settings, paint);
	}

	override onWillDisappear(ev: WillDisappearEvent<SpendSettings>): void {
		detach(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SpendSettings>): Promise<void> {
		await repaint(ev.action, ev.payload.settings, paint);
	}

	override async onDialRotate(ev: DialRotateEvent<SpendSettings>): Promise<void> {
		const next = cycle(WINDOWS, ev.payload.settings.window ?? "today", ev.payload.ticks);
		await applySettings(ev.action, { ...ev.payload.settings, window: next }, paint);
	}

	override async onDialDown(ev: DialDownEvent<SpendSettings>): Promise<void> {
		await refresh(ev.action);
	}

	override async onKeyDown(ev: KeyDownEvent<SpendSettings>): Promise<void> {
		await refresh(ev.action);
	}
}
