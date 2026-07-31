import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import path from "node:path";
import url from "node:url";
import copy from "rollup-plugin-copy";

const isWatching = !!process.env.ROLLUP_WATCH;
const sdPlugin = "com.revductive.usage-meter.sdPlugin";

/**
 * @type {import('rollup').RollupOptions}
 */
const config = {
	input: "src/plugin.ts",
	output: {
		file: `${sdPlugin}/bin/plugin.js`,
		sourcemap: isWatching,
		sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
			return url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath)).href;
		}
	},
	plugins: [
		{
			name: "watch-externals",
			buildStart: function () {
				this.addWatchFile(`${sdPlugin}/manifest.json`);
				this.addWatchFile("bin/statusline-hook.mjs");
				this.addWatchFile("ui/inspector.html");
			}
		},
		typescript({
			mapRoot: isWatching ? "./" : undefined
		}),
		nodeResolve({
			browser: false,
			exportConditions: ["node"],
			preferBuiltins: true
		}),
		commonjs(),
		copy({
			targets: [
				// The shim is shipped verbatim — it runs under the user's own Node, outside our bundle.
				{ src: "bin/statusline-hook.mjs", dest: `${sdPlugin}/bin` },
				{ src: "ui/inspector.html", dest: `${sdPlugin}/ui` }
			],
			hook: "writeBundle",
			verbose: true
		}),
		!isWatching && terser(),
		{
			name: "emit-module-package-file",
			generateBundle() {
				this.emitFile({ fileName: "package.json", source: `{ "type": "module" }`, type: "asset" });
			}
		}
	]
};

/**
 * Standalone diagnostic bundle. Development tool only — it is written outside the .sdPlugin folder
 * and never ships.
 *
 * @type {import('rollup').RollupOptions}
 */
const diagnostics = {
	input: "src/diagnose.ts",
	output: {
		file: "build/diagnose.mjs",
		format: "es"
	},
	plugins: [
		typescript({ compilerOptions: { sourceMap: false } }),
		nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
		commonjs(),
		copy({
			// Same rate table the plugin uses, so the diagnostic cannot disagree with the dials.
			targets: [{ src: `${sdPlugin}/pricing.json`, dest: "build" }],
			hook: "writeBundle"
		})
	]
};

export default [config, diagnostics];
