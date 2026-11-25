/**
 * `@maple-dev/vite`: source maps for Maple from any Vite build, no infrastructure tool needed.
 *
 * @example
 * ```typescript
 * // vite.config.ts
 * import { defineConfig } from "vite"
 * import { mapleSourceMaps } from "@maple-dev/vite"
 *
 * export default defineConfig({
 *   plugins: [mapleSourceMaps({ service: "web", release: process.env.GITHUB_SHA })],
 * })
 * ```
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { sourceMapsPlugin } from "@maple/sourcemaps/vite"
import { Array as Arr, Config, ConfigProvider, Effect, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import type { Plugin } from "vite"
import { SourceMapUploadError, type UploadSummary, uploadSourceMaps } from "./upload"

export { SourceMapUploadError, type UploadSummary }

/** The Maple API the maps go to when neither `apiUrl` nor `MAPLE_API_URL` is set. */
export const DEFAULT_API_URL = "https://api.maple.dev"

export interface MapleSourceMapsOptions {
	/** The service the code reports as (OTel `service.name`). Required to upload. */
	readonly service?: string
	/**
	 * The release it reports (OTel `service.version`), such as a commit SHA. Maps whose file has no
	 * debug id are matched by service, release and path, so they are skipped without one.
	 */
	readonly release?: string
	/** A Maple API key with `source_maps:write`. Defaults to `MAPLE_API_KEY`. */
	readonly apiKey?: string
	/** The Maple API base URL. Defaults to `MAPLE_API_URL`, then `https://api.maple.dev`. */
	readonly apiUrl?: string
	/** The path the files are served under, prepended to each file path, e.g. `static/`. */
	readonly urlPrefix?: string
	/**
	 * `"debugId"` (default) files each map under the debug id its file registers, which
	 * `@maple-dev/browser` reports. `"release"` matches by service, release and path instead, for
	 * telemetry that reports no debug ids. Needs `release`.
	 */
	readonly matchBy?: "debugId" | "release"
	/** Set `false` to only inject debug ids and move the maps, and upload them another way. */
	readonly upload?: boolean
	/** Fail the build when an upload fails. Off by default: a failed upload warns and the build ships. */
	readonly failOnError?: boolean
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

const envString = (key: string) =>
	Config.option(Config.String(key)).pipe(Config.map(Option.filter((value) => value.length > 0)))

const given = (value: string | undefined) => Option.filter(Option.fromNullishOr(value), (v) => v.length > 0)

/** What the upload step decided: nothing to do, a reason it could not run, or what it sent. */
type UploadOutcome =
	| { readonly _tag: "off" }
	| { readonly _tag: "notConfigured"; readonly reason: string }
	| { readonly _tag: "failed"; readonly message: string }
	| { readonly _tag: "done"; readonly service: string; readonly summary: UploadSummary }

const runUpload = (options: MapleSourceMapsOptions, mapsDir: string) =>
	Effect.gen(function* () {
		if (options.upload === false) return { _tag: "off" } satisfies UploadOutcome
		const resolvedKey = Option.isSome(given(options.apiKey))
			? given(options.apiKey)
			: yield* envString("MAPLE_API_KEY")
		if (Option.isNone(resolvedKey))
			return { _tag: "notConfigured", reason: "MAPLE_API_KEY is not set" } satisfies UploadOutcome
		const service = given(options.service)
		if (Option.isNone(service))
			return { _tag: "notConfigured", reason: "no service is set" } satisfies UploadOutcome
		const apiUrl = Option.isSome(given(options.apiUrl))
			? given(options.apiUrl)
			: yield* envString("MAPLE_API_URL")
		const baseUrl = Option.getOrElse(apiUrl, () => DEFAULT_API_URL)
		if (!/^https?:\/\//i.test(baseUrl) || !URL.canParse(baseUrl))
			return {
				_tag: "failed",
				message: `the Maple API URL ${baseUrl} is not an http(s) URL; set apiUrl or MAPLE_API_URL to one such as ${DEFAULT_API_URL}`,
			} satisfies UploadOutcome
		const config = {
			apiKey: Redacted.make(resolvedKey.value),
			apiUrl: baseUrl,
			service: service.value,
			release: Option.getOrUndefined(given(options.release)),
			urlPrefix: options.urlPrefix,
			matchBy: options.matchBy,
		}
		return yield* uploadSourceMaps(mapsDir, config).pipe(
			Effect.map((summary): UploadOutcome => ({ _tag: "done", service: service.value, summary })),
			Effect.catchTag("@maple/sourcemaps/SourceMapsFileError", (error) =>
				Effect.succeed<UploadOutcome>({
					_tag: "failed",
					message: `could not read the source maps in ${mapsDir}: ${error.message}`,
				}),
			),
		)
	})

/**
 * A Vite plugin that turns on hidden source maps, gives each built JS file a debug id, moves the
 * maps out of the deployed output so they are never served, then uploads them to Maple.
 *
 * Without an API key (no `apiKey`, no `MAPLE_API_KEY`) or a `service`, as in a local build, it
 * warns and keeps the maps on disk. The first build with the plugin changes chunk contents without changing their
 * hashed names, so a browser or CDN that cached a chunk may serve the old copy for that release.
 */
export const mapleSourceMaps = (options: MapleSourceMapsOptions = {}): Plugin =>
	sourceMapsPlugin({ mapsDir: options.mapsDir, environments: options.environments }, async (build, log) => {
		// The plugin's own entry point: the build hook is where this Effect program runs.
		const outcome = await Effect.runPromise(
			runUpload(options, build.mapsDir).pipe(
				Effect.provide([
					NodeServices.layer,
					FetchHttpClient.layer,
					// Effect's default provider reads the environment once per process; a second
					// build (watch mode, a script that sets the key later) must see it as it is now.
					// @effect-diagnostics-next-line processEnv:off -- the plugin entry point snapshots the env per build
					ConfigProvider.layer(ConfigProvider.fromEnvRecord({ ...process.env })),
				]),
			),
		)
		const fail = (message: string) =>
			options.failOnError === true ? log.error(message) : log.warn(message)
		switch (outcome._tag) {
			case "off":
				return
			case "notConfigured":
				return log.warn(`${outcome.reason}: source maps were kept in ${build.mapsDir}, not uploaded.`)
			case "failed":
				return fail(outcome.message)
			case "done": {
				const { summary } = outcome
				Arr.forEach(summary.skipped, (skip) =>
					log.warn(`skipped the source map for ${skip.minifiedPath}: ${skip.reason}`),
				)
				Arr.forEach(summary.failed, (failure) =>
					log.warn(
						`could not upload the source map for ${failure.minifiedPath}: ${failure.message}`,
					),
				)
				log.info(`uploaded ${summary.uploaded} source map(s) for ${outcome.service} to Maple`)
				if (summary.failed.length > 0) fail(`${summary.failed.length} source map upload(s) failed`)
			}
		}
	})
