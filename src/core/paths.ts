import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = os.homedir();

export const CLAUDE_DIR = path.join(home, ".claude");
export const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, "settings.json");
export const CLAUDE_PROJECTS = path.join(CLAUDE_DIR, "projects");

// Shared between the shim and the plugin. Both must derive it identically.
export const APP_DIR =
	process.platform === "win32"
		? path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "agent-usage-meter")
		: path.join(home, ".config", "agent-usage-meter");

/**
 * Candidate locations for Claude desktop's application data, which holds `plan-usage-history.json`
 * — the app's own record of plan allowance utilisation across every Claude surface.
 *
 * On Windows this is not simply `%APPDATA%\Claude`. When Claude desktop is installed as a packaged
 * (MSIX) app, that entry is a redirection link and the real data lives inside the package
 * container at `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude`. Processes that do not
 * resolve the link — Stream Deck's plugin host among them — simply do not see the folder at all,
 * and `existsSync` reports false for a file that is plainly there. So probe both, real location
 * included, rather than trusting the link.
 */
export function claudeDesktopCandidates(): string[] {
	if (process.platform === "darwin") {
		return [path.join(home, "Library", "Application Support", "Claude")];
	}
	if (process.platform !== "win32") {
		return [path.join(home, ".config", "Claude")];
	}

	const roaming = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
	const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
	const candidates = [path.join(roaming, "Claude")];

	// The package folder carries a publisher hash suffix, so match by prefix rather than hardcode it.
	try {
		const packages = path.join(local, "Packages");
		for (const name of fs.readdirSync(packages)) {
			if (name.startsWith("Claude")) {
				candidates.push(path.join(packages, name, "LocalCache", "Roaming", "Claude"));
			}
		}
	} catch {
		// No packaged install, or the directory is unreadable; the plain path may still work.
	}
	return candidates;
}

/** The first candidate that actually contains the usage history, else the conventional location. */
export function claudeDesktopDir(): string {
	const candidates = claudeDesktopCandidates();
	for (const dir of candidates) {
		if (fs.existsSync(path.join(dir, "plan-usage-history.json"))) {
			return dir;
		}
	}
	return candidates[0]!;
}

export const STATE_FILE = path.join(APP_DIR, "state.json");
export const HOOK_CONFIG_FILE = path.join(APP_DIR, "hook-config.json");
export const SETTINGS_BACKUP = path.join(APP_DIR, "settings.json.bak");

/**
 * User-supplied override for the Claude Code data directory, set from the Property Inspector.
 * Empty or unset means "use the default".
 */
let claudeDirOverride: string | undefined;

export function setClaudeDirOverride(dir: string | undefined): void {
	const trimmed = dir?.trim();
	claudeDirOverride = trimmed ? trimmed : undefined;
}

export function getClaudeDirOverride(): string | undefined {
	return claudeDirOverride;
}

/** The active Claude Code directory — the PI override wins over the default. */
export function claudeDir(): string {
	return claudeDirOverride ?? CLAUDE_DIR;
}

/** The active `settings.json`, honouring the directory override. */
export function claudeSettings(): string {
	return path.join(claudeDir(), "settings.json");
}

/** The active transcript root, honouring the directory override. */
export function claudeProjects(): string {
	return path.join(claudeDir(), "projects");
}

/** User-supplied override for the Claude desktop data directory. */
let desktopDirOverride: string | undefined;

export function setDesktopDirOverride(dir: string | undefined): void {
	const trimmed = dir?.trim();
	desktopDirOverride = trimmed ? trimmed : undefined;
}

export function getDesktopDirOverride(): string | undefined {
	return desktopDirOverride;
}

/** Claude desktop's plan usage history file, honouring the override. */
export function planUsageFile(): string {
	return path.join(desktopDirOverride ?? claudeDesktopDir(), "plan-usage-history.json");
}

/**
 * Which candidate location supplied the usage history, for logging.
 *
 * Reported as an index rather than a path: the resolved location contains the account name and the
 * installed package identifier, and plugin logs sit in plaintext on disk.
 */
export function planUsageSourceIndex(): string {
	if (desktopDirOverride) {
		return "override";
	}
	const candidates = claudeDesktopCandidates();
	const active = claudeDesktopDir();
	const index = candidates.indexOf(active);
	return `${index + 1}/${candidates.length}`;
}
