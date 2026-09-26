// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
// The local Maple server: OTLP/HTTP ingest + a raw SQL query API + the bundled
// SPA, all on one port, backed by an embedded chDB. Replaces the Rust
// `apps/ingest/src/bin/local.rs`. `maple start` calls `startServer`.

import { CloudEventInvalid } from "@maple/eventing-core"
import { Effect, Result, Schema, type Scope } from "effect"
import * as ManagedRuntime from "effect/ManagedRuntime"
import { resolve } from "node:path"
import { gunzipSync } from "node:zlib"
import { TelemetryLayer } from "../core/telemetry"
import { connectionHostForBindHost, isLoopbackHostname, serverUrl } from "../lib/local-address"
import { MAPLE_VERSION } from "../version"
import {
	acquireChdb,
	type Chdb,
	ChdbClosedError,
	ChdbError,
	configureRawTelemetryRetentionDays,
	MAX_QUERY_SIZE_BYTES,
	readRawTelemetryRetentionDays,
	rawTelemetryTtlStatements,
} from "./chdb"
import { buildInsertStatements } from "./inserts"
import {
	eventingControlSnapshotPath,
	EventConsumerConflictError,
	EventConsumerLeaseError,
	EventConsumerDeliveryGapError,
	OutboxAdministrationInvalid,
	EventConsumerInputError,
	EventConsumerNotFoundError,
	LocalEventingControlStore,
	OutboxEventRejected,
} from "./eventing/control-store"
import { ensureEventConsumerToken, eventConsumerTokenMatches } from "./eventing/consumer-auth"
import {
	LocalEventingRuntime,
	ProjectionActivationConflict,
	ProjectionActivationInvalid,
	SourceOccurrenceCollision,
} from "./eventing/runtime"
import { makeEffectEventingTelemetry } from "./eventing/telemetry"
import { encodeLogs, encodeMetrics, encodeTraces, type EncodedBatch, OtlpFieldError } from "./otlp/encode"
import {
	decodeLogsRequest,
	decodeMetricsRequest,
	decodeTraceRequest,
	encodeExportResponse,
} from "./otlp/proto"
import { CURRENT_LOCAL_SCHEMA, LOCAL_SCHEMA_SQL, SCHEMA_FINGERPRINT } from "./schema-identity"
import { assertCurrentPhysicalSchema } from "./schema-physical"
import {
	countArrayRows,
	prepareLocalQuery,
	READ_ONLY_REJECTION_PREFIX,
	ReadOnlyQueryRejected,
} from "./query-guard"
import { localServiceMapRollupLoop } from "./service-map-rollup"
import { ensureStoreMarkerDurable, storeHasData } from "./store-version"
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
	/** Exact separately hosted UI origin allowed to reach the local listener;
	 * empty or omitted when no hosted UI may connect (`--offline`). */
	readonly corsOrigin?: string | undefined
	/** Host clients should use, reported by `/local/status`; defaults to the
	 * connect address of `hostname`. */
	readonly advertiseHost?: string | undefined
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

/** A server option that cannot be honoured, e.g. a malformed allowed origin. */
export class LocalServerConfigError extends Schema.TaggedError<LocalServerConfigError>()(
	"@maple/cli/LocalServerConfigError",
	{ message: Schema.String, source: Schema.String },
) {}

/** Vite dev server origins for apps/local-ui (`vite --port 4319`), which proxies here. */
export const LOCAL_UI_DEV_ORIGINS = [
	"http://127.0.0.1:4319",
	"http://localhost:4319",
	"http://[::1]:4319",
] as const

export const ALLOWED_ORIGINS_ENV = "MAPLE_LOCAL_ALLOWED_ORIGINS"

export interface BrowserOriginPolicy {
	readonly browserHosts: readonly string[]
	/** Exact origins, besides same-origin, allowed on every route. */
	readonly trustedOrigins: ReadonlySet<string>
	/** Origins only honoured when the request itself targets loopback. */
	readonly loopbackDevOrigins: ReadonlySet<string>
}

const parseOrigin = (value: string): string | undefined => {
	const parsed = Result.try(() => new URL(value))
	if (Result.isFailure(parsed)) return undefined
	const url = parsed.success
	return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined
}

export const makeBrowserOriginPolicy = (options: {
	readonly browserHosts: readonly string[]
	readonly hostedOrigin?: string | undefined
	readonly extraOrigins?: string | undefined
}): Result.Result<BrowserOriginPolicy, LocalServerConfigError> => {
	const trusted = new Set<string>()
	const hosted = options.hostedOrigin?.trim()
	if (hosted) {
		const origin = parseOrigin(hosted)
		if (origin === undefined)
			return Result.fail(
				new LocalServerConfigError({
					source: "hosted UI origin",
					message: `invalid origin ${hosted}`,
				}),
			)
		trusted.add(origin)
	}
	for (const entry of (options.extraOrigins ?? "").split(",")) {
		const value = entry.trim()
		if (value === "") continue
		const origin = parseOrigin(value)
		if (origin === undefined)
			return Result.fail(
				new LocalServerConfigError({
					source: ALLOWED_ORIGINS_ENV,
					message: `invalid origin ${JSON.stringify(value)} in ${ALLOWED_ORIGINS_ENV}; expected e.g. http://localhost:5173`,
				}),
			)
		trusted.add(origin)
	}
	return Result.succeed({
		browserHosts: options.browserHosts,
		trustedOrigins: trusted,
		loopbackDevOrigins: new Set(LOCAL_UI_DEV_ORIGINS),
	})
}

/**
 * Browser access policy. OTLP ingest (`/v1/*`) keeps accepting any loopback
 * page, so browser SDKs in local dev apps can export here. Everything else,
 * including the SQL endpoint, is limited to same-origin, the hosted UI, the
 * local-ui Vite origin, and explicitly allowed origins.
 */
export const isBrowserOriginAllowed = (
	requestUrl: URL,
	origin: string | null,
	policy: BrowserOriginPolicy,
): boolean => {
	if (origin === null) return true // SDKs, collectors, and other non-browser clients
	const parsed = Result.try(() => new URL(origin))
	if (Result.isFailure(parsed)) return false
	const originUrl = parsed.success
	if (policy.trustedOrigins.has(originUrl.origin)) return true
	const loopbackRequest = isLoopbackHostname(requestUrl.hostname)
	if (loopbackRequest && policy.loopbackDevOrigins.has(originUrl.origin)) return true
	if (requestUrl.pathname.startsWith("/v1/") && loopbackRequest && isLoopbackHostname(originUrl.hostname))
		return true
	// Bun constructs requestUrl from the client's Host header. Keep that behavior:
	// this comparison is the load-bearing DNS-rebinding check for non-loopback UI traffic.
	// Compare host (including port), not scheme: a TLS reverse proxy may preserve
	// Host while forwarding to this HTTP listener. A rebinding page cannot present
	// a loopback name, so loopback aliases of this listener count as same-origin.
	return (
		originUrl.host === requestUrl.host &&
		(policy.browserHosts.includes(originUrl.hostname) || isLoopbackHostname(originUrl.hostname))
	)
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

/** A message for a thrown value of unknown shape that is never `{}` or
 * `[object Object]`; an unhelpful value was fingerprinted as `Error: {}` in
 * production, so the last resort names the shape instead. */
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

/** Decompressed OTLP bodies above this are refused, so a gzip bomb cannot exhaust memory. */
export const MAX_DECOMPRESSED_OTLP_BYTES = 256 * 1024 * 1024

class OtlpBodyTooLarge extends Schema.TaggedError<OtlpBodyTooLarge>()("@maple/cli/OtlpBodyTooLarge", {
	message: Schema.String,
	maximumBytes: Schema.Number,
}) {}

class OtlpDecodeFailed extends Schema.TaggedError<OtlpDecodeFailed>()("@maple/cli/OtlpDecodeFailed", {
	message: Schema.String,
}) {}

const isBufferTooLarge = Schema.is(Schema.Struct({ code: Schema.Literal("ERR_BUFFER_TOO_LARGE") }))

/** Decode an OTLP request body (protobuf by default, JSON when content-type
 *  says so), transparently gunzipping a gzip content-encoding. */
function decodeOtlp(
	signal: Signal,
	raw: Uint8Array,
	contentType: string,
	contentEncoding: string | null,
	maximumBytes = MAX_DECOMPRESSED_OTLP_BYTES,
): Result.Result<unknown, OtlpBodyTooLarge | OtlpDecodeFailed> {
	let bytes = raw
	if (contentEncoding && contentEncoding.includes("gzip")) {
		const inflated = Result.try({
			try: () => gunzipSync(raw, { maxOutputLength: maximumBytes }),
			catch: (error) =>
				isBufferTooLarge(error)
					? new OtlpBodyTooLarge({
							message: `decompressed body exceeds ${maximumBytes} bytes`,
							maximumBytes,
						})
					: new OtlpDecodeFailed({ message: describeThrown(error) }),
		})
		if (Result.isFailure(inflated)) return inflated
		bytes = inflated.success
	}
	const decodedBytes = bytes
	return Result.try({
		try: (): unknown => {
			if (contentType.includes("json"))
				return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
					new TextDecoder().decode(decodedBytes),
				)
			switch (signal) {
				case "traces":
					return decodeTraceRequest(decodedBytes)
				case "logs":
					return decodeLogsRequest(decodedBytes)
				case "metrics":
					return decodeMetricsRequest(decodedBytes)
			}
		},
		catch: (error) => new OtlpDecodeFailed({ message: describeThrown(error) }),
	})
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

/** Receives outbox event IDs whose readiness could not be recorded after
 *  their rows were already committed to the warehouse. */
export interface ReadinessRetry {
	readonly retry: (eventIds: readonly string[]) => void
}

const NO_READINESS_RETRY: ReadinessRetry = { retry: () => undefined }

/**
 * A malformed field, an in-batch identity collision, or an event the outbox
 * rejects fails identically on every retry, so it is a 400; OTLP exporters
 * retry 503 and would resend the batch until it is dropped.
 */
const projectionFailureStatus = (error: unknown): 400 | 503 =>
	error instanceof OtlpFieldError ||
	error instanceof SourceOccurrenceCollision ||
	error instanceof OutboxEventRejected ||
	error instanceof CloudEventInvalid
		? 400
		: 503

async function ingest(
	db: Pick<Chdb, "exec">,
	authority: RetiredDayAuthority,
	eventing: LocalEventingRuntime,
	signal: Signal,
	req: Request,
	readiness: ReadinessRetry = NO_READINESS_RETRY,
): Promise<IngestResult> {
	let raw: Uint8Array
	try {
		raw = new Uint8Array(await req.arrayBuffer())
	} catch (error) {
		// A client that hangs up mid-body rejects here. Unguarded, this became an
		// Effect *defect* — no `error.type`, no 4xx suppression, and a span reading
		// only "The connection was closed." It is a caller outcome, so 400 it.
		return {
			response: text(`read ${signal} body: ${describeThrown(error)}`, 400),
			accepted: 0,
			requestBytes: 0,
		}
	}
	const requestBytes = raw.length
	const contentType = req.headers.get("content-type") ?? ""
	const contentEncoding = req.headers.get("content-encoding")
	const decodeResult = decodeOtlp(signal, raw, contentType, contentEncoding)
	if (Result.isFailure(decodeResult))
		return {
			response: text(
				`decode ${signal}: ${decodeResult.failure.message}`,
				decodeResult.failure instanceof OtlpBodyTooLarge ? 413 : 400,
			),
			accepted: 0,
			requestBytes,
		}
	const decoded = decodeResult.success
	let evaluation: ReturnType<LocalEventingRuntime["evaluateOtlp"]>
	try {
		evaluation = eventing.evaluateOtlp(signal, decoded, (rangeDate) => authority.isRetired(rangeDate))
	} catch (error) {
		return {
			response: text(
				`event projection ${signal}: ${describeThrown(error)}`,
				projectionFailureStatus(error),
			),
			accepted: 0,
			requestBytes,
		}
	}
	let batches: EncodedBatch[]
	try {
		batches = encodeFor(signal, decoded)
	} catch (error) {
		// A malformed field is the sender's fault, not ours — reject the batch
		// with a 400 naming the field instead of silently storing a bad value.
		const status = error instanceof OtlpFieldError ? 400 : 500
		const stage = status === 400 ? "decode" : "encode"
		return {
			response: text(`${stage} ${signal}: ${describeThrown(error)}`, status),
			accepted: 0,
			requestBytes,
		}
	}
	let stagedEventIds: readonly string[] = []
	let droppedEvents = 0
	try {
		eventing.persistFailures(evaluation.failures)
		if (evaluation.events.length > 0) {
			const staged = eventing.stage(evaluation.events, evaluation.eventSourceFingerprints)
			stagedEventIds = staged.eventIds
			droppedEvents = staged.dropped
		}
	} catch (error) {
		return {
			response: text(
				`event projection ${signal}: ${describeThrown(error)}`,
				projectionFailureStatus(error),
			),
			accepted: 0,
			requestBytes,
		}
	}
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
			try {
				db.exec(statement.sql)
			} catch (error) {
				return {
					response: text(`chDB insert (${batch.datasource}): ${describeThrown(error)}`, 500),
					accepted,
					requestBytes,
				}
			}
			accepted += statement.rowCount
		}
	}
	const readyEventIds = [...evaluation.recoveredEventIds, ...stagedEventIds]
	// The rows are committed: a 5xx here would make exporters resend the batch
	// and double-count it, so readiness is retried in the background instead.
	if (readyEventIds.length > 0 && Result.isFailure(Result.try(() => eventing.markReady(readyEventIds))))
		readiness.retry(readyEventIds)
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
		return {
			response,
			accepted,
			requestBytes,
		}
	}
	const response = new Response(encodeExportResponse(signal, rejected, errorMessage), {
		status: 200,
		headers: { "content-type": "application/x-protobuf" },
	})
	if (droppedEvents > 0) response.headers.set("x-maple-eventing-dropped", String(droppedEvents))
	return { response, accepted, requestBytes }
}

interface QueryResult {
	readonly response: Response
	readonly rowCount: number
	readonly durationMs: number
	readonly sqlLength: number | undefined
}

// A client-closed request status (nginx convention); the body is never read.
const CLIENT_CLOSED = 499

async function handleQuery(
	db: Chdb,
	authority: RetiredDayAuthority,
	maintenanceToken: string,
	req: Request,
): Promise<QueryResult> {
	const started = performance.now()
	const finish = (response: Response, sqlLength: number | undefined, rowCount = 0): QueryResult => ({
		response,
		rowCount,
		durationMs: Math.round(performance.now() - started),
		sqlLength,
	})
	const body = await readBoundedJson(req, MAX_QUERY_SIZE_BYTES)
	if (Result.isFailure(body)) return finish(bodyFailureResponse(body.failure), undefined)
	const decoded = Schema.decodeUnknownResult(Schema.Struct({ sql: Schema.String }))(body.success)
	if (Result.isFailure(decoded)) return finish(text("missing 'sql' string", 400), undefined)
	const sql = decoded.success.sql
	if (req.signal.aborted) return finish(text("client closed request", CLIENT_CLOSED), sql.length)
	// Trusted local tooling (checkpoint probes, maintenance) authenticates with
	// the maintenance token; browsers cannot read it and never send the header.
	const allowWrites = maintenanceTokenMatches(
		maintenanceToken,
		req.headers.get("x-maple-maintenance-token"),
	)
	const prepared = prepareLocalQuery(db, sql, { allowWrites })
	if (Result.isFailure(prepared)) {
		const failure = prepared.failure
		return finish(
			failure instanceof ReadOnlyQueryRejected
				? text(`${READ_ONLY_REJECTION_PREFIX}${failure.message}`, 400)
				: text(`query failed: ${failure.message}`, 400),
			sql.length,
		)
	}
	const { kind, sql: statement } = prepared.success
	if (kind === "write" && authority.hasRetiredDays())
		return finish(
			text("local SQL writes are disabled after the first UTC day is retired", 405),
			sql.length,
		)
	// The engine call below blocks the thread; skip it for a caller that already left.
	if (req.signal.aborted) return finish(text("client closed request", CLIENT_CLOSED), sql.length)
	const output = Result.try({ try: () => db.queryBytes(statement, "JSONEachRow"), catch: (error) => error })
	if (Result.isFailure(output))
		// 400, not 500: a failing statement is a problem with the submitted SQL,
		// and a 5xx would make the shared warehouse executor retry it.
		return finish(
			output.failure instanceof ChdbClosedError
				? text("server is shutting down", 503)
				: text(`query failed: ${describeThrown(output.failure)}`, 400),
			sql.length,
		)
	const bytes = output.success
	// Read statements already emit a JSON array (`output_format_json_array_of_rows`).
	if (kind === "write" || bytes.length === 0) return finish(text("[]", 200, "application/json"), sql.length)
	return finish(
		new Response(bytes, { status: 200, headers: { "content-type": "application/json" } }),
		sql.length,
		countArrayRows(bytes),
	)
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

/** Runs a request's span effect on the server's tracing runtime (see
 *  `startServer`). The effect always succeeds with a `Response`. */
type SpanRunner = <A>(effect: Effect.Effect<A>) => Promise<A>

// A 5xx response surfaced through the Effect error channel so the Server span
// fails; `response` is handed back untouched in `recoverResponse`. The message
// is the status only: bodies can quote rows or SQL and must not reach telemetry.
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
			yield* Effect.annotateCurrentSpan({ "error.type": `HTTP ${response.status}` })
			if (response.status >= 500)
				return yield* new IngestRejected({
					response,
					status: response.status,
					message: `HTTP ${response.status}`,
				})
		}
		return response
	})

const recoverResponse = (self: Effect.Effect<Response, IngestRejected>): Effect.Effect<Response> =>
	Effect.match(self, { onFailure: (error) => error.response, onSuccess: (response) => response })

/** Mutable listener state reported by `/local/status`. */
interface ServerStatus {
	url: string
	readonly dataDir: string
	lastIngestAtMs: number | null
}

/** OTLP-ingest request as a `Server`-kind span, mirroring the Rust gateway
 *  (`apps/ingest`): `maple.signal`, item count, request size, HTTP semconv. */
const ingestSpan = (
	runSpan: SpanRunner,
	db: Chdb,
	authority: RetiredDayAuthority,
	eventing: LocalEventingRuntime,
	readiness: ReadinessRetry,
	status: ServerStatus,
	signal: Signal,
	req: Request,
): Promise<Response> =>
	runSpan(
		recoverResponse(
			Effect.gen(function* () {
				// `ingest` maps its own failures to responses; an unexpected rejection
				// becomes a 500 here rather than an unlabelled defect.
				const { response, accepted, requestBytes } = yield* Effect.promise(() =>
					ingest(db, authority, eventing, signal, req, readiness).then(
						(result) => result,
						(error: unknown): IngestResult => ({
							response: text(`ingest ${signal}: ${describeThrown(error)}`, 500),
							accepted: 0,
							requestBytes: 0,
						}),
					),
				)
				if (accepted > 0 && response.status < 300) status.lastIngestAtMs = Date.now()
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
		),
	)

/** `/local/query` request as a `Server`-kind span. The SQL text is not
 *  recorded: it carries user filter values and leaves the machine. */
const querySpan = (
	runSpan: SpanRunner,
	db: Chdb,
	authority: RetiredDayAuthority,
	maintenanceToken: string,
	req: Request,
): Promise<Response> =>
	runSpan(
		recoverResponse(
			Effect.gen(function* () {
				const { response, rowCount, durationMs, sqlLength } = yield* Effect.promise(() =>
					handleQuery(db, authority, maintenanceToken, req),
				)
				yield* Effect.annotateCurrentSpan({
					"db.system.name": "clickhouse",
					"db.duration_ms": durationMs,
					"result.rowCount": rowCount,
					"http.response.status_code": response.status,
					...(sqlLength !== undefined ? { "db.query.length": sqlLength } : undefined),
				})
				return yield* recordServerResponse(response)
			}).pipe(
				Effect.withSpan("POST /local/query", {
					kind: "server",
					attributes: { "http.request.method": "POST", "http.route": "/local/query" },
				}),
			),
		),
	)

/** Admission closes before retirement and reopens only after all previously
 * accepted ingest/query work has drained and the durable transition finishes.
 * `shutdown` closes it for good and resolves once admitted and exclusive work
 * has finished, so the engine is never closed under a running request. */
export class RequestQuiescenceGate {
	#active = 0
	#maintenance = false
	#shuttingDown = false
	#exclusiveSettled: Promise<void> = Promise.resolve()
	#drained: Array<() => void> = []

	enter(): (() => void) | null {
		if (this.#maintenance || this.#shuttingDown) return null
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

	exclusive<A>(work: () => Promise<A>): Promise<A> {
		if (this.#maintenance || this.#shuttingDown)
			return Promise.reject(MaintenanceInProgressError.create())
		this.#maintenance = true
		const run = this.#drain()
			.then(work)
			.finally(() => {
				this.#maintenance = false
			})
		this.#exclusiveSettled = run.then(
			() => undefined,
			() => undefined,
		)
		return run
	}

	shutdown(): Promise<void> {
		this.#shuttingDown = true
		return Promise.all([this.#drain(), this.#exclusiveSettled]).then(() => undefined)
	}

	#drain(): Promise<void> {
		if (this.#active === 0) return Promise.resolve()
		return new Promise<void>((resolve) => this.#drained.push(resolve))
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

class InvalidJsonBody extends Schema.TaggedError<InvalidJsonBody>()("@maple/cli/InvalidJsonBody", {
	message: Schema.String,
}) {}

type BodyFailure = RequestBodyTooLargeError | InvalidJsonBody

const readBoundedBytes = async (
	req: Request,
	maximumBytes: number,
): Promise<Result.Result<Uint8Array, BodyFailure>> => {
	const contentLength = req.headers.get("content-length")
	if (contentLength !== null && /^[0-9]+$/.test(contentLength)) {
		const declared = Number(contentLength)
		if (!Number.isSafeInteger(declared) || declared > maximumBytes)
			return Result.fail(RequestBodyTooLargeError.create(maximumBytes))
	}
	if (req.body === null) return Result.succeed(new Uint8Array(0))
	const reader = req.body.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	for (;;) {
		const next = await reader.read().then(
			(chunk) => Result.succeed(chunk),
			(error: unknown) =>
				Result.fail(new InvalidJsonBody({ message: `read request body: ${describeThrown(error)}` })),
		)
		if (Result.isFailure(next)) {
			reader.releaseLock()
			return Result.fail(next.failure)
		}
		if (next.success.done) break
		total += next.success.value.byteLength
		if (total > maximumBytes) {
			await reader.cancel().catch(() => undefined)
			reader.releaseLock()
			return Result.fail(RequestBodyTooLargeError.create(maximumBytes))
		}
		chunks.push(next.success.value)
	}
	reader.releaseLock()
	return Result.succeed(Buffer.concat(chunks, total))
}

const decodeJsonText = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))

const readBoundedJson = async (
	req: Request,
	maximumBytes: number,
): Promise<Result.Result<unknown, BodyFailure>> => {
	const bytes = await readBoundedBytes(req, maximumBytes)
	if (Result.isFailure(bytes)) return bytes
	return Result.mapError(
		decodeJsonText(new TextDecoder().decode(bytes.success)),
		() => new InvalidJsonBody({ message: "invalid JSON body" }),
	)
}

const bodyFailureResponse = (failure: BodyFailure): Response =>
	failure instanceof RequestBodyTooLargeError ? text(failure.message, 413) : text("invalid JSON body", 400)

const recoverMaintenanceError = (error: unknown, fallback: Response): Response => {
	if (error instanceof MaintenanceInProgressError) return text(error.message, 409)
	if (error instanceof RequestBodyTooLargeError) return text(error.message, 413)
	return fallback
}

const admitted = async (gate: RequestQuiescenceGate, work: () => Promise<Response>): Promise<Response> => {
	const leave = gate.enter()
	if (!leave) return text("server maintenance in progress", 503)
	try {
		return await work()
	} finally {
		leave()
	}
}

/** Background retries for outbox readiness after the rows are committed. */
class ReadinessRecovery implements ReadinessRetry {
	static readonly DELAYS_MS = [100, 500, 2_000, 5_000, 15_000]
	readonly #timers = new Set<ReturnType<typeof setTimeout>>()
	#stopped = false

	readonly #markReady: (eventIds: readonly string[]) => void
	readonly #gate: RequestQuiescenceGate
	readonly #onGiveUp: (eventCount: number) => void

	constructor(
		markReady: (eventIds: readonly string[]) => void,
		gate: RequestQuiescenceGate,
		onGiveUp: (eventCount: number) => void,
	) {
		this.#markReady = markReady
		this.#gate = gate
		this.#onGiveUp = onGiveUp
	}

	retry(eventIds: readonly string[], attempt = 0): void {
		if (this.#stopped) return
		const delay = ReadinessRecovery.DELAYS_MS[attempt]
		if (delay === undefined) return this.#onGiveUp(eventIds.length)
		const timer = setTimeout(() => {
			this.#timers.delete(timer)
			const leave = this.#gate.enter()
			// Maintenance holds admission; wait for it without spending an attempt.
			if (leave === null) return this.retry(eventIds, attempt)
			const marked = Result.try(() => this.#markReady(eventIds))
			leave()
			if (Result.isFailure(marked)) this.retry(eventIds, attempt + 1)
		}, delay)
		this.#timers.add(timer)
	}

	stop(): void {
		this.#stopped = true
		for (const timer of this.#timers) clearTimeout(timer)
		this.#timers.clear()
	}
}

const handleRetirement = async (
	db: Chdb,
	authority: RetiredDayAuthority,
	gate: RequestQuiescenceGate,
	token: string,
	req: Request,
): Promise<Response> => {
	if (!maintenanceTokenMatches(token, req.headers.get("x-maple-maintenance-token")))
		return text("maintenance authorization required", 403)
	const read = await readBoundedJson(req, MAX_RETIREMENT_BODY_BYTES)
	if (Result.isFailure(read)) return bodyFailureResponse(read.failure)
	const body = read.success
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
const MAX_RETIREMENT_BODY_BYTES = 16 * 1024

/** Typed, authenticated replacement for sending BACKUP through /local/query. */
const handleCheckpointBackup = async (
	db: Chdb,
	controlStore: LocalEventingControlStore,
	dataDir: string,
	gate: RequestQuiescenceGate,
	token: string,
	req: Request,
): Promise<Response> => {
	if (!maintenanceTokenMatches(token, req.headers.get("x-maple-maintenance-token")))
		return text("maintenance authorization required", 403)
	const read = await readBoundedJson(req, MAX_CHECKPOINT_BODY_BYTES)
	if (Result.isFailure(read)) return bodyFailureResponse(read.failure)
	const body = read.success
	const decoded = Schema.decodeUnknownResult(
		Schema.Struct({
			checkpointId: Schema.String.check(Schema.isPattern(CHECKPOINT_ID)),
		}),
		{ onExcessProperty: "error" },
	)(body)
	if (Result.isFailure(decoded)) return text("invalid checkpoint fields", 400)
	const record = decoded.success
	try {
		const checkpointId = record.checkpointId.toLowerCase()
		const controlBytes = await gate.exclusive(async () => {
			// Both captures are synchronous: no request can mutate either database between them.
			const bytes = controlStore.captureSnapshot()
			db.exec(`BACKUP DATABASE default TO Disk('default', 'backups/snapshots/${checkpointId}/backup')`)
			return bytes
		})
		const control = await LocalEventingControlStore.writeSnapshot(
			eventingControlSnapshotPath(dataDir, checkpointId),
			controlBytes,
		)
		return json({ checkpointId, control })
	} catch (error) {
		return recoverMaintenanceError(error, text(`checkpoint backup failed: ${describeThrown(error)}`, 400))
	}
}

const eventingAuthorized = (token: string, req: Request): Response | null =>
	maintenanceTokenMatches(token, req.headers.get("x-maple-maintenance-token"))
		? null
		: text("maintenance authorization required", 403)

const handleProjectionActivation = async (
	eventing: LocalEventingRuntime,
	gate: RequestQuiescenceGate,
	token: string,
	req: Request,
): Promise<Response> => {
	const unauthorized = eventingAuthorized(token, req)
	if (unauthorized) return unauthorized
	const read = await readBoundedJson(req, MAX_PROJECTION_BODY_BYTES)
	if (Result.isFailure(read)) return bodyFailureResponse(read.failure)
	const body = read.success
	let activation
	try {
		// Recursive schema validation and full registry compilation happen while
		// normal ingest/query admission remains open.
		activation = eventing.prepareActivation(body)
	} catch (error) {
		return text(`invalid event projection: ${describeThrown(error)}`, 400)
	}
	try {
		await gate.exclusive(async () => eventing.commitActivation(activation))
		return json({ active: eventing.listActive() })
	} catch (error) {
		if (error instanceof ProjectionActivationConflict) return text(error.message, 409)
		if (error instanceof ProjectionActivationInvalid) return text(error.message, 400)
		return recoverMaintenanceError(
			error,
			text(`event projection activation failed: ${describeThrown(error)}`, 500),
		)
	}
}

const eventConsumerErrorResponse = (error: unknown): Response => {
	if (error instanceof EventConsumerDeliveryGapError)
		return json(
			{
				error: error._tag,
				message: error.message,
				consumerId: error.consumerId,
				generation: error.generation,
				droppedEvents: error.droppedEvents,
			},
			409,
		)
	if (error instanceof OutboxAdministrationInvalid || error instanceof EventConsumerInputError)
		return text(error.message, 400)
	if (error instanceof EventConsumerNotFoundError) return text(error.message, 404)
	if (error instanceof EventConsumerConflictError || error instanceof EventConsumerLeaseError)
		return text(error.message, 409)
	return text(`event consumer operation failed: ${describeThrown(error)}`, 500)
}

const ConsumerIdSchema = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9._-]{0,63}$/))

const handleConsumerRegistration = async (
	eventing: LocalEventingRuntime,
	gate: RequestQuiescenceGate,
	maintenanceToken: string,
	req: Request,
): Promise<Response> => {
	const unauthorized = eventingAuthorized(maintenanceToken, req)
	if (unauthorized) return unauthorized
	const read = await readBoundedJson(req, MAX_CONSUMER_BODY_BYTES)
	if (Result.isFailure(read)) return bodyFailureResponse(read.failure)
	const body = read.success
	const decoded = Schema.decodeUnknownResult(
		Schema.Struct({ consumerId: ConsumerIdSchema, startAt: Schema.Literals(["beginning", "latest"]) }),
		{ onExcessProperty: "error" },
	)(body)
	if (Result.isFailure(decoded)) return text("invalid event consumer registration fields", 400)
	const { consumerId, startAt } = decoded.success
	return admitted(gate, async () => {
		try {
			return json(eventing.registerConsumer(consumerId, startAt), 201)
		} catch (error) {
			return eventConsumerErrorResponse(error)
		}
	})
}

const handleConsumerDisable = async (
	eventing: LocalEventingRuntime,
	gate: RequestQuiescenceGate,
	maintenanceToken: string,
	req: Request,
): Promise<Response> => {
	const unauthorized = eventingAuthorized(maintenanceToken, req)
	if (unauthorized) return unauthorized
	const read = await readBoundedJson(req, MAX_CONSUMER_BODY_BYTES)
	if (Result.isFailure(read)) return bodyFailureResponse(read.failure)
	const body = read.success
	const decoded = Schema.decodeUnknownResult(Schema.Struct({ consumerId: ConsumerIdSchema }), {
		onExcessProperty: "error",
	})(body)
	if (Result.isFailure(decoded)) return text("invalid event consumer disable fields", 400)
	const { consumerId } = decoded.success
	return admitted(gate, async () => {
		try {
			return json(eventing.disableConsumer(consumerId))
		} catch (error) {
			return eventConsumerErrorResponse(error)
		}
	})
}

const handleConsumerClaim = async (
	eventing: Pick<LocalEventingRuntime, "claimReady">,
	gate: RequestQuiescenceGate,
	consumerToken: string,
	req: Request,
): Promise<Response> => {
	if (!eventConsumerTokenMatches(consumerToken, req.headers.get("x-maple-event-consumer-token")))
		return text("event consumer authorization required", 403)
	const read = await readBoundedJson(req, MAX_CONSUMER_BODY_BYTES)
	if (Result.isFailure(read)) return bodyFailureResponse(read.failure)
	const body = read.success
	const decoded = Schema.decodeUnknownResult(
		Schema.Struct({
			consumerId: ConsumerIdSchema,
			limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
			leaseSeconds: Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 300 })),
		}),
		{ onExcessProperty: "error" },
	)(body)
	if (Result.isFailure(decoded)) return text("invalid event consumer claim fields", 400)
	const { consumerId, limit, leaseSeconds } = decoded.success
	return admitted(gate, async () => {
		try {
			return json(eventing.claimReady(consumerId, limit, leaseSeconds))
		} catch (error) {
			return eventConsumerErrorResponse(error)
		}
	})
}

const handleConsumerAcknowledgement = async (
	eventing: LocalEventingRuntime,
	gate: RequestQuiescenceGate,
	consumerToken: string,
	req: Request,
): Promise<Response> => {
	if (!eventConsumerTokenMatches(consumerToken, req.headers.get("x-maple-event-consumer-token")))
		return text("event consumer authorization required", 403)
	const read = await readBoundedJson(req, MAX_CONSUMER_BODY_BYTES)
	if (Result.isFailure(read)) return bodyFailureResponse(read.failure)
	const body = read.success
	const decoded = Schema.decodeUnknownResult(
		Schema.Struct({
			consumerId: ConsumerIdSchema,
			leaseToken: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
			throughSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
		}),
		{ onExcessProperty: "error" },
	)(body)
	if (Result.isFailure(decoded)) return text("invalid event consumer acknowledgement fields", 400)
	const { consumerId, leaseToken, throughSequence } = decoded.success
	return admitted(gate, async () => {
		try {
			return json(eventing.acknowledgeClaim(consumerId, leaseToken, throughSequence))
		} catch (error) {
			return eventConsumerErrorResponse(error)
		}
	})
}

const handleOutboxAdministration = async (
	eventing: Pick<LocalEventingRuntime, "abandonEvents" | "acceptDeliveryGap">,
	gate: RequestQuiescenceGate,
	token: string,
	req: Request,
	action: "abandon" | "accept-gap",
): Promise<Response> => {
	const unauthorized = eventingAuthorized(token, req)
	if (unauthorized) return unauthorized
	const read = await readBoundedJson(req, MAX_PROJECTION_BODY_BYTES)
	if (Result.isFailure(read)) return bodyFailureResponse(read.failure)
	const body = read.success
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
		try {
			return json(await gate.exclusive(async () => eventing.abandonEvents(decoded.success.eventIds)))
		} catch (error) {
			return recoverMaintenanceError(error, eventConsumerErrorResponse(error))
		}
	}
	const decoded = Schema.decodeUnknownResult(
		Schema.Struct({
			consumerId: ConsumerIdSchema,
			generation: Schema.Int.check(Schema.isGreaterThan(0)),
		}),
		{ onExcessProperty: "error" },
	)(body)
	if (Result.isFailure(decoded)) return text("invalid delivery gap acknowledgement fields", 400)
	return admitted(gate, async () => {
		try {
			return json(eventing.acceptDeliveryGap(decoded.success.consumerId, decoded.success.generation))
		} catch (error) {
			return eventConsumerErrorResponse(error)
		}
	})
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

const handleEventingRead = (
	eventing: LocalEventingRuntime,
	token: string,
	req: Request,
	url: URL,
): Response => {
	const unauthorized = eventingAuthorized(token, req)
	if (unauthorized) return unauthorized
	if (url.pathname === "/local/eventing/health") return json(eventing.health())
	if (url.pathname === "/local/eventing/projections") return json(eventing.listActive())
	if (url.pathname === "/local/eventing/consumers") return json(eventing.listConsumers())
	if (url.pathname === "/local/eventing/outbox") {
		const query = decodeOutboxQuery(Object.fromEntries(url.searchParams))
		if (Result.isFailure(query)) return text(`invalid outbox query: ${query.failure.message}`, 400)
		const { state = "ready", limit = 100, after = 0 } = query.success
		try {
			return json(
				state === "ready" ? eventing.listReady(limit, after) : eventing.listStaged(limit, after),
			)
		} catch (error) {
			return text(`outbox read failed: ${describeThrown(error)}`, 500)
		}
	}
	return text("not found", 404)
}

interface ServerContext {
	readonly db: Chdb
	readonly options: ServerOptions
	readonly policy: BrowserOriginPolicy
	readonly runSpan: SpanRunner
	readonly authority: RetiredDayAuthority
	readonly gate: RequestQuiescenceGate
	readonly maintenanceToken: string
	readonly consumerToken: string
	readonly controlStore: LocalEventingControlStore
	readonly eventing: LocalEventingRuntime
	readonly readiness: ReadinessRetry
	readonly status: ServerStatus
}

/** `GET /local/status`: identity and liveness for the CLI probe and the UI. */
const statusResponse = (status: ServerStatus): Response =>
	json({
		service: "maple-local",
		pid: process.pid,
		version: MAPLE_VERSION,
		url: status.url,
		dataDir: status.dataDir,
		lastIngestAtMs: status.lastIngestAtMs,
	})

/** The `Bun.serve` fetch handler, closed over the chDB connection. Each ingest
 *  and query request is run through `runSpan` so it leaves a trace; `/health`,
 *  `/local/status` and `OPTIONS` are skipped (no health-check noise). */
const makeFetch =
	(context: ServerContext) =>
	async (req: Request): Promise<Response> => {
		const { db, options, runSpan, authority, gate, maintenanceToken, consumerToken, eventing } = context
		const url = new URL(req.url)
		const origin = req.headers.get("origin")
		if (!isBrowserOriginAllowed(url, origin, context.policy)) {
			return text("browser origin not allowed", 403)
		}
		const corsHeaders = corsHeadersForAllowedOrigin(origin)
		const respond = (response: Response): Response => withCors(response, corsHeaders)
		if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })
		if (url.pathname === "/health") return respond(text("OK"))
		if (req.method === "GET" && url.pathname === "/local/status")
			return respond(statusResponse(context.status))
		if (req.method === "POST") {
			const signal: Signal | undefined =
				url.pathname === "/v1/traces"
					? "traces"
					: url.pathname === "/v1/logs"
						? "logs"
						: url.pathname === "/v1/metrics"
							? "metrics"
							: undefined
			if (signal !== undefined)
				return respond(
					await admitted(gate, () =>
						ingestSpan(
							runSpan,
							db,
							authority,
							eventing,
							context.readiness,
							context.status,
							signal,
							req,
						),
					),
				)
			if (url.pathname === "/local/query")
				return respond(
					await admitted(gate, () => querySpan(runSpan, db, authority, maintenanceToken, req)),
				)
			if (url.pathname === "/local/eventing/outbox/abandon")
				return respond(
					await handleOutboxAdministration(eventing, gate, maintenanceToken, req, "abandon"),
				)
			if (url.pathname === "/local/eventing/consumers/accept-gap")
				return respond(
					await handleOutboxAdministration(eventing, gate, maintenanceToken, req, "accept-gap"),
				)
			if (url.pathname === "/local/checkpoint/backup")
				return respond(
					await handleCheckpointBackup(
						db,
						context.controlStore,
						options.dataDir,
						gate,
						maintenanceToken,
						req,
					),
				)
			if (url.pathname === "/local/eventing/projections")
				return respond(await handleProjectionActivation(eventing, gate, maintenanceToken, req))
			if (url.pathname === "/local/eventing/consumers")
				return respond(await handleConsumerRegistration(eventing, gate, maintenanceToken, req))
			if (url.pathname === "/local/eventing/consumers/disable")
				return respond(await handleConsumerDisable(eventing, gate, maintenanceToken, req))
			if (url.pathname === "/local/eventing/claims")
				return respond(await handleConsumerClaim(eventing, gate, consumerToken, req))
			if (url.pathname === "/local/eventing/acks")
				return respond(await handleConsumerAcknowledgement(eventing, gate, consumerToken, req))
			if (url.pathname === "/local/retention/retire")
				return respond(await handleRetirement(db, authority, gate, maintenanceToken, req))
		}
		if (req.method === "GET" && url.pathname.startsWith("/local/eventing/"))
			return respond(handleEventingRead(eventing, maintenanceToken, req, url))
		if (req.method === "GET" && options.assets) return respond(serveAsset(options.assets, url.pathname))
		return respond(text("not found", 404))
	}

/** How long shutdown waits for admitted requests and maintenance before the
 *  engine closes anyway; `maple stop` gives the process 15s. */
const SHUTDOWN_DRAIN_MS = 10_000

/** Resolve when `work` settles or after `ms`, whichever is first. */
const settleWithin = (work: Promise<unknown>, ms: number): Promise<void> => {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, ms)
	})
	return Promise.race([work.then(() => undefined), timeout]).finally(() => clearTimeout(timer))
}

/** Start the server as a scoped resource. Opens chDB (bootstrapping the schema)
 *  before binding, so a failure surfaces before we accept traffic, and ties both
 *  the chDB connection and the listening socket to the current `Scope`. When the
 *  scope closes, admission closes and in-flight work drains before the socket
 *  and then chDB close (reverse acquisition order). Resolves with the bound
 *  port once listening. */
export const startServer = (
	options: ServerOptions,
): Effect.Effect<
	{ readonly port: number },
	ChdbError | EventingStartupError | ServerBindError | LocalServerConfigError,
	Scope.Scope
> =>
	Effect.gen(function* () {
		const policy = yield* Effect.fromResult(
			makeBrowserOriginPolicy({
				browserHosts: options.browserHosts,
				hostedOrigin: options.corsOrigin,
				extraOrigins: process.env[ALLOWED_ORIGINS_ENV],
			}),
		)
		const existingRetention = yield* Effect.try({
			try: () => readRawTelemetryRetentionDays(options.dataDir),
			catch: (error) =>
				new ChdbError({
					message: `failed to load persistent raw telemetry retention: ${describeThrown(error)}`,
				}),
		})
		const requestedRetention = options.minimumRawTelemetryRetentionDays
		if (requestedRetention !== undefined)
			yield* Effect.try({
				try: () => rawTelemetryTtlStatements(requestedRetention),
				catch: (error) =>
					new ChdbError({
						message: `failed to load persistent raw telemetry retention: ${describeThrown(error)}`,
					}),
			})
		if (
			existingRetention !== undefined &&
			requestedRetention !== undefined &&
			requestedRetention < existingRetention
		)
			return yield* new ChdbError({
				message: `failed to load persistent raw telemetry retention: refusing to shorten persistent raw telemetry retention from ${existingRetention} to ${requestedRetention} days`,
			})
		const retention = {
			requested: requestedRetention,
			effective: requestedRetention ?? existingRetention,
		}
		const schemaIdentity = {
			version: CURRENT_LOCAL_SCHEMA.version,
			digest: CURRENT_LOCAL_SCHEMA.digest,
			fingerprint: SCHEMA_FINGERPRINT,
		}
		const recordStoreIdentity = Effect.tryPromise({
			try: () => ensureStoreMarkerDurable(options.dataDir, schemaIdentity, MAPLE_VERSION),
			catch: (error) =>
				new ChdbError({
					message: `could not durably record local-store identity: ${describeThrown(error)}`,
				}),
		})
		// A fresh store is about to be bootstrapped with the current schema, so its
		// identity is known now. Recording it before the engine creates any files
		// means a startup failure below leaves a store the next start recognises,
		// instead of one that looks like an unversioned legacy store.
		if (!storeHasData(options.dataDir)) yield* recordStoreIdentity
		const db = yield* acquireChdb({
			dataDir: options.dataDir,
			schemaSql: LOCAL_SCHEMA_SQL,
			configFile: options.configFile,
			rawTelemetryRetentionDays: retention.effective,
		})
		// The request handler and synchronous eventing store share one telemetry
		// runtime; eventing observations contain only bounded operation labels.
		const telemetry = yield* Effect.acquireRelease(
			Effect.sync(() => ManagedRuntime.make(TelemetryLayer)),
			(rt) => Effect.promise(() => rt.dispose()),
		)
		const eventingTelemetry = makeEffectEventingTelemetry((effect) => {
			telemetry.runFork(effect)
		})
		const controlStore = yield* Effect.acquireRelease(
			Effect.tryPromise({
				try: () => LocalEventingControlStore.open(options.dataDir, undefined, eventingTelemetry),
				catch: (error) =>
					new EventingStartupError({
						cause: error,
						message: `failed to open local eventing control store: ${describeThrown(error)}`,
					}),
			}),
			(store) =>
				Effect.try({
					try: () => store.close(),
					catch: (cause) =>
						new EventingStartupError({
							message: "failed to close eventing control store",
							cause,
						}),
				}).pipe(
					Effect.catchTag("@maple/cli/eventing/StartupFailed", (error) => Effect.logError(error)),
				),
		)
		const eventing = yield* Effect.try({
			try: () => new LocalEventingRuntime(controlStore, eventingTelemetry),
			catch: (error) =>
				new EventingStartupError({
					cause: error,
					message: `failed to compile local event projections: ${describeThrown(error)}`,
				}),
		})
		// `CREATE ... IF NOT EXISTS` does not repair a table whose physical
		// definition was altered out of band. Inspect the opened store before the
		// listener is bound; a mismatch fails startup rather than allowing new
		// query code to run against a partially old layout.
		yield* Effect.try({
			try: () => assertCurrentPhysicalSchema(db, retention.effective),
			catch: (error) =>
				new ChdbError({
					message: `local physical-schema verification failed: ${describeThrown(error)}`,
				}),
		})
		yield* recordStoreIdentity
		// The ALTER statements have now been accepted by the running database.
		// Only after that validation succeeds does a requested value become the
		// durable configuration used by subsequent launches.
		if (retention.requested !== undefined) {
			const requested = retention.requested
			yield* Effect.tryPromise({
				try: () => configureRawTelemetryRetentionDays(options.dataDir, requested),
				catch: (error) =>
					new ChdbError({
						message: `failed to persist raw telemetry retention: ${describeThrown(error)}`,
					}),
			})
		}
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
					message: `failed to enforce retired-day authority: ${describeThrown(error)}`,
				}),
		})
		const maintenanceToken = yield* Effect.tryPromise({
			try: () => ensureMaintenanceToken(options.dataDir),
			catch: (error) =>
				new ChdbError({
					message: `failed to load maintenance token: ${describeThrown(error)}`,
				}),
		})
		const consumerToken = yield* Effect.tryPromise({
			try: () => ensureEventConsumerToken(options.dataDir),
			catch: (error) =>
				new EventingStartupError({
					cause: error,
					message: `failed to load event consumer token: ${describeThrown(error)}`,
				}),
		})
		const gate = new RequestQuiescenceGate()
		const readiness = new ReadinessRecovery(
			(eventIds) => eventing.markReady(eventIds),
			gate,
			(eventCount) =>
				telemetry.runFork(
					Effect.logWarning(
						`event outbox readiness could not be recorded for ${eventCount} events; they stay staged until a retry of the batch or \`abandon\``,
					),
				),
		)
		const status: ServerStatus = { url: "", dataDir: resolve(options.dataDir), lastIngestAtMs: null }
		const server = yield* Effect.acquireRelease(
			Effect.try({
				try: () =>
					Bun.serve({
						port: options.port,
						hostname: options.hostname,
						fetch: makeFetch({
							db,
							options,
							policy,
							runSpan: (effect) => telemetry.runPromise(effect),
							authority,
							gate,
							maintenanceToken,
							consumerToken,
							controlStore,
							eventing,
							readiness,
							status,
						}),
					}),
				catch: (error) =>
					new ServerBindError({
						hostname: options.hostname,
						port: options.port,
						message: `failed to bind ${options.hostname}:${options.port}: ${describeThrown(error)}`,
					}),
			}),
			(s) =>
				Effect.promise(async () => {
					// Stop admitting work, let admitted requests and maintenance finish,
					// then cut whatever is left. chDB closes after this finalizer.
					readiness.stop()
					const drained = gate.shutdown()
					const stopped = s.stop(false)
					await settleWithin(Promise.all([drained, stopped]), SHUTDOWN_DRAIN_MS)
					await s.stop(true)
				}),
		)
		// Forked after the listener, so scope close interrupts it first; each hour
		// runs inside the admission gate, so shutdown and maintenance drain it.
		yield* Effect.forkScoped(
			localServiceMapRollupLoop({
				db,
				gate,
				isRetiredDay: (rangeDate) => authority.isRetired(rangeDate),
			}),
		)
		const port = server.port ?? options.port
		status.url = serverUrl(options.advertiseHost ?? connectionHostForBindHost(options.hostname), port)
		return { port }
	})

export const __testables = {
	decodeOtlp,
	handleQuery,
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
