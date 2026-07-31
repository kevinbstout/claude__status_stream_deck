import {
	type DialAction,
	type DialDownEvent,
	type KeyAction,
	SingletonAction,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
	action
} from "@elgato/streamdeck";

import { pct } from "../core/format";
import type { Snapshot } from "../core/snapshot";
import { bandFor, colorFor } from "../render/colors";
import { attach, detach, openUsagePage, refresh } from "./base";

/** No settings — this action is deliberately not configurable. */
export type DualSettings = { readonly _?: never };

async function paint(
	target: DialAction<DualSettings> | KeyAction<DualSettings>,
	snapshot: Snapshot
): Promise<void> {
	if (!target.isDial()) {
		return;
	}

	const five = snapshot.fiveHour.usedPct;
	const seven = snapshot.sevenDay.usedPct;
	const stale = snapshot.stale && snapshot.hasLimitData;
	const heading = snapshot.hasLimitData ? `${stale ? "○ " : ""}Claude usage` : "Claude usage — no data";

	await target.setFeedback({
		heading,
		label1: "Session",
		value1: pct(five),
		bar1: { value: Math.round(five ?? 0), bar_fill_c: colorFor(bandFor(five)) },
		label2: "Weekly",
		value2: pct(seven),
		bar2: { value: Math.round(seven ?? 0), bar_fill_c: colorFor(bandFor(seven)) }
	});
}

/** Session over weekly, both bars in one encoder slot — the whole story at a glance. */
@action({ UUID: "com.revductive.usage-meter.dual" })
export class DualMeter extends SingletonAction<DualSettings> {
	override onWillAppear(ev: WillAppearEvent<DualSettings>): void {
		attach(ev.action, ev.payload.settings, paint);
	}

	override onWillDisappear(ev: WillDisappearEvent<DualSettings>): void {
		detach(ev.action.id);
	}

	override async onDialDown(ev: DialDownEvent<DualSettings>): Promise<void> {
		await refresh(ev.action);
	}

	override async onTouchTap(ev: TouchTapEvent<DualSettings>): Promise<void> {
		if (ev.payload.hold) {
			await openUsagePage();
		}
	}
}
