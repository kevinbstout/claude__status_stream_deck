import fs from "node:fs";
import path from "node:path";
import url from "node:url";

import { APP_DIR, SETTINGS_BACKUP, claudeSettings } from "../core/paths";

/** Absolute path to the shim, which ships alongside the bundled plugin code. */
export function shimPath(): string {
	const here = path.dirname(url.fileURLToPath(import.meta.url));
	return path.join(here, "statusline-hook.mjs");
}

/** The exact command we write into `settings.json`. */
export function shimCommand(): string {
	return `node "${shimPath()}"`;
}

function isOurs(command: string | undefined): boolean {
	return typeof command === "string" && command.includes("statusline-hook.mjs");
}

function readSettings(): { raw: string; parsed: Record<string, unknown> } | undefined {
	try {
		const raw = fs.readFileSync(claudeSettings(), "utf8");
		if (raw.trim() === "") {
			return { raw, parsed: {} };
		}
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return undefined;
		}
		return { raw, parsed: parsed as Record<string, unknown> };
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
			return { raw: "", parsed: {} };
		}
		return undefined;
	}
}

export type HookStatus = {
	installed: boolean;
	/** The existing statusline command, when it is somebody else's. */
	existing?: string;
	/** True when a foreign statusline command blocks installation. */
	conflict: boolean;
};

/** Report whether our hook is installed, and whether anything is in the way. */
export function inspectHook(): HookStatus {
	const settings = readSettings();
	if (!settings) {
		return { installed: false, conflict: false };
	}
	const statusLine = settings.parsed.statusLine as Record<string, unknown> | undefined;
	const command = typeof statusLine?.command === "string" ? statusLine.command : undefined;
	if (!command) {
		return { installed: false, conflict: false };
	}
	if (isOurs(command)) {
		return { installed: true, conflict: false };
	}
	return { installed: false, existing: command, conflict: true };
}

export type InstallResult = { ok: boolean; reason?: string };

/**
 * Install the statusline hook.
 *
 * Refuses rather than overwriting when the user already has a statusline of their own — the shim
 * cannot chain to it without spawning a child process, so a silent replacement would quietly break
 * their setup. Non-destructive by refusal.
 */
export function installHook(): InstallResult {
	const settings = readSettings();
	if (!settings) {
		return { ok: false, reason: "unreadable" };
	}

	const statusLine = settings.parsed.statusLine as Record<string, unknown> | undefined;
	const command = typeof statusLine?.command === "string" ? statusLine.command : undefined;
	if (command && !isOurs(command)) {
		return { ok: false, reason: "existing" };
	}
	if (isOurs(command)) {
		return { ok: true }; // Idempotent.
	}

	try {
		fs.mkdirSync(APP_DIR, { recursive: true });
		// Back up before any write, so removal can restore the file byte for byte.
		fs.writeFileSync(SETTINGS_BACKUP, settings.raw, "utf8");

		const next = {
			...settings.parsed,
			statusLine: { type: "command", command: shimCommand(), padding: 0 }
		};
		const target = claudeSettings();
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, "utf8");
		return { ok: true };
	} catch {
		return { ok: false, reason: "write-failed" };
	}
}

/** Remove the hook, restoring the backup verbatim when one exists. */
export function uninstallHook(): { ok: boolean } {
	try {
		if (fs.existsSync(SETTINGS_BACKUP)) {
			const backup = fs.readFileSync(SETTINGS_BACKUP, "utf8");
			if (backup.trim() === "") {
				// The user had no settings file before we touched it.
				fs.rmSync(claudeSettings(), { force: true });
			} else {
				fs.writeFileSync(claudeSettings(), backup, "utf8");
			}
			fs.rmSync(SETTINGS_BACKUP, { force: true });
			return { ok: true };
		}

		const settings = readSettings();
		if (!settings) {
			return { ok: false };
		}
		const next = { ...settings.parsed };
		delete next.statusLine;
		fs.writeFileSync(claudeSettings(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
		return { ok: true };
	} catch {
		return { ok: false };
	}
}
