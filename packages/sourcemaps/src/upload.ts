// What a source map upload sends: the maps a directory holds, the path and debug id each goes under,
// and why one is skipped. Shared by the Alchemy `Maple.SourceMaps` resource and `@maple-dev/vite`.
import { Array as Arr, Effect, Option, Result, Schema, String as Str } from "effect"
import { FileSystem } from "effect/FileSystem"
import { Path } from "effect/Path"
import {
	existingDebugId,
	fileError,
	findJsFiles,
	isIndexMap,
	mapDebugId,
	mapsNoSources,
	mapUsers,
} from "./inject.ts"
import { SOURCE_MAP_MAX_BYTES } from "./limits.ts"
import { MANIFEST_FILE, SourceMapsManifest } from "./relocate.ts"

/** Where uploaded maps are filed: the service and release that report the code. */
export interface UploadTarget {
	/** The service the code reports as (OTel `service.name`). */
	readonly service: string
	/** The release it reports (OTel `service.version`). */
	readonly release?: string | undefined
	/** The path the files are served under, prepended to each file path, e.g. `static/`. */
	readonly urlPrefix?: string | undefined
	/**
	 * `"debugId"` (default) files each map under the debug id its file registers. `"release"` files
	 * them by service, release and path, for telemetry that reports no debug ids.
	 */
	readonly matchBy?: "debugId" | "release" | undefined
}

/** One map ready to upload. */
export interface PlannedMap {
	readonly minifiedPath: string
	readonly debugId: Option.Option<string>
	readonly bytes: Uint8Array
}

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(SourceMapsManifest))

/** The served path of a file below the deploy root, `urlPrefix` first, never with a leading slash. */
export const minifiedPathFor = (urlPrefix: string | undefined, file: string): string => {
	const prefix = urlPrefix ?? ""
	const joined = prefix === "" || Str.endsWith("/")(prefix) ? `${prefix}${file}` : `${prefix}/${file}`
	return Str.replace(/^(?:~\/|\/)+/, "")(joined)
}

/**
 * Every map in `dir` with the path and debug id it uploads under: from the manifest the Vite plugin
 * writes, else every JS file with its map beside it. None when `dir` is absent.
 */
export const planMaps = (dir: string, urlPrefix: string | undefined) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem
		const path = yield* Path
		if (!(yield* fs.exists(dir).pipe(Effect.mapError(fileError(dir, "read"))))) return []
		const manifestPath = path.join(dir, MANIFEST_FILE)
		if (yield* fs.exists(manifestPath).pipe(Effect.mapError(fileError(manifestPath, "read")))) {
			const manifest = yield* fs
				.readFileString(manifestPath)
				.pipe(Effect.flatMap(decodeManifest), Effect.mapError(fileError(manifestPath, "read")))
			return yield* Effect.forEach(manifest.files, (entry) => {
				const mapPath = path.join(dir, entry.map)
				return Effect.mapBoth(fs.readFile(mapPath), {
					onFailure: fileError(mapPath, "read"),
					onSuccess: (bytes): PlannedMap => ({
						minifiedPath: minifiedPathFor(urlPrefix, entry.file),
						debugId: Option.fromNullishOr(entry.debugId),
						bytes,
					}),
				})
			})
		}
		const files = yield* findJsFiles(dir)
		const users = mapUsers(files)
		return yield* Effect.forEach(
			Arr.flatMap(files, (js) =>
				Option.toArray(Option.map(js.mapPath, (mapPath) => ({ js, mapPath }))),
			),
			({ js, mapPath }) =>
				Effect.mapBoth(fs.readFile(mapPath), {
					onFailure: fileError(mapPath, "read"),
					onSuccess: (bytes): PlannedMap => {
						const shared = (users.get(mapPath) ?? 0) > 1
						return {
							minifiedPath: minifiedPathFor(urlPrefix, js.file),
							// The file's own id; a shared map's id belongs to no one file.
							debugId: Option.orElse(existingDebugId(js.code), () =>
								shared ? Option.none() : mapDebugId(new TextDecoder().decode(bytes)),
							),
							bytes,
						}
					},
				}),
		)
	})

const byRelease = (target: UploadTarget) => target.matchBy === "release"
const hasRelease = (target: UploadTarget) => target.release !== undefined && target.release !== ""

/** Why a map is not uploaded, or none when it is. */
export const skipReason = (target: UploadTarget, map: PlannedMap): Option.Option<string> => {
	if (map.bytes.byteLength > SOURCE_MAP_MAX_BYTES) return Option.some("it is over 10 MiB")
	const text = new TextDecoder().decode(map.bytes)
	if (isIndexMap(text)) return Option.some("index source maps are not supported")
	if (mapsNoSources(text)) return Option.some("it maps no sources")
	if (byRelease(target) && !hasRelease(target)) return Option.some('`matchBy: "release"` needs a release')
	if (Option.isNone(map.debugId) && !hasRelease(target))
		return Option.some("it has no debug id and no release is set")
	return Option.none()
}

/** The `POST /v2/source_maps` query parameters for one map. */
export const uploadParams = (target: UploadTarget, map: PlannedMap): ReadonlyArray<[string, string]> => [
	["minified_path", map.minifiedPath],
	["service", target.service],
	...(!byRelease(target) && Option.isSome(map.debugId)
		? [["debug_id", map.debugId.value] satisfies [string, string]]
		: []),
	...(hasRelease(target) ? [["version", target.release ?? ""] satisfies [string, string]] : []),
]

const MapJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeMapJson = Schema.decodeUnknownResult(MapJson)
const encodeMapJson = Schema.encodeResult(MapJson)

/**
 * The body to upload. Matched by release, the map's own `debugId` / `debug_id` go too, or the server
 * would file it under that id and one release's upload would replace another's.
 */
export const uploadBody = (target: UploadTarget, map: PlannedMap): Uint8Array => {
	if (!byRelease(target)) return map.bytes
	return Result.match(
		Result.flatMap(
			decodeMapJson(new TextDecoder().decode(map.bytes)),
			({ debugId: _a, debug_id: _b, ...rest }) => encodeMapJson(rest),
		),
		{ onFailure: () => map.bytes, onSuccess: (text) => new TextEncoder().encode(text) },
	)
}

/** The debug ids a set of uploaded maps were filed under; none when matched by release. */
export const uploadedDebugIds = (target: UploadTarget, maps: ReadonlyArray<PlannedMap>) =>
	byRelease(target) ? [] : Arr.dedupe(Arr.getSomes(Arr.map(maps, (map) => map.debugId)))
