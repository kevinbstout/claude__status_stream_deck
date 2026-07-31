import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { claudeDesktopCandidates, planUsageFile, setDesktopDirOverride } from "../src/core/paths";

afterEach(() => {
	setDesktopDirOverride(undefined);
});

describe("claudeDesktopCandidates", () => {
	it("always offers at least the conventional location", () => {
		const candidates = claudeDesktopCandidates();
		expect(candidates.length).toBeGreaterThan(0);
		expect(candidates[0]!.endsWith(`${path.sep}Claude`)).toBe(true);
	});

	it.runIf(process.platform === "win32")(
		"also offers the packaged-app container, which the Roaming link hides from some processes",
		() => {
			// `%APPDATA%\Claude` is a redirection link when Claude desktop is installed as an MSIX
			// package. Processes that do not resolve it — Stream Deck's plugin host among them — see
			// no such folder at all, so the real location under Packages must be probed directly.
			const candidates = claudeDesktopCandidates();
			const packaged = candidates.filter((c) => c.includes(`${path.sep}Packages${path.sep}`));
			for (const dir of packaged) {
				expect(dir).toContain(`${path.sep}LocalCache${path.sep}Roaming${path.sep}Claude`);
			}
			// On a machine with the packaged app installed there must be one; otherwise the plain
			// path stands alone and that is equally valid.
			const packagesRoot = path.join(
				process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
				"Packages"
			);
			let hasPackagedClaude = false;
			try {
				hasPackagedClaude = fs.readdirSync(packagesRoot).some((n) => n.startsWith("Claude"));
			} catch {
				hasPackagedClaude = false;
			}
			expect(packaged.length > 0).toBe(hasPackagedClaude);
		}
	);

	it("never returns duplicates", () => {
		const candidates = claudeDesktopCandidates();
		expect(new Set(candidates).size).toBe(candidates.length);
	});
});

describe("planUsageFile", () => {
	it("points at the history file", () => {
		expect(path.basename(planUsageFile())).toBe("plan-usage-history.json");
	});

	it("honours an explicit override over any discovered location", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aum-desktop-"));
		try {
			setDesktopDirOverride(dir);
			expect(planUsageFile()).toBe(path.join(dir, "plan-usage-history.json"));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("treats a blank override as unset", () => {
		setDesktopDirOverride("   ");
		expect(planUsageFile()).not.toBe(path.join("   ", "plan-usage-history.json"));
	});
});
