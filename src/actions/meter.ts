import {
	type DialAction,
	type DialDownEvent,
	type DialRotateEvent,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	SingletonAction,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
	action
} from "@elgato/streamdeck";

import { currency, duration, pct, paceLabel, pctPerHour, perHour, resetLine } from "../core/format";
import type { Metric, Snapshot } from "../core/snapshot";
import { bandFor } from "../render/colors";
import { gauge, toDataUri } from "../render/gauge";
import { applySettings, attach, cycle, detach, openUsagePage, refresh, repaint } from "./base";

export const METRICS = [
	"five_hour",
	"seven_day",
	"allowance_burn",
	"context",
	"cost_today",
	"cost_rate"
] as const;
export type MetricId = (typeof METRICS)[number];

export type MeterSettings = {
	metric?: MetricId;
	/** Compact hides the reset countdown and the pace line. */
	compact?: boolean;
};

// "API" is load-bearing on the cost headings: those figures are list-price value of local tokens,
// not subscription spend, and must never be mistaken for the Pro/Max allowance above them.
const HEADINGS: Record<MetricId, string> = {
	five_hour: "Session (5h)",
	seven_day: "Weekly (7d)",
	allowance_burn: "Allowance burn",
	context: "Context",
	cost_today: "API cost today",
	cost_rate: "API cost rate"
};

const SHORT: Record<MetricId, string> = {
	five_hour: "5h",
	seven_day: "7d",
	allowance_burn: "burn",
	context: "ctx",
	cost_today: "API today",
	cost_rate: "API $/hr"
};

type View = {
	heading: string;
	short: string;
	value: string;
	/** Percentage backing the bar and the colour band, when the metric has one. */
	pct?: number;
	reset: string;
	pace: string;
	/** True when this metric depends on limit data the statusline never produced. */
	missing: boolean;
};

/** Project the snapshot down to everything one metric needs to draw itself. */
export function metricView(id: MetricId, snapshot: Snapshot): View {
	const base = { heading: HEADINGS[id], short: SHORT[id], reset: "", pace: "", missing: false };

	switch (id) {
		case "five_hour":
		case "seven_day": {
			const metric: Metric = id === "five_hour" ? snapshot.fiveHour : snapshot.sevenDay;
			const missing = metric.usedPct === undefined;
			return {
				...base,
				value: missing ? "--" : pct(metric.usedPct),
				pct: metric.usedPct,
				reset: missing ? "no data" : resetLine(metric),
				pace: missing ? "" : paceLabel(metric.pace),
				missing
			};
		}
		case "context": {
			const value = snapshot.context.usedPct;
			return {
				...base,
				value: value === undefined ? "--" : pct(value),
				pct: value,
				reset: value === undefined ? "no data" : "of window",
				missing: value === undefined
			};
		}
		case "allowance_burn": {
			// Show whichever window is projected to run out first — the one that will actually stop
			// you. Falling back to the 5-hour window keeps a rate on screen when neither is at risk.
			const which = snapshot.binding ?? "five_hour";
			const metric: Metric = which === "five_hour" ? snapshot.fiveHour : snapshot.sevenDay;
			const missing = metric.usedPct === undefined;
			if (missing) {
				return { ...base, value: "--", reset: "no data", missing: true };
			}
			const label = which === "five_hour" ? "session" : "weekly";
			return {
				...base,
				heading: `Burn · ${label}`,
				value: pctPerHour(metric.ratePerHour),
				pct: metric.usedPct,
				// The projection is the point of this metric: not "how fast", but "when does it bite".
				// When nothing is going to bite, the next most useful fact is when the window refills.
				reset: metric.exhaustsAt
					? `cap in ${duration(metric.exhaustsAt.getTime() - Date.now())}`
					: metric.ratePerHour === undefined
						? "warming up"
						: resetLine(metric) || "clears the window",
				pace: paceLabel(metric.pace),
				missing: false
			};
		}
		case "cost_today": {
			const prefix = snapshot.spend.exactness === "estimated" ? "~" : "";
			return {
				...base,
				value: `${prefix}${currency(snapshot.spend.today)}`,
				reset: "API list price",
				missing: false
			};
		}
		case "cost_rate": {
			const prefix = snapshot.spend.exactness === "estimated" ? "~" : "";
			return {
				...base,
				value: `${prefix}${perHour(snapshot.spend.burnPerHour)}`,
				reset: "API list price",
				missing: false
			};
		}
	}
}

async function paint(
	target: DialAction<MeterSettings> | KeyAction<MeterSettings>,
	snapshot: Snapshot,
	settings: MeterSettings
): Promise<void> {
	const metric = settings.metric ?? "five_hour";
	const view = metricView(metric, snapshot);
	// A missing reading is already shown as `--`; only a real number can go stale.
	const stale = snapshot.stale && !view.missing;

	if (target.isDial()) {
		const compact = settings.compact === true;
		await target.setFeedback({
			heading: `${stale ? "○ " : ""}${view.heading}`,
			value: view.value,
			reset: compact ? "" : view.reset,
			pace: compact ? "" : view.pace,
			indicator: { value: Math.round(view.pct ?? 0) }
		});
		return;
	}

	await target.setImage(
		toDataUri(gauge({ label: view.short, value: view.value, pct: view.pct, stale, band: bandFor(view.pct) }))
	);
}

/**
 * The core action: one metric on one dial, or a gauge on one key.
 *
 * Rotate cycles the metric, press refreshes, tap toggles detail, and a held tap opens the usage
 * page in the browser.
 */
@action({ UUID: "com.revductive.usage-meter.meter" })
export class UsageMeter extends SingletonAction<MeterSettings> {
	override onWillAppear(ev: WillAppearEvent<MeterSettings>): void {
		attach(ev.action, ev.payload.settings, paint);
	}

	override onWillDisappear(ev: WillDisappearEvent<MeterSettings>): void {
		detach(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<MeterSettings>): Promise<void> {
		await repaint(ev.action, ev.payload.settings, paint);
	}

	override async onDialRotate(ev: DialRotateEvent<MeterSettings>): Promise<void> {
		const next = cycle(METRICS, ev.payload.settings.metric ?? "five_hour", ev.payload.ticks);
		await applySettings(ev.action, { ...ev.payload.settings, metric: next }, paint);
	}

	override async onDialDown(ev: DialDownEvent<MeterSettings>): Promise<void> {
		await refresh(ev.action);
	}

	override async onKeyDown(ev: KeyDownEvent<MeterSettings>): Promise<void> {
		await refresh(ev.action);
	}

	override async onTouchTap(ev: TouchTapEvent<MeterSettings>): Promise<void> {
		if (ev.payload.hold) {
			await openUsagePage();
			return;
		}
		await applySettings(ev.action, { ...ev.payload.settings, compact: ev.payload.settings.compact !== true }, paint);
	}
}
