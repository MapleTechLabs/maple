// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
// The local Maple server: OTLP/HTTP ingest + a raw SQL query API + the bundled
// SPA, all on one port, backed by an embedded chDB. Replaces the Rust
// `apps/ingest/src/bin/local.rs`. `maple start` calls `startServer`.

import { Effect, Layer, Predicate, Result, Schema, type Scope } from "effect"
import * as ManagedRuntime from "effect/ManagedRuntime"
import { gunzipSync } from "node:zlib"
import { TelemetryLayer } from "../core/telemetry"
import { isLoopbackHostname } from "../lib/local-address"
import { MAPLE_VERSION } from "../version"
import {
	acquireChdb,
	type Chdb,
	ChdbError,
	configureRawTelemetryRetentionDays,
	readRawTelemetryRetentionDays,
	rawTelemetryTtlStatements,
} from "./chdb"
import { buildInsertStatements } from "./inserts"
import {
	eventingControlSnapshotPath,
	type EventConsumerFailure,
	type EventingControlStoreError,
	LocalEventingControlConfig,
	LocalEventingControlStore,
	writeControlSnapshot,
} from "./eventing/control-store"
import { ensureEventConsumerToken, eventConsumerTokenMatches } from "./eventing/consumer-auth"
import { LocalEventingRuntime, type LocalEventingRuntimeApi } from "./eventing/runtime"
import { encodeLogs, encodeMetrics, encodeTraces, type EncodedBatch, OtlpFieldError } from "./otlp/encode"
import {
	decodeLogsRequest,
	decodeMetricsRequest,
	decodeTraceRequest,
	encodeExportResponse,
} from "./otlp/proto"
import { CURRENT_LOCAL_SCHEMA, LOCAL_SCHEMA_SQL, SCHEMA_FINGERPRINT } from "./schema-identity"
import { assertCurrentPhysicalSchema } from "./schema-physical"
import { ensureStoreMarkerDurable } from "./store-version"
import {
	ensureMaintenanceToken,
	maintenanceTokenMatches,
	RetiredDayAuthority,
	retireLiveDayInServer,
} from "./archives/retention"

/** Resolves a request path to a static asset (the bundled SPA). Returns
 *  `undefined` to fall through to the SPA shell (client-side routing). */
export interface AssetResolver {
	(pathname: string): { readonly body: Uint8Array | string; readonly contentType: string } | undefined
}

export interface ServerOptions {
	readonly hostname: string
	/** URL hostnames permitted to use the embedded UI same-origin. This also
	 * rejects browser DNS-rebinding hosts that were never advertised. */
	readonly browserHosts: readonly string[]
	/** Exact separately hosted UI origin allowed to reach the local listener. */
	readonly corsOrigin: string
	readonly port: number
	readonly dataDir: string
	readonly configFile?: string
	readonly minimumRawTelemetryRetentionDays?: number
	/** Serves the bundled SPA; omit to disable the UI (API-only). */
	readonly assets?: AssetResolver
}

export class ServerBindError extends Schema.TaggedError<ServerBindError>()("@maple/cli/ServerBindError", {
	hostname: Schema.String,
	port: Schema.Number,
	message: Schema.String,
}) {}

export const isBrowserOriginAllowed = (
	requestUrl: URL,
	origin: string | null,
	corsOrigin: string,
	browserHosts: readonly string[],
): boolean => {
	if (origin === null) return true // SDKs, collectors, and other non-browser clients
	let originUrl: URL
	try {
		originUrl = new URL(origin)
	} catch {
		return false
	}
	if (originUrl.origin === corsOrigin) return true
	// Loopback aliases and dev-proxy ports are equivalent local origins. Require
	// both sides to be loopback so this exception cannot weaken LAN DNS-rebinding
	// protection.
	if (isLoopbackHostname(originUrl.hostname) && isLoopbackHostname(requestUrl.hostname)) return true
	// Bun constructs requestUrl from the client's Host header. Keep that behavior:
	// this comparison is the load-bearing DNS-rebinding check for non-loopback UI traffic.
	// Compare host (including port), not scheme: a TLS reverse proxy may preserve
	// Host while forwarding to this HTTP listener. Restrict the hostname to the
	// bind/connect/advertised set so a DNS-rebinding origin cannot claim itself as
	// a same-origin embedded dashboard.
	return originUrl.host === requestUrl.host && browserHosts.includes(originUrl.hostname)
}

/** Build CORS headers for an origin that has already passed
 * `isBrowserOriginAllowed`. Echoing it preserves browser OTLP ingest between
 * loopback aliases and ports without restoring wildcard CORS.
 *
 * `authorization` is allowed because every browser SDK sends
 * `Authorization: Bearer <ingest key>` once one is configured — the same bundle
 * that ships to production is what people point at `maple start`. Rejecting the
 * header in preflight blocked those pages entirely (and `@maple-dev/browser`,
 * which requires an ingest key, could never reach local mode at all). Nothing
 * is weakened by allowing it: this listener authenticates nothing, it gates on
 * request origin, and `/v1/*` never reads the header's value. */
export const corsHeadersForAllowedOrigin = (
	origin: string | null,
): Readonly<Record<string, string>> | undefined =>
	origin !== null
		? {
				"access-control-allow-origin": origin,
				"access-control-allow-methods": "GET, POST, OPTIONS",
				// `x-maple-sdk` is the SDK identity hint every browser SDK sends on
				// every request; a listener that does not allow it fails preflight
				// for the whole SDK.
				"access-control-allow-headers": "content-type, content-encoding, authorization, x-maple-sdk",
				"access-control-allow-private-network": "true",
				vary: "Origin",
			}
		: undefined

const withCors = (response: Response, headers: Readonly<Record<string, string>> | undefined): Response => {
	if (headers) for (const [name, value] of Object.entries(headers)) response.headers.set(name, value)
	return response
}

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	})

const text = (body: string, status = 200, contentType = "text/plain"): Response =>
	new Response(body, { status, headers: { "content-type": contentType } })

/**
 * A message for a thrown value of unknown shape that is never `{}` or
 * `[object Object]`.
 *
 * `(error as Error).message` was the idiom here, and a throw that was not an
 * `Error` — or was an `Error` subclass carrying its detail elsewhere — reduced to
 * `undefined` or to an empty JSON object. Production carried 94 spans reading
 * exactly `Error: {}` at `POST /v1/traces`: the throw survived all the way to the
 * tracer, which fingerprinted it into one issue with no message, no type, and no
 * stack beyond the span name. Nothing about it could be diagnosed.
 *
 * So every branch here must yield something a human can act on, and the last
 * resort names the shape rather than pretending to describe it.
 */
export const describeThrown = (error: unknown): string => {
	if (error instanceof Error && error.message !== "") return error.message
	if (typeof error === "string" && error !== "") return error
	if (error !== null && typeof error === "object") {
		// Both reads are inside the try: `message` may be a getter that throws, and
		// reading it outside would defeat the whole point of this function.
		try {
			// `in` narrows without invoking the getter; the read below is what can
			// throw, and it is inside the try for exactly that reason.
			if ("message" in error) {
				const message = error.message
				if (typeof message === "string" && message !== "") return message
			}
			const json = JSON.stringify(error)
			// `{}` here means every own property was non-enumerable or unserializable
			// (a `Response`, a class instance) — the empty object is the bug, so say so.
			if (json !== undefined && json !== "{}") return json
		} catch {
			// Circular, or a getter that throws. Fall through to the constructor name.
		}
		return `non-serializable ${error.constructor?.name ?? "object"} thrown`
	}
	return `${typeof error} thrown: ${String(error)}`
}

type Signal = "traces" | "logs" | "metrics"

/** Decode an OTLP request body (protobuf by default, JSON when content-type
 *  says so), transparently gunzipping a gzip content-encoding. */
function decodeOtlp(
	signal: Signal,
	raw: Uint8Array,
	contentType: string,
	contentEncoding: string | null,
): unknown {
	let bytes = raw
	if (contentEncoding && contentEncoding.includes("gzip")) {
		bytes = gunzipSync(raw)
	}
	const isJson = contentType.includes("json")
	if (isJson) {
		return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
			new TextDecoder().decode(bytes),
		)
	}
	switch (signal) {
		case "traces":
			return decodeTraceRequest(bytes)
		case "logs":
			return decodeLogsRequest(bytes)
		case "metrics":
			return decodeMetricsRequest(bytes)
	}
}

function encodeFor(signal: Signal, req: unknown): EncodedBatch[] {
	switch (signal) {
		case "traces":
			return encodeTraces(req)
		case "logs":
			return encodeLogs(req)
		case "metrics":
			return encodeMetrics(req)
	}
}

interface IngestResult {
	readonly response: Response
	readonly accepted: number
	readonly requestBytes: number
}

/** An ingest step that ends the request early; the carried result is the response. */
class IngestStopped extends Schema.TaggedError<IngestStopped>()("@maple/cli/IngestStopped", {
	message: Schema.String,
	response: Schema.instanceOf(Response),
	accepted: Schema.Number,
	requestBytes: Schema.Number,
}) {}

const stopIngest = (response: Response, requestBytes: number, accepted = 0): IngestStopped =>
	new IngestStopped({ message: `HTTP ${response.status}`, response, accepted, requestBytes })

/**
 * A malformed field or an in-batch identity collision fails identically on every
 * retry, so it is a 400; OTLP exporters retry 503 and would resend the batch forever.
 */
const projectionFailure =
	(signal: Signal, requestBytes: number, status: 400 | 503) =>
	(error: { readonly message: string }): Effect.Effect<never, IngestStopped> =>
		Effect.fail(stopIngest(text(`event projection ${signal}: ${error.message}`, status), requestBytes))

const ingest = (
	db: Pick<Chdb, "exec">,
	authority: RetiredDayAuthority,
	signal: Signal,
	req: Request,
): Effect.Effect<IngestResult, never, LocalEventingRuntime> =>
	Effect.gen(function* () {
		const eventing = yield* LocalEventingRuntime
		// A client that hangs up mid-body rejects here. It is a caller outcome, so 400 it.
		const raw = yield* Effect.tryPromise({
			try: async () => new Uint8Array(await req.arrayBuffer()),
			catch: (error) => stopIngest(text(`read ${signal} body: ${describeThrown(error)}`, 400), 0),
		})
		const requestBytes = raw.length
		const contentType = req.headers.get("content-type") ?? ""
		const contentEncoding = req.headers.get("content-encoding")
		const decoded = yield* Effect.try({
			try: () => decodeOtlp(signal, raw, contentType, contentEncoding),
			catch: (error) =>
				stopIngest(text(`decode ${signal}: ${describeThrown(error)}`, 400), requestBytes),
		})
		const rejectProjection = (status: 400 | 503) => projectionFailure(signal, requestBytes, status)
		const evaluation = yield* eventing
			.evaluateOtlp(signal, decoded, (rangeDate) => authority.isRetired(rangeDate))
			.pipe(
				Effect.catchTags({
					"@maple/cli/OtlpFieldError": rejectProjection(400),
					"@maple/cli/eventing/SourceOccurrenceCollision": rejectProjection(400),
					"@maple/cli/eventing/StagedOccurrenceUnrecoverable": rejectProjection(503),
					"@maple/cli/eventing/SourceOccurrenceInvalid": rejectProjection(503),
					"@maple/eventing-core/ProjectionInvalid": rejectProjection(503),
					"@maple/cli/eventing/ControlStoreFailed": rejectProjection(503),
				}),
				Effect.catchDefect((defect) => rejectProjection(503)({ message: describeThrown(defect) })),
			)
		// A malformed field is the sender's fault, not ours: reject the batch with a
		// 400 naming the field instead of silently storing a bad value.
		let batches = yield* Effect.try({
			try: () => encodeFor(signal, decoded),
			catch: (error) =>
				error instanceof OtlpFieldError
					? stopIngest(text(`decode ${signal}: ${error.message}`, 400), requestBytes)
					: stopIngest(text(`encode ${signal}: ${describeThrown(error)}`, 500), requestBytes),
		})
		const staged = yield* eventing.persistFailures(evaluation.failures).pipe(
			Effect.andThen(
				evaluation.events.length > 0
					? eventing.stage(evaluation.events, evaluation.eventSourceFingerprints)
					: Effect.succeed({ inserted: 0, deduplicated: 0, dropped: 0, eventIds: [] }),
			),
			Effect.catchTag("@maple/cli/eventing/ControlStoreFailed", rejectProjection(503)),
			Effect.catchDefect((defect) => rejectProjection(503)({ message: describeThrown(defect) })),
		)
		let rejected = 0
		batches = batches.map((batch) => {
			const filtered = authority.filterBatch(batch.datasource, batch.ndjson)
			rejected += filtered.rejected
			return { ...batch, ndjson: filtered.ndjson, rowCount: filtered.accepted }
		})
		let accepted = 0
		for (const batch of batches) {
			if (batch.rowCount === 0) continue
			for (const statement of buildInsertStatements(batch.datasource, batch.ndjson)) {
				const inserted = Result.try(() => db.exec(statement.sql))
				if (Result.isFailure(inserted))
					return yield* stopIngest(
						text(`chDB insert (${batch.datasource}): ${describeThrown(inserted.failure)}`, 500),
						requestBytes,
						accepted,
					)
				accepted += statement.rowCount
			}
		}
		const readyEventIds = [...evaluation.recoveredEventIds, ...staged.eventIds]
		const readinessFailed = (message: string) =>
			Effect.fail(
				stopIngest(text(`event outbox readiness ${signal}: ${message}`, 503), requestBytes, accepted),
			)
		if (readyEventIds.length > 0)
			yield* eventing.markReady(readyEventIds).pipe(
				Effect.catchTag("@maple/cli/eventing/ControlStoreFailed", (error) =>
					readinessFailed(error.message),
				),
				Effect.catchDefect((defect) => readinessFailed(describeThrown(defect))),
			)
		const droppedEvents = staged.dropped
		const errorMessage = rejected > 0 ? "telemetry from permanently retired UTC days was rejected" : ""
		if (contentType.includes("json")) {
			const rejectedField =
				signal === "traces"
					? { rejectedSpans: rejected }
					: signal === "logs"
						? { rejectedLogRecords: rejected }
						: { rejectedDataPoints: rejected }
			const response = json(rejected > 0 ? { partialSuccess: { ...rejectedField, errorMessage } } : {})
			if (droppedEvents > 0) response.headers.set("x-maple-eventing-dropped", String(droppedEvents))
			return { response, accepted, requestBytes }
		}
		const response = new Response(encodeExportResponse(signal, rejected, errorMessage), {
			status: 200,
			headers: { "content-type": "application/x-protobuf" },
		})
		if (droppedEvents > 0) response.headers.set("x-maple-eventing-dropped", String(droppedEvents))
		return { response, accepted, requestBytes }
	}).pipe(
		Effect.catchTag("@maple/cli/IngestStopped", ({ response, accepted, requestBytes }) =>
			Effect.succeed({ response, accepted, requestBytes }),
		),
		// Anything thrown outside a mapped step keeps its old meaning: a 500 with a real message.
		Effect.catchDefect((defect) =>
			Effect.succeed({
				response: text(`ingest ${signal}: ${describeThrown(defect)}`, 500),
				accepted: 0,
				requestBytes: 0,
			}),
		),
	)

/**
 * Strip a trailing `FORMAT <ident>` clause (optionally followed by `;`) and
 * re-append `FORMAT JSONEachRow`, so the server owns the output format. Port of
 * `force_json_each_row` from the former Rust server: callers POST `compiled.sql`
 * verbatim, and a compiled query carries its own `FORMAT JSON`.
 */
function forceJsonEachRow(sql: string): string {
	let s = sql.trimEnd()
	if (s.endsWith(";")) s = s.slice(0, -1).trimEnd()
	const lower = s.toLowerCase()
	const pos = lower.lastIndexOf("format")
	if (pos !== -1) {
		const beforeOk = pos === 0 || /\s/.test(s[pos - 1]!)
		const rest = s.slice(pos + "format".length)
		const afterOk = rest.length > 0 && /\s/.test(rest[0]!)
		const ident = rest.trim()
		const isIdent = ident.length > 0 && /^[A-Za-z0-9_]+$/.test(ident)
		if (beforeOk && afterOk && isIdent) s = s.slice(0, pos).trimEnd()
	}
	return `${s}\nFORMAT JSONEachRow`
}

interface QueryResult {
	readonly response: Response
	readonly rowCount: number
	readonly durationMs: number
	readonly sql: string | undefined
}

async function handleQuery(db: Chdb, authority: RetiredDayAuthority, req: Request): Promise<QueryResult> {
	let sql: string
	try {
		const body = (await req.json()) as { sql?: unknown }
		if (typeof body.sql !== "string")
			return { response: text("missing 'sql' string", 400), rowCount: 0, durationMs: 0, sql: undefined }
		sql = body.sql
	} catch {
		return { response: text("invalid JSON body", 400), rowCount: 0, durationMs: 0, sql: undefined }
	}
	let out: string
	const started = performance.now()
	const readOnly = /^\s*(?:SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN|EXISTS)\b/i.test(sql)
	if (!readOnly && authority.hasRetiredDays()) {
		return {
			response: text("local SQL writes are disabled after the first UTC day is retired", 405),
			rowCount: 0,
			durationMs: Math.round(performance.now() - started),
			sql,
		}
	}
	try {
		out = db.query(forceJsonEachRow(sql))
	} catch (error) {
		// 400, not 500: a failing statement is a problem with the submitted SQL,
		// and a 5xx would make the shared warehouse executor classify it as a
		// transient upstream error and retry the identical query.
		return {
			response: text(`query failed: ${describeThrown(error)}`, 400),
			rowCount: 0,
			durationMs: Math.round(performance.now() - started),
			sql,
		}
	}
	const durationMs = Math.round(performance.now() - started)
	// chDB returns JSONEachRow (one JSON object per line). Wrap the lines into a
	// JSON array without re-parsing each row.
	const rows = out
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
	return {
		response: text(`[${rows.join(",")}]`, 200, "application/json"),
		rowCount: rows.length,
		durationMs,
		sql,
	}
}

function serveAsset(assets: AssetResolver, pathname: string): Response {
	const path = pathname === "/" ? "index.html" : pathname.replace(/^\//, "")
	const hit = assets(path)
	if (hit) return new Response(hit.body, { headers: { "content-type": hit.contentType } })
	// Unknown path → serve the SPA shell so the client router can take over.
	const shell = assets("index.html")
	if (shell) return new Response(shell.body, { headers: { "content-type": "text/html" } })
	return text("UI not built", 404)
}

// Cap `db.query.text` at 16 KB to match apps/api's WarehouseQueryService span.
const MAX_DB_QUERY_TEXT = 16 * 1024
const truncateSql = (sql: string) => (sql.length > MAX_DB_QUERY_TEXT ? sql.slice(0, MAX_DB_QUERY_TEXT) : sql)

/** The services every request effect may use; `startServer` builds them into one runtime. */
type RequestServices = LocalEventingRuntime | LocalEventingControlStore

/** Runs a request's effect on the server's tracing runtime (see `startServer`).
 *  The effect always succeeds with a `Response`. */
type SpanRunner = <A>(effect: Effect.Effect<A, never, RequestServices>) => Promise<A>

// A rejected 5xx ingest/query response, surfaced through the Effect error
// channel. `message` carries the handler's descriptive body so the span records
// a real `exception.message`; `response` is the original, untouched response we
// hand back to the client in `recoverResponse`. (Failing with a bare `Response`
// recorded an empty `{}` — a `Response` has no enumerable own fields — which lost
// the cause entirely and bucketed every failure under one "Error" fingerprint.)
class IngestRejected extends Schema.TaggedError<IngestRejected>()("@maple/cli/IngestRejected", {
	response: Schema.instanceOf(Response),
	status: Schema.Number,
	message: Schema.String,
}) {}

// The Effect tracer derives span status from the effect's outcome. OTel HTTP
// Server semantics treat 4xx as a successful server outcome (the caller sent a
// bad request) and only 5xx as Error. Annotate every rejection, but fail inside
// the Server span only for 5xx; recover the original response outside the span.
const recordServerResponse = (response: Response): Effect.Effect<Response, IngestRejected> =>
	Effect.gen(function* () {
		if (response.status >= 400) {
			// Clone to read the body without consuming the response we return below.
			const body = (yield* Effect.promise(() => response.clone().text())).trim()
			const message = body.length > 0 ? body : `HTTP ${response.status}`
			yield* Effect.annotateCurrentSpan({ "error.type": `HTTP ${response.status}` })
			if (response.status >= 500) {
				return yield* new IngestRejected({ response, status: response.status, message })
			}
		}
		return response
	})

const recoverResponse = <R>(
	self: Effect.Effect<Response, IngestRejected, R>,
): Effect.Effect<Response, never, R> =>
	Effect.match(self, { onFailure: (error) => error.response, onSuccess: (response) => response })

/** OTLP-ingest request as a `Server`-kind span, mirroring the Rust gateway
 *  (`apps/ingest`): `maple.signal`, item count, request size, HTTP semconv. */
const ingestSpan = (
	db: Chdb,
	authority: RetiredDayAuthority,
	signal: Signal,
	req: Request,
): Effect.Effect<Response, never, LocalEventingRuntime> =>
	recoverResponse(
		Effect.gen(function* () {
			const { response, accepted, requestBytes } = yield* ingest(db, authority, signal, req)
			yield* Effect.annotateCurrentSpan({
				"http.request.body.size": requestBytes,
				"maple.ingest.item_count": accepted,
				"http.response.status_code": response.status,
			})
			return yield* recordServerResponse(response)
		}).pipe(
			Effect.withSpan(`POST /v1/${signal}`, {
				kind: "server",
				attributes: {
					"maple.signal": signal,
					"http.request.method": "POST",
					"http.route": `/v1/${signal}`,
				},
			}),
		),
	)

/** `/local/query` request as a `Server`-kind span with the canonical DB attrs. */
const querySpan = (db: Chdb, authority: RetiredDayAuthority, req: Request): Effect.Effect<Response> =>
	recoverResponse(
		Effect.gen(function* () {
			const { response, rowCount, durationMs, sql } = yield* Effect.promise(() =>
				handleQuery(db, authority, req),
			)
			yield* Effect.annotateCurrentSpan({
				"db.system.name": "clickhouse",
				"db.duration_ms": durationMs,
				"result.rowCount": rowCount,
				"http.response.status_code": response.status,
				...(sql ? { "db.query.text": truncateSql(sql), "db.query.length": sql.length } : undefined),
			})
			return yield* recordServerResponse(response)
		}).pipe(
			Effect.withSpan("POST /local/query", {
				kind: "server",
				attributes: { "http.request.method": "POST", "http.route": "/local/query" },
			}),
		),
	)

/** Admission closes before retirement and reopens only after all previously
 * accepted ingest/query work has drained and the durable transition finishes. */
export class RequestQuiescenceGate {
	#active = 0
	#closed = false
	#drained: Array<() => void> = []

	enter(): (() => void) | null {
		if (this.#closed) return null
		this.#active++
		let released = false
		return () => {
			if (released) return
			released = true
			this.#active--
			if (this.#active === 0) {
				for (const resolve of this.#drained.splice(0)) resolve()
			}
		}
	}

	#drain(): Promise<void> {
		return this.#active > 0
			? new Promise<void>((resolve) => this.#drained.push(resolve))
			: Promise.resolve()
	}

	async exclusive<A>(work: () => Promise<A>): Promise<A> {
		if (this.#closed) throw MaintenanceInProgressError.create()
		this.#closed = true
		try {
			await this.#drain()
			return await work()
		} finally {
			this.#closed = false
		}
	}

	/** `exclusive` for Effect work; closing is uninterruptible and reopening always runs. */
	exclusiveEffect<A, E, R>(
		work: Effect.Effect<A, E, R>,
	): Effect.Effect<A, E | MaintenanceInProgressError, R> {
		return Effect.acquireUseRelease(
			Effect.suspend(() => {
				if (this.#closed) return Effect.fail(MaintenanceInProgressError.create())
				this.#closed = true
				return Effect.void
			}),
			() => Effect.promise(() => this.#drain()).pipe(Effect.andThen(work)),
			() =>
				Effect.sync(() => {
					this.#closed = false
				}),
		)
	}
}

class MaintenanceInProgressError extends Schema.TaggedError<MaintenanceInProgressError>()(
	"@maple/cli/MaintenanceInProgress",
	{ message: Schema.String },
) {
	static create() {
		return new MaintenanceInProgressError({ message: "another server maintenance operation is active" })
	}
}

class RequestBodyTooLargeError extends Schema.TaggedError<RequestBodyTooLargeError>()(
	"@maple/cli/RequestBodyTooLarge",
	{ message: Schema.String, maximumBytes: Schema.Number },
) {
	static create(maximumBytes: number) {
		return new RequestBodyTooLargeError({
			message: `request body exceeds ${maximumBytes} bytes`,
			maximumBytes,
		})
	}
}

/** The body could not be read or is not JSON. */
class RequestBodyInvalidError extends Schema.TaggedError<RequestBodyInvalidError>()(
	"@maple/cli/RequestBodyInvalid",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

const bodyInvalid = (cause: unknown): RequestBodyInvalidError =>
	new RequestBodyInvalidError({ message: describeThrown(cause), cause })

const decodeJsonBody = (body: string): Effect.Effect<unknown, RequestBodyInvalidError> =>
	Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(body).pipe(Effect.mapError(bodyInvalid))

const readBoundedJson = (
	req: Request,
	maximumBytes: number,
): Effect.Effect<unknown, RequestBodyTooLargeError | RequestBodyInvalidError> =>
	Effect.gen(function* () {
		const contentLength = req.headers.get("content-length")
		if (contentLength !== null && /^[0-9]+$/.test(contentLength)) {
			const declared = Number(contentLength)
			if (!Number.isSafeInteger(declared) || declared > maximumBytes)
				return yield* RequestBodyTooLargeError.create(maximumBytes)
		}
		const body = req.body
		if (body === null) return yield* decodeJsonBody("")
		const bytes = yield* Effect.acquireUseRelease(
			Effect.sync(() => body.getReader()),
			(reader) =>
				Effect.gen(function* () {
					const chunks: Uint8Array[] = []
					let total = 0
					while (true) {
						const { done, value } = yield* Effect.tryPromise({
							try: () => reader.read(),
							catch: bodyInvalid,
						})
						if (done) break
						total += value.byteLength
						if (total > maximumBytes) {
							yield* Effect.tryPromise({ try: () => reader.cancel(), catch: bodyInvalid })
							return yield* RequestBodyTooLargeError.create(maximumBytes)
						}
						chunks.push(value)
					}
					const bytes = new Uint8Array(total)
					let offset = 0
					for (const chunk of chunks) {
						bytes.set(chunk, offset)
						offset += chunk.byteLength
					}
					return bytes
				}),
			(reader) => Effect.sync(() => reader.releaseLock()),
		)
		return yield* decodeJsonBody(new TextDecoder().decode(bytes))
	})

/** The 409 and 413 a maintenance request reports on purpose; any other body failure is a 400. */
const recoverBodyFailure = <R>(
	self: Effect.Effect<Response, RequestBodyTooLargeError | RequestBodyInvalidError, R>,
): Effect.Effect<Response, never, R> =>
	self.pipe(
		Effect.catchTags({
			"@maple/cli/RequestBodyTooLarge": (error) => Effect.succeed(text(error.message, 413)),
			"@maple/cli/RequestBodyInvalid": () => Effect.succeed(text("invalid JSON body", 400)),
		}),
	)

const admitted = <R>(
	gate: RequestQuiescenceGate,
	work: Effect.Effect<Response, never, R>,
): Effect.Effect<Response, never, R> =>
	Effect.acquireUseRelease(
		Effect.sync(() => gate.enter()),
		(leave) => (leave ? work : Effect.succeed(text("server maintenance in progress", 503))),
		(leave) => Effect.sync(() => leave?.()),
	)

const handleRetirement = async (
	db: Chdb,
	authority: RetiredDayAuthority,
	gate: RequestQuiescenceGate,
	token: string,
	req: Request,
): Promise<Response> => {
	if (!maintenanceTokenMatches(token, req.headers.get("x-maple-maintenance-token")))
		return text("maintenance authorization required", 403)
	let body: unknown
	try {
		body = await req.json()
	} catch {
		return text("invalid JSON body", 400)
	}
	const decoded = Schema.decodeUnknownResult(
		Schema.Struct({
			archiveDir: Schema.NonEmptyString,
			rangeDate: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
			sealingLagHours: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
		}),
		{ onExcessProperty: "error" },
	)(body)
	if (Result.isFailure(decoded)) return text("invalid retirement fields", 400)
	const record = decoded.success
	try {
		const retired = await gate.exclusive(() =>
			retireLiveDayInServer({
				db,
				authority,
				archiveDir: record.archiveDir,
				rangeDate: record.rangeDate,
				sealingLagHours: record.sealingLagHours,
			}),
		)
		return json(retired)
	} catch (error) {
		return text(`retirement failed: ${error instanceof Error ? error.message : String(error)}`, 409)
	}
}

class EventingStartupError extends Schema.TaggedError<EventingStartupError>()(
	"@maple/cli/eventing/StartupFailed",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

const CHECKPOINT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_CHECKPOINT_BODY_BYTES = 4 * 1024
const MAX_PROJECTION_BODY_BYTES = 512 * 1024
const MAX_CONSUMER_BODY_BYTES = 16 * 1024

/** The chDB half of a checkpoint backup failed. */
class CheckpointBackupFailed extends Schema.TaggedError<CheckpointBackupFailed>()(
	"@maple/cli/CheckpointBackupFailed",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

/** Typed, authenticated replacement for sending BACKUP through /local/query. */
const handleCheckpointBackup = (
	db: Chdb,
	dataDir: string,
	gate: RequestQuiescenceGate,
	token: string,
	req: Request,
): Effect.Effect<Response, never, LocalEventingControlStore> => {
	if (!maintenanceTokenMatches(token, req.headers.get("x-maple-maintenance-token")))
		return Effect.succeed(text("maintenance authorization required", 403))
	return Effect.gen(function* () {
		const body = yield* readBoundedJson(req, MAX_CHECKPOINT_BODY_BYTES)
		const decoded = Schema.decodeUnknownResult(
			Schema.Struct({
				checkpointId: Schema.String.check(Schema.isPattern(CHECKPOINT_ID)),
			}),
			{ onExcessProperty: "error" },
		)(body)
		if (Result.isFailure(decoded)) return text("invalid checkpoint fields", 400)
		const checkpointId = decoded.success.checkpointId.toLowerCase()
		const controlStore = yield* LocalEventingControlStore
		// The gate has drained every admitted request, so neither database changes between captures.
		const controlBytes = yield* gate.exclusiveEffect(
			controlStore.captureSnapshot.pipe(
				Effect.tap(() =>
					Effect.try({
						try: () =>
							db.exec(
								`BACKUP DATABASE default TO Disk('default', 'backups/snapshots/${checkpointId}/backup')`,
							),
						catch: (cause) =>
							new CheckpointBackupFailed({ message: describeThrown(cause), cause }),
					}),
				),
			),
		)
		const control = yield* writeControlSnapshot(
			eventingControlSnapshotPath(dataDir, checkpointId),
			controlBytes,
		)
		return json({ checkpointId, control })
	}).pipe(
		Effect.catchTags({
			"@maple/cli/MaintenanceInProgress": (error) => Effect.succeed(text(error.message, 409)),
			"@maple/cli/RequestBodyTooLarge": (error) => Effect.succeed(text(error.message, 413)),
			"@maple/cli/RequestBodyInvalid": () => Effect.succeed(text("invalid JSON body", 400)),
			"@maple/cli/CheckpointBackupFailed": (error) =>
				Effect.succeed(text(`checkpoint backup failed: ${error.message}`, 400)),
			"@maple/cli/eventing/ControlStoreFailed": (error) =>
				Effect.succeed(text(`checkpoint backup failed: ${error.message}`, 400)),
		}),
	)
}

const eventingAuthorized = (token: string, req: Request): Response | null =>
	maintenanceTokenMatches(token, req.headers.get("x-maple-maintenance-token"))
		? null
		: text("maintenance authorization required", 403)

const handleProjectionActivation = (
	gate: RequestQuiescenceGate,
	token: string,
	req: Request,
): Effect.Effect<Response, never, LocalEventingRuntime> => {
	const unauthorized = eventingAuthorized(token, req)
	if (unauthorized) return Effect.succeed(unauthorized)
	return Effect.gen(function* () {
		const eventing = yield* LocalEventingRuntime
		const body = yield* readBoundedJson(req, MAX_PROJECTION_BODY_BYTES)
		// Recursive schema validation and full registry compilation happen while
		// normal ingest/query admission remains open.
		const activation = yield* eventing.prepareActivation(body).pipe(Effect.result)
		if (Result.isFailure(activation))
			return text(`invalid event projection: ${activation.failure.message}`, 400)
		return yield* gate.exclusiveEffect(eventing.commitActivation(activation.success)).pipe(
			Effect.andThen(eventing.listActive),
			Effect.map((active) => json({ active })),
			Effect.catchTags({
				"@maple/cli/eventing/ProjectionActivationConflict": (error) =>
					Effect.succeed(text(error.message, 409)),
				"@maple/cli/MaintenanceInProgress": (error) => Effect.succeed(text(error.message, 409)),
				"@maple/cli/eventing/ControlStoreFailed": (error) =>
					Effect.succeed(text(`event projection activation failed: ${error.message}`, 500)),
			}),
			Effect.catchDefect((defect) =>
				Effect.succeed(text(`event projection activation failed: ${describeThrown(defect)}`, 500)),
			),
		)
	}).pipe(recoverBodyFailure)
}

const recoverEventConsumerFailure = <R>(
	self: Effect.Effect<Response, EventConsumerFailure, R>,
): Effect.Effect<Response, never, R> =>
	self.pipe(
		Effect.catchTags({
			"@maple/cli/eventing/EventConsumerDeliveryGap": (error) =>
				Effect.succeed(
					json(
						{
							error: error._tag,
							message: error.message,
							consumerId: error.consumerId,
							generation: error.generation,
							droppedEvents: error.droppedEvents,
						},
						409,
					),
				),
			"@maple/cli/eventing/EventConsumerInputInvalid": (error) =>
				Effect.succeed(text(error.message, 400)),
			"@maple/cli/eventing/EventConsumerNotFound": (error) => Effect.succeed(text(error.message, 404)),
			"@maple/cli/eventing/EventConsumerConflict": (error) => Effect.succeed(text(error.message, 409)),
			"@maple/cli/eventing/EventConsumerLeaseConflict": (error) =>
				Effect.succeed(text(error.message, 409)),
			"@maple/cli/eventing/ControlStoreFailed": (error) =>
				Effect.succeed(text(`event consumer operation failed: ${error.message}`, 500)),
		}),
		Effect.catchDefect((defect) =>
			Effect.succeed(text(`event consumer operation failed: ${describeThrown(defect)}`, 500)),
		),
	)

const ConsumerIdSchema = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9._-]{0,63}$/))

/** Decodes a bounded consumer body, then runs the store call under ordinary admission. */
const consumerRequest = <A, S extends Schema.Top & { readonly DecodingServices: never }>(
	gate: RequestQuiescenceGate,
	req: Request,
	schema: S,
	invalidMessage: string,
	run: (eventing: LocalEventingRuntimeApi, decoded: S["Type"]) => Effect.Effect<A, EventConsumerFailure>,
	status = 200,
): Effect.Effect<Response, never, LocalEventingRuntime> =>
	Effect.gen(function* () {
		const eventing = yield* LocalEventingRuntime
		const body = yield* readBoundedJson(req, MAX_CONSUMER_BODY_BYTES)
		const decoded = Schema.decodeUnknownResult(schema, { onExcessProperty: "error" })(body)
		if (Result.isFailure(decoded)) return text(invalidMessage, 400)
		return yield* admitted(
			gate,
			run(eventing, decoded.success).pipe(
				Effect.map((result) => json(result, status)),
				recoverEventConsumerFailure,
			),
		)
	}).pipe(recoverBodyFailure)

const handleConsumerRegistration = (
	gate: RequestQuiescenceGate,
	maintenanceToken: string,
	req: Request,
): Effect.Effect<Response, never, LocalEventingRuntime> =>
	Effect.suspend(() => {
		const unauthorized = eventingAuthorized(maintenanceToken, req)
		if (unauthorized) return Effect.succeed(unauthorized)
		return consumerRequest(
			gate,
			req,
			Schema.Struct({
				consumerId: ConsumerIdSchema,
				startAt: Schema.Literals(["beginning", "latest"]),
			}),
			"invalid event consumer registration fields",
			(eventing, { consumerId, startAt }) => eventing.registerConsumer(consumerId, startAt),
			201,
		)
	})

const handleConsumerDisable = (
	gate: RequestQuiescenceGate,
	maintenanceToken: string,
	req: Request,
): Effect.Effect<Response, never, LocalEventingRuntime> =>
	Effect.suspend(() => {
		const unauthorized = eventingAuthorized(maintenanceToken, req)
		if (unauthorized) return Effect.succeed(unauthorized)
		return consumerRequest(
			gate,
			req,
			Schema.Struct({ consumerId: ConsumerIdSchema }),
			"invalid event consumer disable fields",
			(eventing, { consumerId }) => eventing.disableConsumer(consumerId),
		)
	})

const consumerUnauthorized = (consumerToken: string, req: Request): Response | null =>
	eventConsumerTokenMatches(consumerToken, req.headers.get("x-maple-event-consumer-token"))
		? null
		: text("event consumer authorization required", 403)

const handleConsumerClaim = (
	gate: RequestQuiescenceGate,
	consumerToken: string,
	req: Request,
): Effect.Effect<Response, never, LocalEventingRuntime> =>
	Effect.suspend(() => {
		const unauthorized = consumerUnauthorized(consumerToken, req)
		if (unauthorized) return Effect.succeed(unauthorized)
		return consumerRequest(
			gate,
			req,
			Schema.Struct({
				consumerId: ConsumerIdSchema,
				limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
				leaseSeconds: Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 300 })),
			}),
			"invalid event consumer claim fields",
			(eventing, { consumerId, limit, leaseSeconds }) =>
				eventing.claimReady(consumerId, limit, leaseSeconds),
		)
	})

const handleConsumerAcknowledgement = (
	gate: RequestQuiescenceGate,
	consumerToken: string,
	req: Request,
): Effect.Effect<Response, never, LocalEventingRuntime> =>
	Effect.suspend(() => {
		const unauthorized = consumerUnauthorized(consumerToken, req)
		if (unauthorized) return Effect.succeed(unauthorized)
		return consumerRequest(
			gate,
			req,
			Schema.Struct({
				consumerId: ConsumerIdSchema,
				leaseToken: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
				throughSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
			}),
			"invalid event consumer acknowledgement fields",
			(eventing, { consumerId, leaseToken, throughSequence }) =>
				eventing.acknowledgeClaim(consumerId, leaseToken, throughSequence),
		)
	})

const handleOutboxAdministration = (
	gate: RequestQuiescenceGate,
	token: string,
	req: Request,
	action: "abandon" | "accept-gap",
): Effect.Effect<Response, never, LocalEventingRuntime> => {
	const unauthorized = eventingAuthorized(token, req)
	if (unauthorized) return Effect.succeed(unauthorized)
	return Effect.gen(function* () {
		const eventing = yield* LocalEventingRuntime
		const body = yield* readBoundedJson(req, MAX_PROJECTION_BODY_BYTES)
		if (action === "abandon") {
			const decoded = Schema.decodeUnknownResult(
				Schema.Struct({
					eventIds: Schema.Array(Schema.NonEmptyString.check(Schema.isMaxLength(256))).check(
						Schema.isMinLength(1),
						Schema.isMaxLength(1000),
					),
				}),
				{ onExcessProperty: "error" },
			)(body)
			if (Result.isFailure(decoded)) return text("invalid outbox abandonment fields", 400)
			return yield* gate.exclusiveEffect(eventing.abandonEvents(decoded.success.eventIds)).pipe(
				Effect.map((result) => json(result)),
				Effect.catchTags({
					"@maple/cli/MaintenanceInProgress": (error) => Effect.succeed(text(error.message, 409)),
					"@maple/cli/eventing/OutboxAdministrationInvalid": (error) =>
						Effect.succeed(text(error.message, 400)),
					"@maple/cli/eventing/ControlStoreFailed": (error) =>
						Effect.succeed(text(`event consumer operation failed: ${error.message}`, 500)),
				}),
				Effect.catchDefect((defect) =>
					Effect.succeed(text(`event consumer operation failed: ${describeThrown(defect)}`, 500)),
				),
			)
		}
		const decoded = Schema.decodeUnknownResult(
			Schema.Struct({
				consumerId: ConsumerIdSchema,
				generation: Schema.Int.check(Schema.isGreaterThan(0)),
			}),
			{ onExcessProperty: "error" },
		)(body)
		if (Result.isFailure(decoded)) return text("invalid delivery gap acknowledgement fields", 400)
		const { consumerId, generation } = decoded.success
		return yield* admitted(
			gate,
			eventing.acceptDeliveryGap(consumerId, generation).pipe(
				Effect.map((gap) => json(gap)),
				recoverEventConsumerFailure,
			),
		)
	}).pipe(recoverBodyFailure)
}

const decodeOutboxQuery = Schema.decodeUnknownResult(
	Schema.Struct({
		state: Schema.optionalKey(Schema.Literals(["ready", "staged"])),
		limit: Schema.optionalKey(
			Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 1000 })),
		),
		after: Schema.optionalKey(
			Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
		),
	}),
	{ onExcessProperty: "error" },
)

/** A read the store could not serve is a 500 naming the read. */
const readFailed =
	(label: string) =>
	<R>(self: Effect.Effect<Response, EventingControlStoreError, R>): Effect.Effect<Response, never, R> =>
		self.pipe(
			Effect.catchTag("@maple/cli/eventing/ControlStoreFailed", (error) =>
				Effect.succeed(text(`${label} failed: ${error.message}`, 500)),
			),
			Effect.catchDefect((defect) =>
				Effect.succeed(text(`${label} failed: ${describeThrown(defect)}`, 500)),
			),
		)

const handleEventingRead = (
	token: string,
	req: Request,
	url: URL,
): Effect.Effect<Response, never, LocalEventingRuntime> => {
	const unauthorized = eventingAuthorized(token, req)
	if (unauthorized) return Effect.succeed(unauthorized)
	return Effect.gen(function* () {
		const eventing = yield* LocalEventingRuntime
		if (url.pathname === "/local/eventing/health")
			return yield* eventing.health.pipe(Effect.map(json), readFailed("eventing health read"))
		if (url.pathname === "/local/eventing/projections")
			return yield* eventing.listActive.pipe(Effect.map(json), readFailed("projection read"))
		if (url.pathname === "/local/eventing/consumers")
			return yield* eventing.listConsumers.pipe(Effect.map(json), readFailed("consumer read"))
		if (url.pathname === "/local/eventing/outbox") {
			const query = decodeOutboxQuery(Object.fromEntries(url.searchParams))
			if (Result.isFailure(query)) return text(`invalid outbox query: ${query.failure.message}`, 400)
			const { state = "ready", limit = 100, after = 0 } = query.success
			return yield* (
				state === "ready" ? eventing.listReady(limit, after) : eventing.listStaged(limit, after)
			).pipe(Effect.map(json), readFailed("outbox read"))
		}
		return text("not found", 404)
	})
}

/** The `Bun.serve` fetch handler, closed over the chDB connection. Each ingest
 *  and query request is run through `runSpan` so it leaves a trace; `/health`
 *  and `OPTIONS` are skipped (loop-prevention convention — no health-check noise). */
const makeFetch =
	(
		db: Chdb,
		options: ServerOptions,
		runSpan: SpanRunner,
		authority: RetiredDayAuthority,
		gate: RequestQuiescenceGate,
		maintenanceToken: string,
		consumerToken: string,
	) =>
	async (req: Request): Promise<Response> => {
		const url = new URL(req.url)
		const origin = req.headers.get("origin")
		if (!isBrowserOriginAllowed(url, origin, options.corsOrigin, options.browserHosts)) {
			return text("browser origin not allowed", 403)
		}
		const corsHeaders = corsHeadersForAllowedOrigin(origin)
		const respond = (response: Response): Response => withCors(response, corsHeaders)
		if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })
		if (url.pathname === "/health") return respond(text("OK"))
		if (req.method === "POST") {
			if (url.pathname === "/v1/traces")
				return respond(await runSpan(admitted(gate, ingestSpan(db, authority, "traces", req))))
			if (url.pathname === "/v1/logs")
				return respond(await runSpan(admitted(gate, ingestSpan(db, authority, "logs", req))))
			if (url.pathname === "/v1/metrics")
				return respond(await runSpan(admitted(gate, ingestSpan(db, authority, "metrics", req))))
			if (url.pathname === "/local/query")
				return respond(await runSpan(admitted(gate, querySpan(db, authority, req))))
			if (url.pathname === "/local/eventing/outbox/abandon")
				return respond(
					await runSpan(handleOutboxAdministration(gate, maintenanceToken, req, "abandon")),
				)
			if (url.pathname === "/local/eventing/consumers/accept-gap")
				return respond(
					await runSpan(handleOutboxAdministration(gate, maintenanceToken, req, "accept-gap")),
				)
			if (url.pathname === "/local/checkpoint/backup")
				return respond(
					await runSpan(handleCheckpointBackup(db, options.dataDir, gate, maintenanceToken, req)),
				)
			if (url.pathname === "/local/eventing/projections")
				return respond(await runSpan(handleProjectionActivation(gate, maintenanceToken, req)))
			if (url.pathname === "/local/eventing/consumers")
				return respond(await runSpan(handleConsumerRegistration(gate, maintenanceToken, req)))
			if (url.pathname === "/local/eventing/consumers/disable")
				return respond(await runSpan(handleConsumerDisable(gate, maintenanceToken, req)))
			if (url.pathname === "/local/eventing/claims")
				return respond(await runSpan(handleConsumerClaim(gate, consumerToken, req)))
			if (url.pathname === "/local/eventing/acks")
				return respond(await runSpan(handleConsumerAcknowledgement(gate, consumerToken, req)))
			if (url.pathname === "/local/retention/retire")
				return respond(await handleRetirement(db, authority, gate, maintenanceToken, req))
		}
		if (req.method === "GET" && url.pathname.startsWith("/local/eventing/"))
			return respond(await runSpan(handleEventingRead(maintenanceToken, req, url)))
		if (req.method === "GET" && options.assets) return respond(serveAsset(options.assets, url.pathname))
		return respond(text("not found", 404))
	}

/** Start the server as a scoped resource. Opens chDB (bootstrapping the schema)
 *  before binding, so a failure surfaces before we accept traffic, and ties both
 *  the chDB connection and the listening socket to the current `Scope`. When the
 *  scope closes the socket stops first, then chDB closes (reverse acquisition
 *  order). Resolves with the bound port once listening. */
export const startServer = (
	options: ServerOptions,
): Effect.Effect<
	{ readonly port: number },
	ChdbError | EventingStartupError | ServerBindError,
	Scope.Scope
> =>
	Effect.gen(function* () {
		const retention = yield* Effect.try({
			try: () => {
				const existing = readRawTelemetryRetentionDays(options.dataDir)
				const requested = options.minimumRawTelemetryRetentionDays
				if (requested !== undefined) rawTelemetryTtlStatements(requested)
				if (existing !== undefined && requested !== undefined && requested < existing)
					throw new Error(
						`refusing to shorten persistent raw telemetry retention from ${existing} to ${requested} days`,
					)
				return { existing, requested, effective: requested ?? existing }
			},
			catch: (error) =>
				new ChdbError({
					message: `failed to load persistent raw telemetry retention: ${error instanceof Error ? error.message : String(error)}`,
				}),
		})
		const db = yield* acquireChdb({
			dataDir: options.dataDir,
			schemaSql: LOCAL_SCHEMA_SQL,
			configFile: options.configFile,
			rawTelemetryRetentionDays: retention.effective,
		})
		// Request spans, eventing metrics, and the eventing services share one runtime;
		// disposing it closes the control store (WAL checkpoint) and flushes telemetry.
		const eventingLayer = Layer.mergeAll(
			LocalEventingRuntime.layer,
			LocalEventingControlStore.layer,
		).pipe(Layer.provide(Layer.succeed(LocalEventingControlConfig, { dataDir: options.dataDir })))
		const runtime = yield* Effect.acquireRelease(
			Effect.sync(() => ManagedRuntime.make(Layer.mergeAll(TelemetryLayer, eventingLayer))),
			(rt) => Effect.promise(() => rt.dispose()),
		)
		yield* runtime.contextEffect.pipe(
			Effect.mapError(
				(error) =>
					new EventingStartupError({
						cause: error,
						message:
							error._tag === "@maple/cli/eventing/ControlStoreFailed"
								? `failed to open local eventing control store: ${error.message}`
								: `failed to compile local event projections: ${error.message}`,
					}),
			),
		)
		// `CREATE ... IF NOT EXISTS` does not repair a table whose physical
		// definition was altered out of band. Inspect the opened store before the
		// listener is bound; a mismatch fails startup rather than allowing new
		// query code to run against a partially old layout.
		yield* Effect.try({
			try: () => assertCurrentPhysicalSchema(db, retention.effective),
			catch: (error) =>
				new ChdbError({
					message: `local physical-schema verification failed: ${error instanceof Error ? error.message : String(error)}`,
				}),
		})
		yield* Effect.tryPromise({
			try: () =>
				ensureStoreMarkerDurable(
					options.dataDir,
					{
						version: CURRENT_LOCAL_SCHEMA.version,
						digest: CURRENT_LOCAL_SCHEMA.digest,
						fingerprint: SCHEMA_FINGERPRINT,
					},
					MAPLE_VERSION,
				),
			catch: (error) =>
				new ChdbError({
					message: `could not durably record local-store identity: ${error instanceof Error ? error.message : String(error)}`,
				}),
		})
		// The ALTER statements have now been accepted by the running database.
		// Only after that validation succeeds does a requested value become the
		// durable configuration used by subsequent launches.
		if (retention.requested !== undefined)
			yield* Effect.tryPromise({
				try: () => configureRawTelemetryRetentionDays(options.dataDir, retention.requested!),
				catch: (error) =>
					new ChdbError({
						message: `failed to persist raw telemetry retention: ${error instanceof Error ? error.message : String(error)}`,
					}),
			})
		const authority = yield* Effect.try({
			try: () => {
				const loaded = new RetiredDayAuthority(options.dataDir)
				// Checkpoint restore may have resurrected retired rows. Replay before
				// the listener is bound, so no restored representation is observable.
				loaded.replay(db)
				return loaded
			},
			catch: (error) =>
				new ChdbError({
					message: `failed to enforce retired-day authority: ${error instanceof Error ? error.message : String(error)}`,
				}),
		})
		const maintenanceToken = yield* Effect.tryPromise({
			try: () => ensureMaintenanceToken(options.dataDir),
			catch: (error) =>
				new ChdbError({
					message: `failed to load maintenance token: ${error instanceof Error ? error.message : String(error)}`,
				}),
		})
		const consumerToken = yield* ensureEventConsumerToken(options.dataDir).pipe(
			Effect.mapError(
				(error) =>
					new EventingStartupError({
						cause: error,
						message: `failed to load event consumer token: ${error.message}`,
					}),
			),
		)
		const gate = new RequestQuiescenceGate()
		const runSpan: SpanRunner = (effect) => runtime.runPromise(effect)
		const server = yield* Effect.acquireRelease(
			Effect.try({
				try: () =>
					Bun.serve({
						port: options.port,
						hostname: options.hostname,
						fetch: makeFetch(
							db,
							options,
							runSpan,
							authority,
							gate,
							maintenanceToken,
							consumerToken,
						),
					}),
				catch: (error) =>
					new ServerBindError({
						hostname: options.hostname,
						port: options.port,
						message: `failed to bind ${options.hostname}:${options.port}: ${error instanceof Error ? error.message : String(error)}`,
					}),
			}),
			(s) => Effect.promise(() => s.stop(true)),
		)
		return { port: server.port ?? options.port }
	})

export const __testables = {
	handleConsumerAcknowledgement,
	handleConsumerClaim,
	handleOutboxAdministration,
	handleConsumerDisable,
	handleConsumerRegistration,
	handleCheckpointBackup,
	handleEventingRead,
	handleProjectionActivation,
	ingest,
	readBoundedJson,
	recordServerResponse,
	RequestQuiescenceGate,
}
