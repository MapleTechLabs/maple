import { SOURCE_MAP_MAX_BYTES, SourceMapInvalidError, SourceMapTooLargeError } from "@maple/domain/http"
import type { OrgId, SourceMapFileId } from "@maple/primitives"
import { frameUrlPath, urlMatchesMinifiedPath } from "@maple/domain/errors/js-stack"
import { Array as Arr, Effect, Option, Order, Predicate, Schema, String as Str } from "effect"

/**
 * Pure rules for stored source maps: what an upload must look like, and which stored file a stack
 * frame URL belongs to. The service and its tests share them.
 */

const MAX_PATH_LENGTH = 1024
const MAX_LABEL_LENGTH = 256
/** The release-path index entry must fit a B-tree page (~2.7 kB); multibyte text can exceed it. */
const MAX_RELEASE_KEY_BYTES = 2000

/** Where a file's bytes live in the bucket; the org prefix is what org erasure deletes. */
export const sourceMapObjectKey = (orgId: OrgId, id: SourceMapFileId): string => `v1/${orgId}/${id}`

/** The prefix holding every source map of an org; the slash keeps `org_a` off `org_ab`. */
export const sourceMapOrgPrefix = (orgId: OrgId): string => `v1/${orgId}/`

const parseUrl = Option.liftThrowable((value: string) => new URL(value))

const stripLeadingSlashes = Str.replace(/^(?:\.\/|\/)+/u, "")

/** `assets/a.js`, `/assets/a.js`, `./assets/a.js` and `https://cdn.test/assets/a.js` all store as `assets/a.js`. */
export const normalizeMinifiedPath = (raw: string): string =>
	Option.match(
		Option.filter(
			parseUrl(Str.trim(raw)),
			(url) => url.protocol === "http:" || url.protocol === "https:",
		),
		{
			onNone: () => stripLeadingSlashes(Str.trim(raw)),
			// Frame paths are matched decoded, so a URL's percent-encoded path is stored decoded.
			onSome: () => frameUrlPath(raw),
		},
	)

const DEBUG_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/** Debug ids compare lowercase; `None` when the value is not UUID-shaped. */
export const normalizeDebugId = (raw: string): Option.Option<string> =>
	Option.liftPredicate(Str.toLowerCase(Str.trim(raw)), (id) => DEBUG_ID_PATTERN.test(id))

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** The parsed body when it is a JSON object; the text is dropped as soon as it is parsed. */
const parseJsonObject = (bytes: Uint8Array) =>
	Option.filter(decodeJson(new TextDecoder().decode(bytes)), Predicate.isObject)

export interface ValidatedSourceMap {
	readonly minifiedPath: string
	readonly debugId: string | null
	readonly serviceName: string | null
	readonly version: string | null
	readonly sizeBytes: number
	readonly hasSourcesContent: boolean
}

export interface SourceMapUpload {
	readonly bytes: Uint8Array
	readonly minifiedPath: string
	readonly debugId?: string | undefined
	readonly serviceName?: string | undefined
	readonly version?: string | undefined
}

const invalid = (message: string, param?: string) =>
	new SourceMapInvalidError({ message, ...(param === undefined ? undefined : { param }) })

const optionalLabel = (value: string | undefined, param: string) =>
	Effect.gen(function* () {
		if (value === undefined) return null
		const trimmed = Str.trim(value)
		if (trimmed.length === 0) return null
		if (trimmed.length > MAX_LABEL_LENGTH) {
			return yield* invalid(`\`${param}\` must be at most ${MAX_LABEL_LENGTH} characters.`, param)
		}
		return trimmed
	})

const stringField = (fields: JsonObject, key: string): string | undefined => {
	const value = fields[key]
	return Predicate.isString(value) ? value : undefined
}

type JsonObject = { readonly [x: PropertyKey]: unknown }

/** A plain map symbolication can read: a `mappings` string and at least one source (string or null). */
const isRegularMap = (fields: JsonObject): boolean => {
	const sources = fields["sources"]
	return (
		Predicate.isString(fields["mappings"]) &&
		Arr.isArray(sources) &&
		sources.length > 0 &&
		Arr.every(sources, (source) => source === null || Predicate.isString(source))
	)
}

const sectionMaps = (fields: JsonObject): ReadonlyArray<JsonObject> => {
	const sections = fields["sections"]
	return Arr.isArray(sections)
		? Arr.flatMap(sections, (section) =>
				Predicate.isObject(section) && Predicate.isObject(section["map"]) ? [section["map"]] : [],
			)
		: []
}

const isOffset = (offset: unknown): boolean =>
	Predicate.isObject(offset) && Predicate.isNumber(offset["line"]) && Predicate.isNumber(offset["column"])

/** An index map: a non-empty `sections` array, each an offset and a plain version 3 map. */
const isIndexMap = (fields: JsonObject): boolean => {
	const sections = fields["sections"]
	return (
		Arr.isArray(sections) &&
		sections.length > 0 &&
		Arr.every(
			sections,
			(section) =>
				Predicate.isObject(section) &&
				isOffset(section["offset"]) &&
				Predicate.isObject(section["map"]) &&
				section["map"]["version"] === 3 &&
				isRegularMap(section["map"]),
		)
	)
}

const hasContent = (fields: JsonObject): boolean => {
	const sourcesContent = fields["sourcesContent"]
	return (
		Arr.isArray(sourcesContent) &&
		Arr.some(sourcesContent, (content) => Predicate.isString(content) && content.length > 0)
	)
}

/**
 * Checks an upload against the contract: at most 10 MiB (what symbolication can load), a version 3 map with a `mappings` string
 * and sources (or an index map of such maps), and a debug id or a service and version to find it by. A debug id the map itself carries
 * (`debugId` / `debug_id`) is used when none is passed.
 */
export const validateSourceMapUpload = Effect.fn("SourceMapFiles.validateUpload")(function* (
	upload: SourceMapUpload,
) {
	const sizeBytes = upload.bytes.byteLength
	if (sizeBytes > SOURCE_MAP_MAX_BYTES) {
		return yield* new SourceMapTooLargeError({
			message: `Source map is ${sizeBytes} bytes; the limit is ${SOURCE_MAP_MAX_BYTES} (10 MiB), the largest map Maple can symbolicate with.`,
			sizeBytes,
		})
	}
	const minifiedPath = normalizeMinifiedPath(upload.minifiedPath)
	if (minifiedPath.length === 0) {
		return yield* invalid(
			"`minified_path` must name the JavaScript file the map belongs to.",
			"minified_path",
		)
	}
	if (minifiedPath.length > MAX_PATH_LENGTH) {
		return yield* invalid(
			`\`minified_path\` must be at most ${MAX_PATH_LENGTH} characters.`,
			"minified_path",
		)
	}
	const serviceName = yield* optionalLabel(upload.serviceName, "service")
	const version = yield* optionalLabel(upload.version, "version")
	const keyBytes = new TextEncoder().encode(
		`${serviceName ?? ""}${version ?? ""}${minifiedPath}`,
	).byteLength
	if (keyBytes > MAX_RELEASE_KEY_BYTES) {
		return yield* invalid(
			`\`service\`, \`version\` and \`minified_path\` together must be at most ${MAX_RELEASE_KEY_BYTES} bytes.`,
			"minified_path",
		)
	}

	const fields = yield* Effect.fromOption(parseJsonObject(upload.bytes), () =>
		invalid("The body is not a JSON object."),
	)
	if (fields["version"] !== 3) {
		return yield* invalid("Only version 3 source maps are supported.")
	}
	if (!isRegularMap(fields) && !isIndexMap(fields)) {
		return yield* invalid(
			"The source map needs a `mappings` string and a non-empty `sources` array, or a `sections` array of such maps.",
		)
	}
	const hasSourcesContent = Predicate.isUndefined(fields["sections"])
		? hasContent(fields)
		: Arr.some(sectionMaps(fields), hasContent)

	const rawDebugId = upload.debugId ?? stringField(fields, "debugId") ?? stringField(fields, "debug_id")
	const debugId =
		rawDebugId === undefined
			? null
			: yield* Effect.fromOption(normalizeDebugId(rawDebugId), () =>
					invalid("`debug_id` must be a UUID.", "debug_id"),
				)
	if (debugId === null && (serviceName === null || version === null)) {
		return yield* invalid(
			"Pass `debug_id`, or both `service` and `version`, so the map can be matched to stack traces.",
			"debug_id",
		)
	}

	return {
		minifiedPath,
		debugId,
		serviceName,
		version,
		sizeBytes,
		hasSourcesContent,
	} satisfies ValidatedSourceMap
})

/** The stored files a lookup can match: a debug id or a release (service + version) path. */
export interface MatchableFile {
	readonly debugId: string | null
	readonly minifiedPath: string
	readonly createdAt: number
}

/** Longest path first; on a tie the map without a debug id (the release's own), then the newest. */
const releaseFileOrder = <F extends MatchableFile>() =>
	Order.combineAll<F>([
		Order.mapInput(Order.flip(Order.Number), (file: F) => file.minifiedPath.length),
		Order.mapInput(Order.Boolean, (file: F) => file.debugId !== null),
		Order.mapInput(Order.flip(Order.Number), (file: F) => file.createdAt),
	])

/**
 * Picks the file for each frame URL: the file its debug id names first, else the release file whose
 * minified path the URL ends with (the longest such path when several do, see `releaseFileOrder`).
 */
export const matchFrames = <F extends MatchableFile>(
	urls: ReadonlyArray<string>,
	debugIds: ReadonlyMap<string, string>,
	byDebugId: ReadonlyArray<F>,
	releaseFiles: ReadonlyArray<F>,
): ReadonlyMap<string, F> =>
	new Map(
		Arr.flatMap(Arr.dedupe(urls), (url) => {
			const fromDebugId = Option.flatMap(
				Option.flatMap(Option.fromNullishOr(debugIds.get(url)), normalizeDebugId),
				(id) => Arr.findFirst(byDebugId, (file) => file.debugId === id),
			)
			const match = Option.orElse(fromDebugId, () =>
				Arr.head(
					Arr.sort(
						Arr.filter(releaseFiles, (file) => urlMatchesMinifiedPath(url, file.minifiedPath)),
						releaseFileOrder<F>(),
					),
				),
			)
			return Option.match(match, {
				onNone: () => [],
				onSome: (file) => [[url, file] as const],
			})
		}),
	)
