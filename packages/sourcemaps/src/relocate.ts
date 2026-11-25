// Moves a build's source maps out of its deployed output, so they are never served, and records
// which JS file each belongs to. `Maple.SourceMaps` and `@maple-dev/vite` upload from there.
import { Array as Arr, Effect, Option, Schema, String as Str } from "effect"
import { FileSystem } from "effect/FileSystem"
import { Path } from "effect/Path"
import { fileError, injectDirectory, type InjectResult, listFiles } from "./inject.ts"

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
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(SourceMapsManifest))

/** `mapsDir` is, holds or sits inside a build output: moving maps there could delete the build. */
export class SourceMapsDirOverlapError extends Schema.TaggedError<SourceMapsDirOverlapError>()(
	"@maple/sourcemaps/SourceMapsDirOverlapError",
	{ message: Schema.String, mapsDir: Schema.String, outDir: Schema.String },
) {}

/** One build output and what the inject did to it. */
export interface BuildOutput {
	readonly outDir: string
	readonly results: ReadonlyArray<InjectResult>
}

/**
 * Moves every `.map` below each output to the same relative path below `mapsDir` and writes one
 * {@link MANIFEST_FILE} for all of them. Only the files the previous manifest listed are removed
 * first, so anything else in `mapsDir` is left alone; a `mapsDir` that overlaps an output is refused
 * before any file is touched.
 */
export const relocateMaps = (mapsDir: string, outputs: ReadonlyArray<BuildOutput>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem
		const path = yield* Path
		const maps = path.resolve(mapsDir)
		const within = (base: string, target: string) => {
			const relative = path.relative(base, target)
			return relative === "" || (!Str.startsWith("..")(relative) && !path.isAbsolute(relative))
		}
		const overlapping = Arr.findFirst(outputs, ({ outDir }) => {
			const out = path.resolve(outDir)
			return within(out, maps) || within(maps, out)
		})
		if (Option.isSome(overlapping)) {
			return yield* new SourceMapsDirOverlapError({
				message: `The source maps directory ${maps} overlaps the build output ${overlapping.value.outDir}; choose one outside it.`,
				mapsDir: maps,
				outDir: overlapping.value.outDir,
			})
		}
		const manifestPath = path.join(maps, MANIFEST_FILE)
		// The last build's maps go, by its manifest; nothing it did not write is deleted.
		const previous = yield* fs.readFileString(manifestPath).pipe(
			Effect.flatMap(decodeManifest),
			Effect.map((manifest) => manifest.files),
			Effect.orElseSucceed(() => []),
		)
		yield* Effect.forEach(
			previous,
			(entry) =>
				Option.match(path.resolveWithin(maps, entry.map), {
					onNone: () => Effect.void,
					onSome: (file) =>
						fs.remove(file, { force: true }).pipe(Effect.mapError(fileError(file, "remove"))),
				}),
			{ discard: true },
		)
		yield* fs.makeDirectory(maps, { recursive: true }).pipe(Effect.mapError(fileError(maps, "create")))
		// Two outputs can each write `app.js.map`: each gets its own folder so neither map replaces the other.
		const folderOf = (index: number) => (outputs.length > 1 ? String(index) : "")
		const moved = yield* Effect.forEach(outputs, ({ outDir }, index) =>
			Effect.gen(function* () {
				const files = yield* listFiles(outDir, Str.endsWith(".map"))
				// Copy then delete: `mapsDir` may be on another device than the build output.
				yield* Effect.forEach(
					files,
					(file) =>
						Effect.gen(function* () {
							const from = path.join(outDir, file)
							const to = path.join(maps, folderOf(index), file)
							yield* fs.makeDirectory(path.dirname(to), { recursive: true })
							yield* fs.copyFile(from, to)
							yield* fs.remove(from)
						}).pipe(Effect.mapError(fileError(path.join(outDir, file), "move"))),
					{ discard: true },
				)
				return files.length
			}),
		)
		const files = Arr.flatMap(outputs, ({ outDir, results }, index) =>
			Arr.flatMap(results, (result) =>
				result.status === "injected" || result.status === "already_injected"
					? Option.toArray(
							Option.map(result.mapPath, (mapPath) => ({
								file: result.file,
								debugId: Option.getOrNull(result.debugId),
								map: Str.replaceAll(
									"\\",
									"/",
								)(path.join(folderOf(index), path.relative(outDir, mapPath))),
							})),
						)
					: [],
			),
		)
		const manifest = yield* encodeManifest({ version: 1, files }).pipe(
			Effect.mapError(fileError(MANIFEST_FILE, "encode")),
		)
		yield* fs
			.writeFileString(manifestPath, manifest)
			.pipe(Effect.mapError(fileError(manifestPath, "write")))
		return { moved: Arr.reduce(moved, 0, (sum, n) => sum + n), files }
	})

/** What one build did: the outputs processed, where their maps went, and how many. */
export interface PreparedBuild {
	readonly outDirs: ReadonlyArray<string>
	readonly mapsDir: string
	readonly moved: number
	readonly files: number
}

/** Injects debug ids into every output, then moves their maps to `mapsDir` under one manifest. */
export const prepareBuildOutputs = (outDirs: ReadonlyArray<string>, mapsDir: string) =>
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
		} satisfies PreparedBuild
	})
