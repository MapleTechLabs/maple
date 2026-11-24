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
import { Array as Arr } from "effect"
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
	readonly outDirs: ReadonlyArray<string>
	readonly mapsDir: string
	readonly moved: number
	readonly files: number
}

/** Injects every output, then moves their maps to `mapsDir` under one manifest. */
export const processBuildOutputs = (outDirs: ReadonlyArray<string>, mapsDir: string) =>
	Effect.gen(function* () {
		const outputs = yield* Effect.forEach(Arr.dedupe(outDirs), (outDir) =>
			Effect.map(injectDirectory(outDir, { dryRun: false }), (results) => ({ outDir, results })),
		)
		const relocated = yield* relocateMaps(mapsDir, outputs)
		return {
			outDirs: Arr.map(outputs, (output) => output.outDir),
			mapsDir,
			moved: relocated.moved,
			files: relocated.files.length,
		} satisfies MapleSourceMapsResult
	})

/**
 * Requires source maps (`build.sourcemap` becomes `"hidden"` when unset or off, so no public
 * `sourceMappingURL` comment is written). When a build finishes it injects debug ids into every
 * output it wrote and moves each `.map` to `mapsDir` with a `maple-sourcemaps.json` manifest. Runs
 * in Node; Bun is not required.
 *
 * The first deploy with the plugin changes chunk contents without changing their hashed names
 * (the injection runs after Rollup names them), so a browser or CDN that cached a chunk from the
 * build before may still serve it unshifted for that one release. Later builds are deterministic,
 * so it does not recur.
 */
export const mapleSourceMaps = (options: MapleSourceMapsOptions = {}): Plugin => {
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
				return yield* processBuildOutputs(outDirs, mapsDir)
			})
			const result = await Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer)))
			this.info(
				`moved ${result.moved} source map(s) to ${result.mapsDir}; ${result.files} file(s) carry a debug id`,
			)
		},
	}
}
