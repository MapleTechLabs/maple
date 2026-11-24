/**
 * `mapleSourceMaps()`: a Vite plugin that gives each built JS file a debug id, then moves its
 * source maps out of the deployed output so they are never served. `Maple.SourceMaps` uploads
 * them from there.
 *
 * @example
 * ```typescript
 * // vite.config.ts
 * import { mapleSourceMaps } from "@maple-dev/alchemy/vite"
 *
 * export default defineConfig({ plugins: [mapleSourceMaps()] })
 * ```
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { injectDirectory, relocateMaps } from "@maple/sourcemaps"
import * as Effect from "effect/Effect"
import { Path } from "effect/Path"
import type { Plugin } from "vite"

export interface MapleSourceMapsOptions {
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

/** What one build did: the maps moved and the files the manifest lists. */
export interface MapleSourceMapsResult {
	readonly outDir: string
	readonly mapsDir: string
	readonly moved: number
	readonly files: number
}

/** Runs the inject and the move over a finished build's output directory. */
export const processBuildOutput = (outDir: string, mapsDir: string) =>
	Effect.gen(function* () {
		const results = yield* injectDirectory(outDir, { dryRun: false })
		const relocated = yield* relocateMaps(outDir, mapsDir, results)
		return {
			outDir,
			mapsDir,
			moved: relocated.moved,
			files: relocated.files.length,
		} satisfies MapleSourceMapsResult
	})

/**
 * Requires source maps (`build.sourcemap` becomes `"hidden"` when unset or off, so no public
 * `sourceMappingURL` comment is written), injects debug ids into the written output and moves every
 * `.map` to `mapsDir` with a `maple-sourcemaps.json` manifest. Runs in Node; Bun is not required.
 */
export const mapleSourceMaps = (options: MapleSourceMapsOptions = {}): Plugin => {
	const environments = options.environments ?? ["client"]
	let root = process.cwd()
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
		async writeBundle(outputOptions) {
			const environment = "environment" in this ? this.environment : undefined
			if (environment !== undefined && !environments.includes(environment.name)) return
			const dir = outputOptions.dir
			if (dir === undefined) return
			const program = Effect.gen(function* () {
				const path = yield* Path
				const outDir = path.resolve(root, dir)
				const mapsDir =
					options.mapsDir === undefined
						? path.join(root, ".maple", "sourcemaps", path.basename(outDir))
						: path.resolve(root, options.mapsDir)
				return yield* processBuildOutput(outDir, mapsDir)
			})
			const result = await Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer)))
			this.info(
				`moved ${result.moved} source map(s) to ${result.mapsDir}; ${result.files} file(s) carry a debug id`,
			)
		},
	}
}
