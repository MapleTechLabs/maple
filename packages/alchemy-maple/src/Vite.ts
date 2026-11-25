/**
 * `mapleSourceMaps()`: a Vite plugin that gives each built JS file a debug id, then moves its
 * source maps out of the deployed output so they are never served. `Maple.SourceMaps` uploads
 * them from there. Without Alchemy, `@maple-dev/vite` uploads them at the end of the build instead.
 *
 * @example
 * ```typescript
 * // vite.config.ts
 * import { mapleSourceMaps } from "@maple-dev/alchemy/vite"
 *
 * export default defineConfig({ plugins: [mapleSourceMaps()] })
 * ```
 */
import { type PreparedBuild, prepareBuildOutputs } from "@maple/sourcemaps"
import { type SourceMapsPluginOptions, sourceMapsPlugin } from "@maple/sourcemaps/vite"
import type { Plugin } from "vite"

export type MapleSourceMapsOptions = SourceMapsPluginOptions

/** What one build did: the maps moved and the files the manifest lists. */
export type MapleSourceMapsResult = PreparedBuild

/** Injects every output, then moves their maps to `mapsDir` under one manifest. */
export const processBuildOutputs = prepareBuildOutputs

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
export const mapleSourceMaps = (options: MapleSourceMapsOptions = {}): Plugin => sourceMapsPlugin(options)
