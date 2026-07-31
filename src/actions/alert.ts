import {
	type DialAction,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
	action
} from "@elgato/streamdeck";

import { pct } from "../core/format";
import type { Snapshot } from "../core/snapshot";
import { type Band, bandForThresholds } from "../render/colors";
import { alertKey, toDataUri } from "../render/gauge";
import { attach, detach, refresh, repaint } from "./base";

export type AlertMetric = "five_hour" | "seven_day";

export type AlertSettings = {
	metric?: AlertMetric;
	warnAt?: number;
	criticalAt?: number;
	/** Last band we rendered, so the alert fires once per upward crossing rather than every tick. */
	lastBand?: Band;
};

const LABELS: Record<AlertMetric, string> = {
	five_hour: "session",
	seven_day: "weekly"
};

const RANK: Record<Band, number> = { none: 0, ok: 1, warn: 2, critical: 3 };

export function clampThreshold(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.min(100, Math.max(1, Math.round(value)));
}

async function paint(
	target: DialAction<AlertSettings> | KeyAction<AlertSettings>,
	snapshot: Snapshot,
	settings: AlertSettings
): Promise<void> {
	if (!target.isKey()) {
		return;
	}

	const metric = settings.metric ?? "five_hour";
	const warnAt = clampThreshold(settings.warnAt, 70);
	const criticalAt = Math.max(warnAt, clampThreshold(settings.criticalAt, 90));
	const value = metric === "five_hour" ? snapshot.fiveHour.usedPct : snapshot.sevenDay.usedPct;
	const band = bandForThresholds(value, warnAt, criticalAt);

	await target.setImage(
		toDataUri(
			alertKey({
				label: LABELS[metric],
				value: value === undefined ? "--" : pct(value),
				stale: snapshot.stale && value !== undefined,
				band
			})
		)
	);

	// Fire only on an upward crossing. A key that pulses continuously at 95% trains the user to
	// ignore it.
	const previous = settings.lastBand ?? "none";
	if (RANK[band] > RANK[previous] && (band === "warn" || band === "critical")) {
		await target.showAlert();
	}
	if (band !== previous) {
		// Deliberately not awaited: persisting the band must never hold up the next repaint.
		void target.setSettings({ ...settings, lastBand: band });
	}
}

/** An ambient key: dark while you have room, amber as you approach the limit, red past it. */
@action({ UUID: "com.revductive.usage-meter.alert" })
export class ThresholdAlert extends SingletonAction<AlertSettings> {
	override onWillAppear(ev: WillAppearEvent<AlertSettings>): void {
		attach(ev.action, ev.payload.settings, paint);
	}

	override onWillDisappear(ev: WillDisappearEvent<AlertSettings>): void {
		detach(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<AlertSettings>): Promise<void> {
		await repaint(ev.action, ev.payload.settings, paint);
	}

	override async onKeyDown(ev: KeyDownEvent<AlertSettings>): Promise<void> {
		await refresh(ev.action);
	}
}
