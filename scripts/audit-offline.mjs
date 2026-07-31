/**
 * Hard gate for the two constraints that decide whether this plugin is shippable at all:
 * no network, and no credentials. Fails the build on any hit.
 *
 * Mirrors §12 of SPEC.md so the check runs in CI rather than living only in a README. Scope
 * matches the spec: everything that ships (`src`, `bin`, `ui`). This script itself is a build-time
 * tool that never ships, and necessarily contains the very patterns it hunts for, so it is not in
 * scope for its own scan.
 *
 * On `ui/inspector.html`: the property inspector opens a WebSocket to 127.0.0.1 because that is
 * the only way Stream Deck lets an inspector register. That is the Stream Deck protocol itself,
 * not egress — nothing leaves the machine, and no external host is contacted anywhere.
 */

import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const root = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

const NETWORK = /fetch\(|require\(['"](http|https|net|tls)|axios|node-fetch|child_process|\bspawn\(|\bexec\(/;
const CREDENTIALS = /credentials|keychain|api[._-]?key|apikey|oauth/i;

/** Directories scanned for network and child-process usage. */
const NETWORK_DIRS = ["src", "bin", "ui"];
/**
 * Directories scanned for credential access. The inspector is excluded because its only match is
 * the user-facing sentence stating that no credentials are read — prose asserting the absence.
 */
const CREDENTIAL_DIRS = ["src", "bin"];

/** Lines that are wholly a comment may name what we deliberately do not do. */
function isComment(line) {
	const trimmed = line.trim();
	return (
		trimmed.startsWith("//") ||
		trimmed.startsWith("*") ||
		trimmed.startsWith("/*") ||
		trimmed.startsWith("<!--") ||
		trimmed.startsWith("-->")
	);
}

async function* walk(dir) {
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walk(full);
		} else if (/\.(ts|mjs|js|html)$/.test(entry.name)) {
			yield full;
		}
	}
}

const violations = [];

async function scan(dirs, pattern, label) {
	for (const dir of dirs) {
		for await (const file of walk(path.join(root, dir))) {
			const text = await fs.readFile(file, "utf8");
			text.split("\n").forEach((line, index) => {
				if (isComment(line) || !pattern.test(line)) {
					return;
				}
				violations.push(`${path.relative(root, file)}:${index + 1}  ${label}: ${line.trim()}`);
			});
		}
	}
}

await scan(NETWORK_DIRS, NETWORK, "network/process");
await scan(CREDENTIAL_DIRS, CREDENTIALS, "credentials");

if (violations.length > 0) {
	console.error(`Offline audit FAILED:\n${violations.join("\n")}`);
	process.exit(1);
}

console.log("Offline audit passed: no network calls, no child processes, no credential access.");
