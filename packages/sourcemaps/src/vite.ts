// The Vite plugin core both published plugins wrap: `@maple-dev/alchemy/vite` (an Alchemy resource
// uploads later) and `@maple-dev/vite` (uploads itself when the build ends).
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Array as Arr, Effect } from "effect"
import { Path } from "effect/Path"
import type { Plugin } from "vite"
import { type PreparedBuild, prepareBuildOutputs } from "./relocate.ts"

export interface SourceMapsPluginOptions {
	/**
	 * Where the maps go, outside the deployed output. Defaults to
	 * `<root>/.maple/sourcemaps/<outDir basename>`.
	 */
	readonly mapsDir?: string
	/**
	 * The Vite environments whose output is processed. Defaults to `["client"]`: the browser
	 * bundle. A build without the environment API is always processed.
	 */
	readonly environments?: ReadonlyArray<string>
}

/** Vite's plugin logger, handed to the step that runs after the maps are moved. */
export interface PluginLog {
	readonly info: (message: string) => void
	readonly warn: (message: string) => void
	/** Fails the build with this message. */
	readonly error: (message: string) => never
}

/**
 * Requires source maps (`build.sourcemap` becomes `"hidden"` when unset or off, so no public
 * `sourceMappingURL` comment is written). When a build finishes it injects debug ids into every
 * output it wrote, moves each `.map` to `mapsDir` with a `maple-sourcemaps.json` manifest, then
 * runs `afterPrepare` (an upload, for `@maple-dev/vite`). Runs in Node.
 */
export const sourceMapsPlugin = (
	options: SourceMapsPluginOptions,
	afterPrepare?: (build: PreparedBuild, log: PluginLog) => Promise<void>,
): Plugin => {
	const environments = options.environments ?? ["client"]
	let root = process.cwd()
	// Output dirs written in the current build, per environment: several outputs may share a dir.
	const written = new Map<string, Array<string>>()
	// A build without the environment API (Vite 5) has no `environment` on its plugin context.
	const environmentOf = (context: { readonly environment?: { readonly name: string } }) =>
		context.environment?.name
	return {
		name: "maple:source-maps",
		apply: "build",
		config: (config) =>
			config.build?.sourcemap === undefined || config.build.sourcemap === false
				? { build: { sourcemap: "hidden" } }
				: undefined,
		configResolved: (config) => {
			root = config.root
		},
		writeBundle(outputOptions) {
			const environment = environmentOf(this)
			if (environment !== undefined && !environments.includes(environment)) return
			if (outputOptions.dir === undefined) return
			const key = environment ?? ""
			written.set(key, [...(written.get(key) ?? []), outputOptions.dir])
		},
		async closeBundle() {
			const key = environmentOf(this) ?? ""
			const dirs = written.get(key) ?? []
			written.delete(key)
			if (dirs.length === 0) return
			const program = Effect.gen(function* () {
				const path = yield* Path
				const outDirs = Arr.map(dirs, (dir) => path.resolve(root, dir))
				const mapsDir =
					options.mapsDir === undefined
						? path.join(root, ".maple", "sourcemaps", path.basename(outDirs[0] ?? root))
						: path.resolve(root, options.mapsDir)
				return yield* prepareBuildOutputs(outDirs, mapsDir)
			})
			const result = await Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer)))
			this.info(
				`moved ${result.moved} source map(s) to ${result.mapsDir}; ${result.files} file(s) carry a debug id`,
			)
			if (afterPrepare !== undefined)
				await afterPrepare(result, {
					info: (message) => this.info(message),
					warn: (message) => this.warn(message),
					error: (message) => this.error(message),
				})
		},
	}
}
