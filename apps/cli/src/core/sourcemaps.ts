// `maple sourcemaps inject|upload`: give built JS files a content-derived debug id, then upload each
// map to `POST /v2/source_maps` so the backend can symbolicate stack frames from those files.

import { Array as Arr, Effect, Option, Order, Predicate, Result, Schema, String as Str } from "effect"
import { FileSystem } from "effect/FileSystem"
import { Path } from "effect/Path"

export const JS_EXTENSIONS: ReadonlyArray<string> = [".js", ".mjs", ".cjs"]

/** Maps above this are refused by the server, so they are skipped before the upload. */
export const MAX_MAP_BYTES = 15 * 1024 * 1024

/** Reading or writing the build output failed. */
export class SourceMapsFileError extends Schema.TaggedError<SourceMapsFileError>()(
	"@maple/cli/SourceMapsFileError",
	{
		message: Schema.String,
		path: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

// `\r?` before `$`: with the `m` flag `$` stops at `\n`, so CRLF files keep a `\r` there.
const DEBUG_ID_COMMENT = /^\/\/# debugId=([0-9a-fA-F-]{36})[ \t]*\r?$/m
const SOURCE_MAPPING_URL = /^\/\/[#@] sourceMappingURL=(\S+)[ \t]*\r?$/gm
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const hex = (bytes: Uint8Array | string): string => {
	const hasher = new Bun.CryptoHasher("sha256")
	hasher.update(bytes)
	return hasher.digest("hex")
}

/**
 * sha256 of the content as a lowercase UUID. The version (4) and variant nibbles are set so the id
 * passes strict UUID validators; the rest is the hash, so the same file always gets the same id.
 */
export const debugIdFor = (content: Uint8Array | string): string => {
	const h = hex(content)
	const part = (start: number, end: number) => Str.slice(start, end)(h)
	const variant = ((Number.parseInt(part(16, 17), 16) & 0x3) | 0x8).toString(16)
	return `${part(0, 8)}-${part(8, 12)}-4${part(13, 16)}-${variant}${part(17, 20)}-${part(20, 32)}`
}

export const debugIdSnippet = (id: string): string =>
	`;!function(){try{var g="undefined"!=typeof globalThis?globalThis:"undefined"!=typeof window?window:"undefined"!=typeof self?self:{},s=(new g.Error).stack;s&&(g._mapleDebugIds=g._mapleDebugIds||{},g._mapleDebugIds[s]="${id}")}catch(e){}}();`

/** The id in an existing `//# debugId=` comment. */
export const existingDebugId = (code: string): Option.Option<string> =>
	Option.fromNullishOr(DEBUG_ID_COMMENT.exec(code)?.[1]).pipe(Option.map(Str.toLowerCase))

/** The last `//# sourceMappingURL=` comment: its value and where its line starts. */
export const sourceMappingUrl = (
	code: string,
): Option.Option<{ readonly url: string; readonly index: number }> =>
	Arr.last(Arr.fromIterable(Str.matchAll(SOURCE_MAPPING_URL)(code))).pipe(
		Option.flatMap((match) =>
			Option.all({ url: Option.fromNullishOr(match[1]), index: Option.fromNullishOr(match.index) }),
		),
	)

/**
 * Whether the file registers `id` at runtime (ours or Sentry's snippet assigning it into the
 * debug id map), which a bare `//# debugId=` comment does not. A bundled SDK that only reads
 * the map does not count. `id` is a UUID, so it needs no escaping.
 */
export const hasRuntimeRegistration = (code: string, id: string): boolean =>
	new RegExp(`_(?:maple|sentry)DebugIds\\[[^\\]]*\\]\\s*=\\s*["']${id}["']`, "i").test(code)

/**
 * Append the snippet, and the `//# debugId=` comment unless the file has one, after the code: before
 * the trailing debugId / sourceMappingURL comments. Nothing above that point moves, so the map's
 * mappings stay valid as they are.
 */
export const injectCode = (code: string, id: string): string => {
	const existingComment = Option.fromNullishOr(DEBUG_ID_COMMENT.exec(code)?.index)
	const block = Option.isSome(existingComment)
		? `${debugIdSnippet(id)}\n`
		: `${debugIdSnippet(id)}\n//# debugId=${id}\n`
	const insertAt = Arr.head(
		Arr.sort(
			[
				...Option.toArray(existingComment),
				...Option.toArray(Option.map(sourceMappingUrl(code), (url) => url.index)),
			],
			Order.Number,
		),
	)
	return Option.match(insertAt, {
		onSome: (index) => `${Str.slice(0, index)(code)}${block}${Str.slice(index)(code)}`,
		onNone: () => `${code}${code === "" || Str.endsWith("\n")(code) ? "" : "\n"}${block}`,
	})
}

const MapObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeMap = Schema.decodeUnknownResult(MapObject)

/** The map's own debug id (`debugId`, else `debug_id`), or `None` when it has none or is not JSON. */
export const mapDebugId = (mapText: string): Option.Option<string> =>
	Result.getSuccess(decodeMap(mapText)).pipe(
		Option.flatMap((map) =>
			Option.firstSomeOf([
				Option.liftPredicate(map["debugId"], Predicate.isString),
				Option.liftPredicate(map["debug_id"], Predicate.isString),
			]),
		),
		Option.map(Str.toLowerCase),
		Option.filter((id) => UUID.test(id)),
	)

/** Whether the map carries `id` under both `debugId` and `debug_id`. */
const mapHasDebugId = (mapText: string, id: string): boolean =>
	Result.match(decodeMap(mapText), {
		onFailure: () => false,
		onSuccess: (map) => map["debugId"] === id && map["debug_id"] === id,
	})

/** The map with `debugId` and `debug_id` set, or `None` when the map is not a JSON object. */
export const injectMap = (mapText: string, id: string): Option.Option<string> =>
	Result.getSuccess(decodeMap(mapText)).pipe(
		Option.map((map) => JSON.stringify({ ...map, debugId: id, debug_id: id })),
	)

const isJsFile = (file: string): boolean => Arr.some(JS_EXTENSIONS, (ext) => Str.endsWith(ext)(file))

const isLocalReference = (url: string): boolean => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)

const decodeUrlPath = (url: string): string =>
	Result.getOrElse(
		Result.try(() => decodeURIComponent(url)),
		() => url,
	)

const fileError = (path: string, verb: string) => (cause: unknown) =>
	new SourceMapsFileError({ message: `could not ${verb} ${path}`, path, cause })

/** Every file below `dir` that passes `keep`, relative to `dir` with `/` separators, sorted. */
const listFiles = (dir: string, keep: (file: string) => boolean) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem
		const files = yield* fs
			.readDirectory(dir, { recursive: true })
			.pipe(Effect.mapError(fileError(dir, "list")))
		return Arr.sort(
			Arr.filter(
				Arr.map(files, (f) => Str.replaceAll("\\", "/")(f)),
				(f) => keep(f) && !Str.includes("/node_modules/")(`/${f}`),
			),
			Order.String,
		)
	})

export interface JsWithMap {
	/** Relative to the walked directory, with `/` separators. */
	readonly file: string
	readonly jsPath: string
	readonly code: string
	readonly bytes: Uint8Array
	readonly mapPath: Option.Option<string>
}

/** The JS file's map: the local file its sourceMappingURL names, else `<file>.map`, if it exists. */
const resolveMap = (jsPath: string, code: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem
		const path = yield* Path
		const referenced = Option.filter(sourceMappingUrl(code), ({ url }) => isLocalReference(url)).pipe(
			Option.map(({ url }) =>
				path.resolve(path.dirname(jsPath), decodeUrlPath(Str.replace(/[?#].*$/, "")(url))),
			),
		)
		const candidates = Arr.dedupe([...Option.toArray(referenced), `${jsPath}.map`])
		const found = yield* Effect.filter(candidates, (candidate) =>
			fs.exists(candidate).pipe(Effect.orElseSucceed(() => false)),
		)
		return Arr.head(found)
	})

/** Every `*.js`/`*.mjs`/`*.cjs` file below `dir`, read, with the map it points at (if any). */
export const findJsFiles = (dir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem
		const path = yield* Path
		const files = yield* listFiles(dir, isJsFile)
		return yield* Effect.forEach(files, (file) =>
			Effect.gen(function* () {
				const jsPath = path.join(dir, file)
				const bytes = yield* fs.readFile(jsPath).pipe(Effect.mapError(fileError(jsPath, "read")))
				const code = new TextDecoder().decode(bytes)
				const mapPath = yield* resolveMap(jsPath, code)
				return { file, jsPath, code, bytes, mapPath } satisfies JsWithMap
			}),
		)
	})

// ---------------------------------------------------------------------------
// inject
// ---------------------------------------------------------------------------

export type InjectStatus = "injected" | "already_injected" | "no_map" | "invalid_map"

export interface InjectResult {
	readonly file: string
	readonly status: InjectStatus
	readonly debugId: Option.Option<string>
	/** True when the map gained `debugId`/`debug_id` (or would, under --dry-run). */
	readonly mapUpdated: boolean
}

const injectOne = (js: JsWithMap, dryRun: boolean) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem
		if (Option.isNone(js.mapPath))
			return {
				file: js.file,
				status: "no_map",
				debugId: Option.none(),
				mapUpdated: false,
			} satisfies InjectResult
		const mapPath = js.mapPath.value
		const mapText = yield* fs.readFileString(mapPath).pipe(Effect.mapError(fileError(mapPath, "read")))

		const previous = existingDebugId(js.code)
		const id = Option.getOrElse(previous, () => debugIdFor(js.bytes))
		const nextMap = injectMap(mapText, id)
		if (Option.isNone(nextMap))
			return {
				file: js.file,
				status: "invalid_map",
				debugId: Option.none(),
				mapUpdated: false,
			} satisfies InjectResult

		const mapUpdated = !mapHasDebugId(mapText, id)
		// Rollup/Vite `sourcemapDebugIds` write the comment but nothing that reports the id at runtime.
		const codeUpdated = Option.isNone(previous) || !hasRuntimeRegistration(js.code, id)
		if (!dryRun) {
			if (codeUpdated)
				yield* fs
					.writeFileString(js.jsPath, injectCode(js.code, id))
					.pipe(Effect.mapError(fileError(js.jsPath, "write")))
			if (mapUpdated)
				yield* fs
					.writeFileString(mapPath, nextMap.value)
					.pipe(Effect.mapError(fileError(mapPath, "write")))
		}
		return {
			file: js.file,
			status: codeUpdated ? "injected" : "already_injected",
			debugId: Option.some(id),
			mapUpdated,
		} satisfies InjectResult
	})

/** Inject debug ids into every JS file below `dir` that has a map. Re-running changes nothing. */
export const injectDirectory = (dir: string, options: { readonly dryRun: boolean }) =>
	Effect.flatMap(findJsFiles(dir), (files) => Effect.forEach(files, (js) => injectOne(js, options.dryRun)))
