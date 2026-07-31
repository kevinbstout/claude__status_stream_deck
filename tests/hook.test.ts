import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SETTINGS_BACKUP, claudeSettings, setClaudeDirOverride } from "../src/core/paths";
import { inspectHook, installHook, shimCommand, uninstallHook } from "../src/hook/install";

let fakeClaude: string;

beforeEach(() => {
	fakeClaude = fs.mkdtempSync(path.join(os.tmpdir(), "aum-claude-"));
	setClaudeDirOverride(fakeClaude);
	fs.rmSync(SETTINGS_BACKUP, { force: true });
});

afterEach(() => {
	setClaudeDirOverride(undefined);
	fs.rmSync(fakeClaude, { recursive: true, force: true });
	fs.rmSync(SETTINGS_BACKUP, { force: true });
});

function writeSettings(contents: string): void {
	fs.writeFileSync(claudeSettings(), contents, "utf8");
}

function readSettings(): string {
	return fs.readFileSync(claudeSettings(), "utf8");
}

describe("inspectHook", () => {
	it("reports not installed when there is no settings file at all", () => {
		expect(inspectHook()).toEqual({ installed: false, conflict: false });
	});

	it("reports not installed when settings exist without a statusline", () => {
		writeSettings('{"model":"opus"}');
		expect(inspectHook()).toEqual({ installed: false, conflict: false });
	});

	it("reports a conflict when somebody else owns the statusline", () => {
		writeSettings('{"statusLine":{"type":"command","command":"my-own-script.sh"}}');
		const status = inspectHook();
		expect(status.conflict).toBe(true);
		expect(status.installed).toBe(false);
		expect(status.existing).toBe("my-own-script.sh");
	});

	it("recognizes its own hook", () => {
		installHook();
		expect(inspectHook()).toEqual({ installed: true, conflict: false });
	});
});

describe("installHook", () => {
	it("writes the statusline command into a fresh settings file", () => {
		expect(installHook()).toEqual({ ok: true });
		const parsed = JSON.parse(readSettings());
		expect(parsed.statusLine).toEqual({ type: "command", command: shimCommand(), padding: 0 });
	});

	it("preserves every other key", () => {
		writeSettings('{"model":"opus","permissions":{"allow":["Bash"]}}');
		installHook();
		const parsed = JSON.parse(readSettings());
		expect(parsed.model).toBe("opus");
		expect(parsed.permissions).toEqual({ allow: ["Bash"] });
	});

	it("refuses rather than clobbering an existing statusline", () => {
		const original = '{"statusLine":{"type":"command","command":"my-own-script.sh"}}';
		writeSettings(original);
		expect(installHook()).toEqual({ ok: false, reason: "existing" });
		// Non-destructive by refusal: the file is untouched.
		expect(readSettings()).toBe(original);
	});

	it("is idempotent", () => {
		installHook();
		const afterFirst = readSettings();
		expect(installHook()).toEqual({ ok: true });
		expect(readSettings()).toBe(afterFirst);
	});

	it("backs up before writing", () => {
		writeSettings('{"model":"opus"}');
		installHook();
		expect(fs.readFileSync(SETTINGS_BACKUP, "utf8")).toBe('{"model":"opus"}');
	});
});

describe("uninstallHook", () => {
	it("restores the backup byte for byte", () => {
		// Deliberately idiosyncratic formatting — a restore that reformats is not a restore.
		const original = '{\n    "model":   "opus",\n\t"env": {"A":"b"}\n}\n';
		writeSettings(original);
		installHook();
		expect(readSettings()).not.toBe(original);

		expect(uninstallHook()).toEqual({ ok: true });
		expect(readSettings()).toBe(original);
		expect(fs.existsSync(SETTINGS_BACKUP)).toBe(false);
	});

	it("removes the settings file entirely when there was none before", () => {
		installHook();
		expect(fs.existsSync(claudeSettings())).toBe(true);
		uninstallHook();
		expect(fs.existsSync(claudeSettings())).toBe(false);
	});

	it("drops only the statusLine key when no backup survives", () => {
		writeSettings('{"model":"opus","statusLine":{"type":"command","command":"x/statusline-hook.mjs"}}');
		fs.rmSync(SETTINGS_BACKUP, { force: true });
		expect(uninstallHook()).toEqual({ ok: true });
		const parsed = JSON.parse(readSettings());
		expect(parsed.statusLine).toBeUndefined();
		expect(parsed.model).toBe("opus");
	});
});
