import streamDeck, { type Action, type DialAction, type KeyAction } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { currentSnapshot, forceRefresh, subscribe } from "../core/poller";
import type { Snapshot } from "../core/snapshot";

export const USAGE_URL = "https://claude.ai/settings/usage";

/**
 * Shared plumbing for the four actions.
 *
 * This is deliberately a set of free functions rather than a base class: the `@action` decorator
 * rewrites the class type, and members added by a subclass of a shared base do not survive that
 * rewrite. Every action stays a direct `SingletonAction` subclass, and the shared state lives here.
 */

/** Live subscriptions, keyed by action instance id. */
const subscriptions = new Map<string, () => void>();

/**
 * Last known settings per action instance.
 *
 * Stream Deck hands us settings with `willAppear` and again on every `didReceiveSettings`, so they
 * are always already in hand. Caching them keeps `getSettings()` — an async round-trip over the
 * websocket — out of the render path entirely. Calling it once per action per poll tick was both
 * needless traffic and a way for a single unresolved promise to freeze a dial on its first frame.
 */
const settingsCache = new Map<string, JsonObject>();

export type Painter<T extends JsonObject> = (
	action: DialAction<T> | KeyAction<T>,
	snapshot: Snapshot,
	settings: T
) => void | Promise<void>;

/**
 * Subscribe an action instance to the shared poller and paint it immediately.
 *
 * The refresh loop only runs while at least one instance is on screen, so an unplaced plugin costs
 * nothing.
 */
export function attach<T extends JsonObject>(
	action: DialAction<T> | KeyAction<T>,
	settings: T,
	paint: Painter<T>
): void {
	detach(action.id);
	settingsCache.set(action.id, settings ?? ({} as T));
	const unsubscribe = subscribe((snapshot) => {
		void render(action, snapshot, undefined, paint);
	});
	subscriptions.set(action.id, unsubscribe);
	void render(action, currentSnapshot(), settings, paint);
}

/** Drop an action instance's subscription and cached settings. */
export function detach(actionId: string): void {
	subscriptions.get(actionId)?.();
	subscriptions.delete(actionId);
	settingsCache.delete(actionId);
}

/**
 * Paint one instance.
 *
 * Settings come from the caller or the cache — never from a fresh `getSettings()` call, which would
 * put an await on the websocket in front of every frame.
 *
 * Never throws: a render failure is logged by type only and the dial keeps its previous frame.
 */
export async function render<T extends JsonObject>(
	action: DialAction<T> | KeyAction<T>,
	snapshot: Snapshot,
	settings: T | undefined,
	paint: Painter<T>
): Promise<void> {
	try {
		const resolved = settings ?? ((settingsCache.get(action.id) as T | undefined) ?? ({} as T));
		if (settings !== undefined) {
			settingsCache.set(action.id, settings);
		}
		await paint(action, snapshot, resolved);
	} catch (error) {
		// Log the failure type only — never contents, paths, or session identifiers.
		streamDeck.logger.error(`render failed: ${(error as Error)?.name ?? "Error"}`);
	}
}

/** Repaint one instance from the latest snapshot, typically after a settings change. */
export async function repaint<T extends JsonObject>(
	action: DialAction<T> | KeyAction<T>,
	settings: T,
	paint: Painter<T>
): Promise<void> {
	await render(action, currentSnapshot(), settings, paint);
}

/**
 * Apply changed settings: cache them, repaint immediately, then persist.
 *
 * The order matters. Persisting is a websocket round-trip, and awaiting it before painting is what
 * made dial rotation appear dead — the repaint sat behind a promise that never settled, and because
 * the cache is only written on a successful render, the next poll tick redrew the old metric too.
 * The user's turn of the dial must be visible whether or not Stream Deck acknowledges the write.
 */
export async function applySettings<T extends JsonObject>(
	action: DialAction<T> | KeyAction<T>,
	settings: T,
	paint: Painter<T>
): Promise<void> {
	settingsCache.set(action.id, settings);
	await render(action, currentSnapshot(), settings, paint);
	void action.setSettings(settings).catch(() => {
		streamDeck.logger.error("setSettings failed");
	});
}

/** Force a refresh, acknowledging on the key where the SDK offers an OK indicator. */
export async function refresh<T extends JsonObject>(action: Action<T>): Promise<void> {
	try {
		await forceRefresh();
		if (action.isKey()) {
			await action.showOk();
		}
	} catch {
		await action.showAlert();
	}
}

/** Open the usage page in the user's default browser. */
export async function openUsagePage(): Promise<void> {
	try {
		await streamDeck.system.openUrl(USAGE_URL);
	} catch {
		/* nothing actionable */
	}
}

/** Cycle through a list of options by dial ticks, wrapping in both directions. */
export function cycle<T>(options: readonly T[], current: T, ticks: number): T {
	const index = options.indexOf(current);
	const from = index === -1 ? 0 : index;
	const step = ticks > 0 ? 1 : -1;
	const next = (from + step + options.length) % options.length;
	return options[next]!;
}
