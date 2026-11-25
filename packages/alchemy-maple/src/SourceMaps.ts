import { createHash } from "node:crypto"
import {
	type PlannedMap,
	planMaps,
	skipReason,
	uploadBody,
	uploadedDebugIds,
	uploadParams,
} from "@maple/sourcemaps"
import { Array as Arr, Effect, Option, Order } from "effect"
import type { FileSystem } from "effect/FileSystem"
import type { Path } from "effect/Path"
import { isResolved } from "alchemy/Diff"
import * as Provider from "alchemy/Provider"
import { Resource } from "alchemy/Resource"
import { MapleSourceMapsReadError } from "./errors"
import { MapleApi } from "./MapleApi"
import type { Providers } from "./Providers"

export interface SourceMapsProps {
	/**
	 * The directory holding the maps: the Vite plugin's `mapsDir` (with its manifest), or any
	 * build output where each JS file has its map beside it.
	 */
	dir: string
	/** The service the code reports as (OTel `service.name`). */
	service: string
	/**
	 * The release it reports (OTel `service.version`). Maps without a debug id are matched by
	 * service, release and path, so they are skipped without one.
	 */
	release?: string
	/** The path the files are served under, prepended to each file path, e.g. `static/`. */
	urlPrefix?: string
	/**
	 * Any value from the build this follows, such as a Worker's asset hash: it orders the upload
	 * after the build and re-checks the maps when the build changes. Not uploaded.
	 */
	after?: unknown
	/**
	 * How stacks find these maps. `"debugId"` (default) uploads each map under the debug id its file
	 * registers, for SDKs that report debug ids. `"release"` uploads without them, matched by service,
	 * release and path: for telemetry that sends no debug ids, where a chunk shared by two releases
	 * would otherwise keep one row under one release. Needs `release`.
	 */
	matchBy?: "debugId" | "release"
}

export type SourceMaps = Resource<
	"Maple.SourceMaps",
	SourceMapsProps,
	{
		/** Maps uploaded by the last reconcile that found changed maps. */
		uploaded: number
		/** The debug ids among them. */
		debugIds: ReadonlyArray<string>
		/** A digest of the maps and the props they were uploaded under; unchanged, nothing uploads. */
		digest: string
	},
	never,
	Providers
>

/**
 * Uploads a build's JavaScript source maps to Maple so error stacks show original source. Runs
 * after the build, and uploads again only when the maps (or service, release or prefix) changed.
 * Needs an API key with `source_maps:write`.
 *
 * Deleting it uploads nothing and deletes nothing on purpose: errors from earlier releases still
 * need their maps, and the server deletes maps no stack has used for 90 days.
 *
 * @example
 * ```typescript
 * const web = yield* Cloudflare.Website.Vite("web")
 * yield* Maple.SourceMaps("web-sourcemaps", {
 *   dir: ".maple/sourcemaps/client",
 *   service: "web",
 *   release: process.env.GITHUB_SHA,
 *   after: web.hash,
 * })
 * ```
 */
export const SourceMaps = Resource<SourceMaps>("Maple.SourceMaps")

export { minifiedPathFor } from "@maple/sourcemaps"

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex")

/** Changes when any map, its path or debug id, or the props it uploads under change. */
export const sourceMapsDigest = (props: SourceMapsProps, maps: ReadonlyArray<PlannedMap>): string =>
	sha256(
		Arr.join(
			[
				props.service,
				props.release ?? "",
				props.urlPrefix ?? "",
				props.matchBy ?? "debugId",
				...Arr.map(
					Arr.sort(
						maps,
						Order.mapInput(Order.String, (map: PlannedMap) => map.minifiedPath),
					),
					(map) =>
						Arr.join(
							[map.minifiedPath, Option.getOrElse(map.debugId, () => ""), sha256(map.bytes)],
							"\u0001",
						),
				),
			],
			"\u0000",
		),
	)

export const SourceMapsProvider = () =>
	Provider.effect(
		SourceMaps,
		Effect.gen(function* () {
			const api = yield* MapleApi
			const platform = yield* Effect.context<FileSystem | Path>()
			const plan = (props: SourceMapsProps) =>
				planMaps(props.dir, props.urlPrefix).pipe(
					Effect.mapBoth({
						onSuccess: (maps) => ({ maps, digest: sourceMapsDigest(props, maps) }),
						onFailure: (cause) =>
							new MapleSourceMapsReadError({
								message: `Could not read source maps in ${props.dir}`,
								path: props.dir,
								cause,
							}),
					}),
					Effect.provide(platform),
				)
			// A redeploy of an unchanged build skips the bundler, so no maps were written this run.
			const warnNoMaps = (props: SourceMapsProps) =>
				Effect.logWarning(
					`No source maps in ${props.dir}: the build did not run in this deploy, so nothing was uploaded. The next deploy that builds uploads them.`,
				)
			return {
				// The maps on disk decide: a build that changed them updates, one that did not is a noop.
				diff: Effect.fn(function* ({ news, output }) {
					if (output === undefined || !isResolved(news)) return undefined
					const planned = yield* plan(news)
					if (planned.maps.length === 0) {
						yield* warnNoMaps(news)
						return { action: "noop" } as const
					}
					return planned.digest === output.digest
						? ({ action: "noop" } as const)
						: ({ action: "update", stables: [] } as const)
				}),
				reconcile: Effect.fn(function* ({ news, output }) {
					const planned = yield* plan(news)
					// No maps here (a build that was skipped): keep what the last upload recorded.
					if (planned.maps.length === 0) {
						yield* warnNoMaps(news)
						return output ?? { uploaded: 0, debugIds: [], digest: planned.digest }
					}
					if (output !== undefined && output.digest === planned.digest) return output
					const sendable = yield* Effect.filter(planned.maps, (map) =>
						Option.match(skipReason(news, map), {
							onNone: () => Effect.succeed(true),
							onSome: (reason) =>
								Effect.as(
									Effect.logWarning(
										`Skipped the source map for ${map.minifiedPath}: ${reason}`,
									),
									false,
								),
						}),
					)
					yield* Effect.forEach(
						sendable,
						(map) =>
							api.upload(
								`/v2/source_maps?${new URLSearchParams(uploadParams(news, map)).toString()}`,
								uploadBody(news, map),
								"application/json",
							),
						{ concurrency: 4, discard: true },
					)
					yield* Effect.logInfo(`Uploaded ${sendable.length} source map(s) for ${news.service}`)
					return {
						uploaded: sendable.length,
						debugIds: uploadedDebugIds(news, sendable),
						digest: planned.digest,
					}
				}),
				// Earlier releases still need their maps; the server's retention removes unused ones.
				delete: () => Effect.void,
			}
		}),
	)
