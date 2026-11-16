// Browser session ingest for Maple Local: replay metadata, replay chunks and
// distilled session events, as sent by @maple-dev/browser. Ports the hosted
// gateway's handlers (apps/ingest/src/main.rs, session_analytics.rs).

import { Clock, Effect, Option, Result, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import { gunzipSync } from "node:zlib"
import insertMappings from "./schema/local-inserts.json"
import type { InsertBatch, LocalInsertError } from "./insert-batcher"
import { encodeJson } from "./json"

export const SESSION_REPLAYS_META_PATH = "/v1/sessionReplays/meta"
export const SESSION_REPLAYS_BLOB_PATH = "/v1/sessionReplays/blob"
export const SESSION_EVENTS_PATH = "/v1/sessionEvents"

export type SessionRoute = "meta" | "blob" | "events"

export const sessionRouteFor = (pathname: string): SessionRoute | undefined =>
	pathname === SESSION_REPLAYS_META_PATH
		? "meta"
		: pathname === SESSION_REPLAYS_BLOB_PATH
			? "blob"
			: pathname === SESSION_EVENTS_PATH
				? "events"
				: undefined

/** Headers a replay chunk upload carries; CORS preflight must allow each. */
export const SESSION_CHUNK_HEADERS = [
	"x-maple-session-id",
	"x-maple-chunk-seq",
	"x-maple-is-checkpoint",
	"x-maple-event-count",
	"x-maple-duration-ms",
] as const

/** NDJSON bodies (meta, events) above this, sent or inflated, are refused. */
export const MAX_SESSION_NDJSON_BYTES = 8 * 1024 * 1024
/** A replay chunk above this, sent or inflated, is refused. Its row is one SQL literal and
 *  JSON plus SQL escaping can grow a byte up to 4x, so 15 MiB stays under chDB's 64 MiB max_query_size. */
export const MAX_REPLAY_CHUNK_BYTES = 15 * 1024 * 1024

// Caps from apps/ingest/src/session_analytics.rs.
const SESSION_EVENT_TYPES = new Set(["navigation", "click", "input", "console", "network", "error", "custom"])
const EVENT_MAX_MESSAGE_BYTES = 1024
const EVENT_MAX_ATTRIBUTES = 32
const EVENT_MAX_ATTRIBUTE_KEY_BYTES = 64
const EVENT_MAX_ATTRIBUTE_VALUE_BYTES = 1024
const META_MAX_DIMENSION_BYTES = 128
const META_MAX_TEXT_BYTES = 1024
const META_MAX_TRAITS = 24
const META_MAX_TRAIT_KEY_BYTES = 64
const META_MAX_TRAIT_VALUE_BYTES = 1024
const META_DIMENSION_FIELDS = [
	"utm_source",
	"utm_medium",
	"utm_campaign",
	"host",
	"language",
	"referrer_host",
]
const META_TEXT_FIELDS = [
	"visitor_id",
	"user_email",
	"user_name",
	"group_id",
	"group_name",
	"referrer",
	"utm_term",
	"utm_content",
	"entry_path",
	"exit_path",
]

/** A request this module refuses; `status` is the HTTP answer. */
export class SessionIngestRejected extends Schema.TaggedError<SessionIngestRejected>()(
	"@maple/cli/SessionIngestRejected",
	{ message: Schema.String, status: Schema.Number },
) {}

const reject = (status: number, message: string) => new SessionIngestRejected({ status, message })

export interface SessionIngestResult {
	readonly response: Response
	readonly accepted: number
	readonly dropped: number
}

type Row = Record<string, unknown>

const isRecord = (value: unknown): value is Row =>
	typeof value === "object" && value !== null && !Arr.isArray(value)

// --- column projection -----------------------------------------------------

type ColumnKind =
	| { readonly kind: "string" }
	| { readonly kind: "uint"; readonly max: number }
	| { readonly kind: "datetime" }
	| { readonly kind: "stringArray" }
	| { readonly kind: "stringMap" }

export interface ColumnSpec {
	readonly name: string
	readonly nullable: boolean
	readonly type: ColumnKind | undefined
}

const unwrap = (type: string, wrapper: string): string | undefined =>
	Str.startsWith(`${wrapper}(`)(type) && Str.endsWith(")")(type)
		? Str.slice(wrapper.length + 1, -1)(type)
		: undefined

const UINT_MAX = new Map([
	["UInt8", 255],
	["UInt16", 65_535],
	["UInt32", 4_294_967_295],
	["UInt64", Number.MAX_SAFE_INTEGER],
])

const columnKind = (type: string): ColumnKind | undefined => {
	const inner = unwrap(type, "LowCardinality") ?? type
	if (inner === "String") return { kind: "string" }
	const max = UINT_MAX.get(inner)
	if (max !== undefined) return { kind: "uint", max }
	if (Str.startsWith("DateTime")(inner)) return { kind: "datetime" }
	if (inner === "Array(String)") return { kind: "stringArray" }
	const map = unwrap(inner, "Map")
	if (map !== undefined && Str.endsWith(", String")(map)) return { kind: "stringMap" }
	return undefined
}

/** Split `a T, b Map(K, V)` on its top-level commas. */
const splitTopLevel = (schema: string): string[] => {
	const parts: string[] = []
	let depth = 0
	let start = 0
	for (let i = 0; i < schema.length; i++) {
		const ch = schema[i]
		if (ch === "(") depth++
		else if (ch === ")") depth--
		else if (ch === "," && depth === 0) {
			parts.push(Str.trim(Str.slice(start, i)(schema)))
			start = i + 1
		}
	}
	parts.push(Str.trim(Str.slice(start)(schema)))
	return Arr.filter(parts, (part) => part.length > 0)
}

export const parseInputSchema = (schema: string): ReadonlyArray<ColumnSpec> =>
	Arr.map(splitTopLevel(schema), (part) => {
		const space = Option.getOrElse(Str.indexOf(" ")(part), () => part.length)
		const name = Str.slice(0, space)(part)
		const raw = Str.trim(Str.slice(space + 1)(part))
		const nullable = unwrap(raw, "Nullable")
		return { name, nullable: nullable !== undefined, type: columnKind(nullable ?? raw) }
	})

const InsertMappings = Schema.Struct({
	datasources: Schema.Record(Schema.String, Schema.Struct({ inputSchema: Schema.String })),
})

const mappings: typeof InsertMappings.Type = Option.getOrElse(
	Schema.decodeOption(InsertMappings)(insertMappings),
	() => ({ datasources: {} }),
)

export const sessionColumns = (datasource: string): ReadonlyArray<ColumnSpec> =>
	parseInputSchema(mappings.datasources[datasource]?.inputSchema ?? "")

const DATETIME_TEXT = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d{1,9})?Z?$/

/** `YYYY-MM-DD hh:mm:ss[.f]` (UTC) as chDB's basic DateTime64 parser accepts it, or none
 *  for another shape or an impossible date, which would fail the whole batched insert. */
const chDateTime = (value: string): Option.Option<string> => {
	const match = DATETIME_TEXT.exec(value)
	if (match === null) return Option.none()
	const [, date = "", time = "", fraction = ""] = match
	const parsed = new Date(`${date}T${time}Z`)
	return Number.isNaN(parsed.getTime()) || !Str.startsWith(`${date}T${time}`)(parsed.toISOString())
		? Option.none()
		: Option.some(`${date} ${time}${fraction}`)
}

const stringifyValue = (value: unknown): string => (typeof value === "string" ? value : encodeJson(value))

/** The value as its column accepts it, or none so the column takes its default.
 *  An off-type value would fail the whole chDB insert, not just its row. */
const coerce = (value: unknown, spec: ColumnSpec): Option.Option<unknown> => {
	if (value === null) return spec.nullable ? Option.some(null) : Option.none()
	switch (spec.type?.kind) {
		case "string":
			return typeof value === "string" ? Option.some(value) : Option.none()
		case "uint": {
			const max = spec.type.max
			if (typeof value === "boolean") return Option.some(value ? 1 : 0)
			return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max
				? Option.some(value)
				: Option.none()
		}
		case "datetime":
			return typeof value === "string" ? chDateTime(value) : Option.none()
		case "stringArray":
			return Arr.isArray(value)
				? Option.some(Arr.filter(value, (item): item is string => typeof item === "string"))
				: Option.none()
		case "stringMap":
			return isRecord(value) ? Option.some(Rec.map(value, stringifyValue)) : Option.none()
		case undefined:
			return Option.none()
	}
}

/** Only the datasource's columns, each coerced to its type; anything else is dropped. */
export const projectRow = (columns: ReadonlyArray<ColumnSpec>, row: Row): Row => {
	const out: Row = {}
	for (const spec of columns) {
		if (!(spec.name in row)) continue
		const value = coerce(row[spec.name], spec)
		if (Option.isSome(value)) out[spec.name] = value.value
	}
	return out
}

// --- sanitization (session_analytics.rs) -----------------------------------

const utf8 = new TextEncoder()

/** Truncate to a UTF-8 byte budget without splitting a character. */
export const truncateUtf8 = (value: string, maxBytes: number): string => {
	if (utf8.encode(value).length <= maxBytes) return value
	let bytes = 0
	let out = ""
	for (const ch of value) {
		const size = utf8.encode(ch).length
		if (bytes + size > maxBytes) break
		bytes += size
		out += ch
	}
	return out
}

/** Truncate a string field; drop an off-type one so its column takes the default. */
const clampStringField = (row: Row, field: string, maxBytes: number): Row => {
	if (!(field in row)) return row
	const value = row[field]
	return typeof value === "string"
		? { ...row, [field]: truncateUtf8(value, maxBytes) }
		: Rec.remove(row, field)
}

const clampFields = (row: Row, fields: ReadonlyArray<string>, maxBytes: number): Row =>
	Arr.reduce(fields, row, (acc, field) => clampStringField(acc, field, maxBytes))

/** Bound entry count, truncate keys and values, stringify non-string values. Keeps insertion order. */
const clampStringMap = (map: Row, maxEntries: number, maxKey: number, maxValue: number): Row => {
	const out: Row = {}
	for (const [key, value] of Rec.toEntries(map)) {
		if (Rec.size(out) >= maxEntries) break
		out[truncateUtf8(key, maxKey)] = truncateUtf8(stringifyValue(value), maxValue)
	}
	return out
}

/** Canonical host of an absolute URL: lowercased, trailing dot and `www.` stripped. */
const canonicalHost = (url: string): string => {
	const parsed = URL.parse(url)
	if (parsed === null || parsed.hostname === "") return ""
	const host = Str.toLowerCase(Str.replace(/\.+$/, "")(parsed.hostname))
	return Str.startsWith("www.")(host) ? Str.slice(4)(host) : host
}

/** The referrer's host, or "" when absent, unparseable or the page's own host. */
export const deriveReferrerHost = (referrer: string, currentHost: string): string => {
	const trimmed = Str.trim(referrer)
	if (trimmed === "") return ""
	const host = canonicalHost(trimmed)
	return host === "" || host === canonicalHost(`http://${Str.trim(currentHost)}`) ? "" : host
}

/** One metadata row with the server-derived fields set and client fields clamped. */
export const sanitizeSessionMeta = (input: Row): Row => {
	const referrer = typeof input.referrer === "string" ? input.referrer : ""
	const host = typeof input.host === "string" ? input.host : ""
	// No proxy geo locally, so country is the column default, as hosted without trusted geo.
	const derived = { ...input, country: "", referrer_host: deriveReferrerHost(referrer, host) }
	const row = clampFields(
		clampFields(derived, META_DIMENSION_FIELDS, META_MAX_DIMENSION_BYTES),
		META_TEXT_FIELDS,
		META_MAX_TEXT_BYTES,
	)
	if (!("user_traits" in row)) return row
	const traits = row.user_traits
	return isRecord(traits)
		? {
				...row,
				user_traits: clampStringMap(
					traits,
					META_MAX_TRAITS,
					META_MAX_TRAIT_KEY_BYTES,
					META_MAX_TRAIT_VALUE_BYTES,
				),
			}
		: Rec.remove(row, "user_traits")
}

/** One distilled event clamped, or none when its type is unknown. */
export const sanitizeSessionEvent = (input: Row): Option.Option<Row> => {
	if (typeof input.type !== "string" || !SESSION_EVENT_TYPES.has(input.type)) return Option.none()
	const row = { ...input }
	if (typeof row.message === "string") row.message = truncateUtf8(row.message, EVENT_MAX_MESSAGE_BYTES)
	if (isRecord(row.attributes))
		row.attributes = clampStringMap(
			row.attributes,
			EVENT_MAX_ATTRIBUTES,
			EVENT_MAX_ATTRIBUTE_KEY_BYTES,
			EVENT_MAX_ATTRIBUTE_VALUE_BYTES,
		)
	return Option.some(row)
}

// --- body decoding ---------------------------------------------------------

const isBufferTooLarge = Schema.is(Schema.Struct({ code: Schema.Literal("ERR_BUFFER_TOO_LARGE") }))

const describe = (error: unknown): string =>
	isRecord(error) && typeof error.message === "string" ? error.message : String(error)

/** Gunzip with an output cap: over it is a 413, a corrupt stream a 400. */
export const gunzipBounded = (
	raw: Uint8Array,
	maximumBytes: number,
): Result.Result<Uint8Array, SessionIngestRejected> =>
	Result.try({
		try: (): Uint8Array => gunzipSync(raw, { maxOutputLength: maximumBytes }),
		catch: (error) =>
			isBufferTooLarge(error)
				? reject(413, `decompressed body exceeds ${maximumBytes} bytes`)
				: reject(400, `invalid gzip body: ${describe(error)}`),
	})

const decodeUtf8 = (bytes: Uint8Array): Result.Result<string, SessionIngestRejected> =>
	Result.try({
		try: (): string => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		catch: () => reject(400, "body is not valid UTF-8"),
	})

const decodeJsonLine = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))

/** One object per non-blank line. A malformed line fails the request, as the hosted gateway does. */
export const parseNdjson = (
	text: string,
	what: string,
): Result.Result<ReadonlyArray<Row>, SessionIngestRejected> => {
	const rows: Row[] = []
	for (const line of Str.split("\n")(text)) {
		if (Str.trim(line) === "") continue
		const parsed = decodeJsonLine(line)
		if (Result.isFailure(parsed)) return Result.fail(reject(400, `invalid ${what} JSON`))
		if (!isRecord(parsed.success)) return Result.fail(reject(400, `${what} must be a JSON object`))
		rows.push(parsed.success)
	}
	return Result.succeed(rows)
}

const ndjsonBody = (body: Uint8Array, headers: Headers, what: string) =>
	Result.flatMap(
		Str.includes("gzip")(headers.get("content-encoding") ?? "")
			? gunzipBounded(body, MAX_SESSION_NDJSON_BYTES)
			: Result.succeed(body),
		(bytes) => Result.flatMap(decodeUtf8(bytes), (text) => parseNdjson(text, what)),
	)

const hasText = (row: Row, field: string): boolean => typeof row[field] === "string" && row[field] !== ""

// --- handlers --------------------------------------------------------------

type Inserts = {
	readonly insert: (batches: ReadonlyArray<InsertBatch>) => Effect.Effect<number, LocalInsertError>
}

const toNdjson = (rows: ReadonlyArray<Row>): string =>
	Arr.join(
		Arr.map(rows, (row) => encodeJson(row)),
		"\n",
	)

const insertRows = (inserts: Inserts, datasource: string, rows: ReadonlyArray<Row>) =>
	rows.length === 0
		? Effect.succeed(0)
		: Effect.uninterruptible(inserts.insert([{ datasource, ndjson: toNdjson(rows) }])).pipe(
				Effect.mapError((error) =>
					reject(500, `chDB insert (${error.datasource}): ${describe(error.cause)}`),
				),
			)

const jsonResponse = (body: unknown): Response =>
	new Response(encodeJson(body), { status: 200, headers: { "content-type": "application/json" } })

const recover = (self: Effect.Effect<SessionIngestResult, SessionIngestRejected>) =>
	self.pipe(
		Effect.catchTag("@maple/cli/SessionIngestRejected", (error) =>
			Effect.succeed({
				response: new Response(error.message, {
					status: error.status,
					headers: { "content-type": "text/plain" },
				}),
				accepted: 0,
				dropped: 0,
			}),
		),
	)

/** `POST /v1/sessionReplays/meta`: NDJSON session metadata into `session_replays`. */
export const ingestSessionMeta = (
	inserts: Inserts,
	headers: Headers,
	body: Uint8Array,
): Effect.Effect<SessionIngestResult> =>
	recover(
		Effect.gen(function* () {
			const parsed = yield* Effect.fromResult(ndjsonBody(body, headers, "session metadata"))
			const columns = sessionColumns("session_replays")
			const rows = Arr.filter(
				Arr.map(parsed, (row) => projectRow(columns, sanitizeSessionMeta(row))),
				// Without these the row is unplayable and lands in 1970's partition.
				(row) => hasText(row, "session_id") && typeof row.start_time === "string",
			)
			const accepted = yield* insertRows(inserts, "session_replays", rows)
			return { response: jsonResponse({ accepted }), accepted, dropped: parsed.length - rows.length }
		}),
	)

/** `POST /v1/sessionEvents`: NDJSON distilled events into `session_events`. Custom and
 *  navigation rows reach `product_events` through the local `product_events_mv`. */
export const ingestSessionEvents = (
	inserts: Inserts,
	headers: Headers,
	body: Uint8Array,
): Effect.Effect<SessionIngestResult> =>
	recover(
		Effect.gen(function* () {
			const parsed = yield* Effect.fromResult(ndjsonBody(body, headers, "session event"))
			const columns = sessionColumns("session_events")
			const rows = Arr.filter(
				Arr.flatMap(parsed, (row) =>
					Option.match(sanitizeSessionEvent(row), {
						onNone: () => [],
						onSome: (clean) => [projectRow(columns, clean)],
					}),
				),
				(row) => hasText(row, "session_id") && typeof row.timestamp === "string",
			)
			const accepted = yield* insertRows(inserts, "session_events", rows)
			return { response: jsonResponse({ accepted }), accepted, dropped: parsed.length - rows.length }
		}),
	)

const SAFE_REPLAY_ID = /^[A-Za-z0-9_-]{1,128}$/
const U32_TEXT = /^\+?\d{1,10}$/

const header = (headers: Headers, name: string): string | undefined => {
	const value = Str.trim(headers.get(name) ?? "")
	return value === "" ? undefined : value
}

const parseU32 = (value: string | undefined): number | undefined => {
	if (value === undefined || !U32_TEXT.test(value)) return undefined
	const parsed = Number(value)
	return parsed <= 4_294_967_295 ? parsed : undefined
}

/** `DateTime64(9)` text in UTC, the form the hosted gateway stamps chunks with. */
export const formatChTimestamp = (ms: number): string =>
	`${Str.replace("T", " ")(Str.slice(0, 23)(new Date(ms).toISOString()))}000000`

/** `POST /v1/sessionReplays/blob`: one gzipped rrweb chunk into `session_replay_events`,
 *  its events stored inline (there is no blob store locally). */
export const ingestSessionBlob = (
	inserts: Inserts,
	headers: Headers,
	body: Uint8Array,
): Effect.Effect<SessionIngestResult> =>
	recover(
		Effect.gen(function* () {
			const sessionId = header(headers, "x-maple-session-id")
			if (sessionId === undefined) return yield* reject(400, "missing x-maple-session-id header")
			if (!SAFE_REPLAY_ID.test(sessionId)) return yield* reject(400, "invalid x-maple-session-id")
			const chunkSeq = parseU32(header(headers, "x-maple-chunk-seq"))
			if (chunkSeq === undefined)
				return yield* reject(400, "missing or invalid x-maple-chunk-seq header")
			const checkpoint = header(headers, "x-maple-is-checkpoint")
			const inflated = yield* Effect.fromResult(gunzipBounded(body, MAX_REPLAY_CHUNK_BYTES))
			const events = yield* Effect.fromResult(decodeUtf8(inflated))
			const nowMs = yield* Clock.currentTimeMillis
			const row = {
				session_id: sessionId,
				chunk_seq: chunkSeq,
				timestamp: formatChTimestamp(nowMs),
				duration_ms: parseU32(header(headers, "x-maple-duration-ms")) ?? 0,
				event_count: parseU32(header(headers, "x-maple-event-count")) ?? 0,
				byte_size: inflated.length,
				events,
				is_checkpoint: checkpoint === "1" || Str.toLowerCase(checkpoint ?? "") === "true" ? 1 : 0,
			}
			const accepted = yield* insertRows(inserts, "session_replay_events", [row])
			return { response: new Response(null, { status: 200 }), accepted, dropped: 0 }
		}),
	)

export const ingestSession = (
	route: SessionRoute,
	inserts: Inserts,
	headers: Headers,
	body: Uint8Array,
): Effect.Effect<SessionIngestResult> => {
	switch (route) {
		case "meta":
			return ingestSessionMeta(inserts, headers, body)
		case "events":
			return ingestSessionEvents(inserts, headers, body)
		case "blob":
			return ingestSessionBlob(inserts, headers, body)
	}
}

/** Raw body cap per route, applied before any inflation. */
export const sessionBodyLimit = (route: SessionRoute): number =>
	route === "blob" ? MAX_REPLAY_CHUNK_BYTES : MAX_SESSION_NDJSON_BYTES
