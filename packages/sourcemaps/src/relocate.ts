// Moves a build's source maps out of its deployed output, so they are never served, and records
// which JS file each belongs to. The Alchemy `Maple.SourceMaps` resource uploads from there.
import { Array as Arr, Effect, Option, Schema, String as Str } from "effect"
import { FileSystem } from "effect/FileSystem"
import { Path } from "effect/Path"
import { fileError, type InjectResult, listFiles } from "./inject.ts"

/** The manifest written next to relocated maps. */
export const MANIFEST_FILE = "maple-sourcemaps.json"

export const SourceMapsManifestEntry = Schema.Struct({
	/** The JS file, relative to the deployed output: the path it is served at. */
	file: Schema.String,
	/** The debug id the file registers, when it has one. */
	debugId: Schema.NullOr(Schema.String),
	/** The map, relative to the manifest's directory. */
	map: Schema.String,
})
export type SourceMapsManifestEntry = typeof SourceMapsManifestEntry.Type

export const SourceMapsManifest = Schema.Struct({
	version: Schema.Literal(1),
	files: Schema.Array(SourceMapsManifestEntry),
})
export type SourceMapsManifest = typeof SourceMapsManifest.Type

const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(SourceMapsManifest))

/**
 * Moves every `.map` below `outDir` to the same relative path below `mapsDir` (emptied first, so it
 * holds one build) and writes {@link MANIFEST_FILE} for the injected files among `results`.
 */
export const relocateMaps = (outDir: string, mapsDir: string, results: ReadonlyArray<InjectResult>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem
		const path = yield* Path
		yield* fs
			.remove(mapsDir, { recursive: true, force: true })
			.pipe(Effect.mapError(fileError(mapsDir, "clear")))
		yield* fs
			.makeDirectory(mapsDir, { recursive: true })
			.pipe(Effect.mapError(fileError(mapsDir, "create")))
		const maps = yield* listFiles(outDir, Str.endsWith(".map"))
		// Copy then delete: `mapsDir` may be on another device than the build output.
		yield* Effect.forEach(
			maps,
			(file) =>
				Effect.gen(function* () {
					const from = path.join(outDir, file)
					const to = path.join(mapsDir, file)
					yield* fs.makeDirectory(path.dirname(to), { recursive: true })
					yield* fs.copyFile(from, to)
					yield* fs.remove(from)
				}).pipe(Effect.mapError(fileError(path.join(outDir, file), "move"))),
			{ discard: true },
		)
		const files = Arr.flatMap(results, (result) =>
			result.status === "injected" || result.status === "already_injected"
				? Option.toArray(
						Option.map(result.mapPath, (mapPath) => ({
							file: result.file,
							debugId: Option.getOrNull(result.debugId),
							map: Str.replaceAll("\\", "/")(path.relative(outDir, mapPath)),
						})),
					)
				: [],
		)
		const manifest = yield* encodeManifest({ version: 1, files }).pipe(
			Effect.mapError(fileError(MANIFEST_FILE, "encode")),
		)
		const manifestPath = path.join(mapsDir, MANIFEST_FILE)
		yield* fs
			.writeFileString(manifestPath, manifest)
			.pipe(Effect.mapError(fileError(manifestPath, "write")))
		return { moved: maps.length, files }
	})
