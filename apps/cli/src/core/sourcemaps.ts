// `maple sourcemaps inject|upload`: give built JS files a content-derived debug id, then upload each
// map to `POST /v2/source_maps` so the backend can symbolicate stack frames from those files.

import { Array as Arr, Effect, Option, Order, Predicate, Result, Schema, String as Str } from "effect"
import { SOURCE_MAP_MAX_BYTES } from "@maple/domain/http"
import { FileSystem } from "effect/FileSystem"
import { Path } from "effect/Path"

export const JS_EXTENSIONS: ReadonlyArray<string> = [".js", ".mjs", ".cjs"]

/** Maps above this are refused by the server (the largest it can symbolicate with), so they are skipped before the upload. */
export const MAX_MAP_BYTES = SOURCE_MAP_MAX_BYTES

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
const REGISTERED_ID = /_(?:maple|sentry)DebugIds\[[^\]]*\]\s*=\s*["']([0-9a-fA-F-]{36})["']/

const MapObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeMap = Schema.decodeUnknownResult(MapObject)

/** The map as JSON without its `debugId` / `debug_id`, so writing an id never changes the hash. */
const canonicalMap = (mapText: string): string =>
	Result.match(decodeMap(mapText), {
		onFailure: () => mapText,
		onSuccess: ({ debugId: _a, debug_id: _b, x_maple_shifted: _c, ...rest }) => JSON.stringify(rest),
	})

/**
 * sha256 of the JS file and its map as a lowercase UUID. The version (4) and variant nibbles are set
 * so the id passes strict UUID validators; the rest is the hash, so the same build always gets the
 * same id, and identical JS with another map (comments moved, sources changed) gets another.
 */
export const debugIdFor = (code: Uint8Array | string, mapText: string): string => {
	const hasher = new Bun.CryptoHasher("sha256")
	hasher.update(code)
	hasher.update("\u0000")
	hasher.update(canonicalMap(mapText))
	const h = hasher.digest("hex")
	const part = (start: number, end: number) => Str.slice(start, end)(h)
	const variant = ((Number.parseInt(part(16, 17), 16) & 0x3) | 0x8).toString(16)
	return `${part(0, 8)}-${part(8, 12)}-4${part(13, 16)}-${variant}${part(17, 20)}-${part(20, 32)}`
}

export const debugIdSnippet = (id: string): string =>
	`;!function(){try{var g="undefined"!=typeof globalThis?globalThis:"undefined"!=typeof window?window:"undefined"!=typeof self?self:{},s=(new g.Error).stack;s&&(g._mapleDebugIds=g._mapleDebugIds||{},g._mapleDebugIds[s]="${id}")}catch(e){}}();`

/** The id in an existing `//# debugId=` comment, else the one a runtime registration assigns. */
export const existingDebugId = (code: string): Option.Option<string> =>
	Option.firstSomeOf([
		Option.fromNullishOr(DEBUG_ID_COMMENT.exec(code)?.[1]),
		Option.fromNullishOr(REGISTERED_ID.exec(code)?.[1]),
	]).pipe(
		Option.map(Str.toLowerCase),
		Option.filter((id) => UUID.test(id)),
	)

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

/** Where trailing comments start: the first of an existing debugId and the last sourceMappingURL. */
const trailerIndex = (code: string): Option.Option<number> =>
	Arr.head(
		Arr.sort(
			[
				...Option.toArray(Option.fromNullishOr(DEBUG_ID_COMMENT.exec(code)?.index)),
				...Option.toArray(Option.map(sourceMappingUrl(code), (url) => url.index)),
			],
			Order.Number,
		),
	)

const insertBeforeTrailer = (code: string, block: string): string =>
	Option.match(trailerIndex(code), {
		onSome: (index) => `${Str.slice(0, index)(code)}${block}${Str.slice(index)(code)}`,
		onNone: () => `${code}${code === "" || Str.endsWith("\n")(code) ? "" : "\n"}${block}`,
	})

/**
 * Whether the snippet can go on a new first line: not above a shebang, and not above a directive
 * prologue (`"use strict"` and the like), which only counts as one at the top.
 */
export const canPrepend = (code: string): boolean => !Str.startsWith("#!")(code) && !startsWithString(code)

/** Whether the first token after whitespace and comments is a string literal; one linear pass. */
const startsWithString = (code: string): boolean => {
	const rest = Str.trimStart(code)
	if (Str.startsWith("//")(rest)) {
		return Option.match(Str.indexOf("\n")(rest), {
			onNone: () => false,
			onSome: (end) => startsWithString(Str.slice(end + 1)(rest)),
		})
	}
	if (Str.startsWith("/*")(rest)) {
		return Option.match(Str.indexOf("*/")(Str.slice(2)(rest)), {
			onNone: () => false,
			onSome: (end) => startsWithString(Str.slice(end + 4)(rest)),
		})
	}
	return Str.startsWith('"')(rest) || Str.startsWith("'")(rest)
}

/**
 * `prepend`: the snippet on a new first line, so the id is registered before the module's own code
 * runs (a throw while it loads still reports it); every line moves down one, which the map's
 * mappings must follow (`shiftMappings`). `append`: the snippet after the code, before the trailing
 * debugId / sourceMappingURL comments, so nothing moves. Either way the `//# debugId=` comment is
 * added near the end unless the file has one.
 */
export const injectCode = (code: string, id: string, mode: "prepend" | "append"): string => {
	const hasComment = DEBUG_ID_COMMENT.test(code)
	if (mode === "prepend") {
		const tagged = hasComment ? code : insertBeforeTrailer(code, `//# debugId=${id}\n`)
		return `${debugIdSnippet(id)}\n${tagged}`
	}
	return insertBeforeTrailer(
		code,
		hasComment ? `${debugIdSnippet(id)}\n` : `${debugIdSnippet(id)}\n//# debugId=${id}\n`,
	)
}

/** Mappings for code one line lower: an empty first generated line. */
export const shiftMappings = (mappings: string): string => `;${mappings}`

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

/** Whether the map is an index map (`sections`), which the server refuses. */
export const isIndexMap = (mapText: string): boolean =>
	Result.match(decodeMap(mapText), {
		onFailure: () => false,
		onSuccess: (map) => map["sections"] !== undefined,
	})

/** A version 3 source map as a JSON object; anything else is never rewritten. */
const decodeV3Map = (mapText: string) =>
	Option.filter(Result.getSuccess(decodeMap(mapText)), (map) => map["version"] === 3)

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
	/** The map the file names, refused because it lies outside the build directory. */
	readonly refusedMap: Option.Option<string>
}

/** Whether `target` lies below `root`, both lexically and once symlinks are followed. */
const isInside = (root: string, target: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem
		const path = yield* Path
		const within = (base: string, file: string) =>
			Option.isSome(path.resolveWithin(base, path.relative(base, file))) &&
			path.resolve(base) !== path.resolve(file)
		if (!within(root, target)) return false
		const real = yield* Effect.all([fs.realPath(root), fs.realPath(target)]).pipe(Effect.option)
		return Option.isSome(real) && within(real.value[0], real.value[1])
	})

/**
 * The JS file's map: the local file its sourceMappingURL names, else `<file>.map`, if it exists. A
 * named map outside `root` (a `..` escape, an absolute path, a symlink) is refused, never read.
 */
const resolveMap = (root: string, jsPath: string, code: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem
		const path = yield* Path
		const referenced = Option.filter(sourceMappingUrl(code), ({ url }) => isLocalReference(url)).pipe(
			Option.map(({ url }) =>
				path.resolve(path.dirname(jsPath), decodeUrlPath(Str.replace(/[?#].*$/, "")(url))),
			),
		)
		const exists = (candidate: string) => fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))
		if (Option.isSome(referenced) && (yield* exists(referenced.value))) {
			return (yield* isInside(root, referenced.value))
				? { mapPath: referenced, refusedMap: Option.none<string>() }
				: { mapPath: Option.none<string>(), refusedMap: referenced }
		}
		const sibling = `${jsPath}.map`
		if (!(yield* exists(sibling)))
			return { mapPath: Option.none<string>(), refusedMap: Option.none<string>() }
		return (yield* isInside(root, sibling))
			? { mapPath: Option.some(sibling), refusedMap: Option.none<string>() }
			: { mapPath: Option.none<string>(), refusedMap: Option.some(sibling) }
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
				const { mapPath, refusedMap } = yield* resolveMap(dir, jsPath, code)
				return { file, jsPath, code, bytes, mapPath, refusedMap } satisfies JsWithMap
			}),
		)
	})

/** How many JS files name each map: a map two files share cannot carry either file's id. */
export const mapUsers = (files: ReadonlyArray<JsWithMap>): ReadonlyMap<string, number> =>
	Arr.reduce(
		Arr.getSomes(Arr.map(files, (js) => js.mapPath)),
		new Map<string, number>(),
		(users, mapPath) => users.set(mapPath, (users.get(mapPath) ?? 0) + 1),
	)

// ---------------------------------------------------------------------------
// inject
// ---------------------------------------------------------------------------

export type InjectStatus = "injected" | "already_injected" | "no_map" | "invalid_map" | "unsafe_map"

export interface InjectResult {
	readonly file: string
	readonly status: InjectStatus
	readonly debugId: Option.Option<string>
	/** True when the map gained `debugId`/`debug_id` (or would, under --dry-run). */
	readonly mapUpdated: boolean
	/** The map the file names, when it was refused or is not a version 3 JSON object. */
	readonly mapPath: Option.Option<string>
}

/** The map carrying `id`, its mappings one line lower when `shift`, marked as moved when `moved`. */
const taggedMap = (
	map: { readonly [key: string]: unknown },
	id: string,
	shift: boolean,
	moved: boolean,
): string => {
	const mappings = map["mappings"]
	const tagged = { ...map, debugId: id, debug_id: id, ...(moved ? { [SHIFTED_FIELD]: id } : undefined) }
	return JSON.stringify(
		shift && Predicate.isString(mappings) ? { ...tagged, mappings: shiftMappings(mappings) } : tagged,
	)
}

/** Marks a map whose mappings were moved one line down for `id`'s snippet, so they never move twice. */
const SHIFTED_FIELD = "x_maple_shifted"

/** Replaces `path` whole: a failed write leaves the old file, never a half-written one. */
const writeAtomically = (path: string, content: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem
		const temporary = `${path}.maple-tmp`
		yield* fs.writeFileString(temporary, content)
		yield* fs.rename(temporary, path)
	}).pipe(Effect.mapError(fileError(path, "write")))

const injectOne = (js: JsWithMap, shared: boolean, dryRun: boolean) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem
		const skip = (status: InjectStatus, mapPath: Option.Option<string>): InjectResult => ({
			file: js.file,
			status,
			debugId: Option.none(),
			mapUpdated: false,
			mapPath,
		})
		if (Option.isSome(js.refusedMap)) return skip("unsafe_map", js.refusedMap)
		if (Option.isNone(js.mapPath)) return skip("no_map", Option.none())
		const mapPath = js.mapPath.value
		const mapText = yield* fs.readFileString(mapPath).pipe(Effect.mapError(fileError(mapPath, "read")))
		const map = decodeV3Map(mapText)
		if (Option.isNone(map)) return skip("invalid_map", js.mapPath)

		// A map already moved for an id keeps it: its JS write failed after the map was written.
		const shiftedFor = Option.filter(
			Option.liftPredicate(map.value[SHIFTED_FIELD], Predicate.isString),
			(id) => UUID.test(id),
		)
		const previous = Option.firstSomeOf([existingDebugId(js.code), shiftedFor])
		const id = Option.getOrElse(previous, () => debugIdFor(js.bytes, mapText))
		// Rollup/Vite `sourcemapDebugIds` write the comment but nothing that reports the id at runtime.
		const codeUpdated = !hasRuntimeRegistration(js.code, id)
		const mappings = map.value["mappings"]
		const movable = !shared && Predicate.isString(mappings) && map.value["sections"] === undefined
		const hasId = map.value["debugId"] === id && map.value["debug_id"] === id
		// Whether the snippet is (or goes) on the first line: lines below it are one lower.
		const prepended = codeUpdated
			? movable && canPrepend(js.code)
			: Str.startsWith(`${debugIdSnippet(id)}\n`)(js.code)
		// Moved once only: marked by this CLI, or a registered file whose map already carries its id.
		const alreadyShifted = Option.contains(shiftedFor, id) || (!codeUpdated && hasId)
		const shift = prepended && movable && !alreadyShifted
		// A shared map keeps no id: each file sharing it is uploaded with its own.
		const mapUpdated = !shared && (shift || !hasId)
		if (!dryRun) {
			// The map first: a JS file pointing at a map not yet moved would map one line off.
			if (mapUpdated)
				yield* writeAtomically(mapPath, taggedMap(map.value, id, shift, prepended && movable))
			if (codeUpdated)
				yield* fs
					.writeFileString(js.jsPath, injectCode(js.code, id, prepended ? "prepend" : "append"))
					.pipe(Effect.mapError(fileError(js.jsPath, "write")))
		}
		return {
			file: js.file,
			status: codeUpdated ? "injected" : "already_injected",
			debugId: Option.some(id),
			mapUpdated,
			mapPath: Option.none(),
		} satisfies InjectResult
	})

/** Inject debug ids into every JS file below `dir` that has a map. Re-running changes nothing. */
export const injectDirectory = (dir: string, options: { readonly dryRun: boolean }) =>
	Effect.flatMap(findJsFiles(dir), (files) => {
		const users = mapUsers(files)
		return Effect.forEach(files, (js) =>
			injectOne(
				js,
				Option.match(js.mapPath, {
					onNone: () => false,
					onSome: (path) => (users.get(path) ?? 0) > 1,
				}),
				options.dryRun,
			),
		)
	})
