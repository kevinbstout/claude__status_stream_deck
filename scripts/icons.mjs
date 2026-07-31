/**
 * Rasterize the hand-authored SVGs into every size the Marketplace guidelines require.
 *
 * Build-time only — `sharp` is a devDependency and never ships in the plugin bundle. Emits both
 * `name.png` and `name@2x.png`; the manifest references them without the extension.
 */

import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

import sharp from "sharp";

const root = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const src = path.join(root, "assets", "src");
const out = path.join(root, "com.revductive.usage-meter.sdPlugin", "imgs");

/** [source svg, output basename, @1x size] — the @2x file is always double. */
const TARGETS = [
	["plugin-icon.svg", "plugin-icon", 256],
	["category.svg", "category", 28],
	["action-meter.svg", "action-meter", 20],
	["action-dual.svg", "action-dual", 20],
	["action-spend.svg", "action-spend", 20],
	["action-alert.svg", "action-alert", 20],
	// Key state images reuse the action line-art at key resolution.
	["action-meter.svg", "action-meter-key", 72],
	["action-dual.svg", "action-dual-key", 72],
	["action-spend.svg", "action-spend-key", 72],
	["action-alert.svg", "action-alert-key", 72]
];

async function render(svgPath, basename, size) {
	const svg = await fs.readFile(svgPath);
	for (const [suffix, dimension] of [
		["", size],
		["@2x", size * 2]
	]) {
		const file = path.join(out, `${basename}${suffix}.png`);
		await sharp(svg, { density: Math.max(72, Math.ceil((dimension / 48) * 72)) })
			.resize(dimension, dimension, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
			.png({ compressionLevel: 9 })
			.toFile(file);
	}
}

await fs.mkdir(out, { recursive: true });
for (const [svg, basename, size] of TARGETS) {
	await render(path.join(src, svg), basename, size);
	console.log(`icons: ${basename} ${size}px + @2x`);
}
