import { assert, describe, it } from "@effect/vitest"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { v2WorkerUnavailableDefinition } from "@maple/domain/http/v2-worker-unavailable"
import { workerTelemetryConfig } from "@maple/infra/worker-telemetry"
import * as Cloudflare from "alchemy/Cloudflare"
import type { HttpEffect } from "alchemy/Http"
import { Context, Effect, Exit, Layer, Option, Schema, Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { MapleDbConnection } from "./platform/bindings"
import { cachedRecoverable } from "@maple/infra/cached-recoverable"
import { recordRenderedFailure } from "./routes/rendered-failure"
import { buildIsolateHandler, makeFetch, WorkerPlatformLive } from "./worker/http"

/**
 * One request the way alchemy's bridge runs it — `makeRequestHandler` is the
 * bridge's own fetch path, the SDK telemetry is built into the event's scope
 * exactly as `WorkerTelemetry` registers it, and the scope closes after the
 * same macrotask yield the bridge makes. Pins the paths that must not depend
 * on the route graph (liveness, preflights, the graph failing to build) and
 * that a routed answer exports as a server span.
 */
const ExportedAttribute = Schema.Struct({
	key: Schema.String,
	value: Schema.Record(Schema.String, Schema.Unknown),
})
const ExportedSpan = Schema.Struct({
	name: Schema.String,
	status: Schema.Struct({ code: Schema.optionalKey(Schema.Finite) }),
	attributes: Schema.Array(ExportedAttribute),
	events: Schema.optionalKey(
		Schema.Array(Schema.Struct({ name: Schema.String, attributes: Schema.Array(ExportedAttribute) })),
	),
})
type ExportedSpan = typeof ExportedSpan.Type
const ExportedTraces = Schema.Struct({
	resourceSpans: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({ scopeSpans: Schema.Array(Schema.Struct({ spans: Schema.Array(ExportedSpan) })) }),
		),
	),
})
const decodeExportedTraces = Schema.decodeUnknownSync(ExportedTraces)

const ExportedLogRecord = Schema.Struct({
	severityText: Schema.optionalKey(Schema.String),
	body: Schema.optionalKey(Schema.Struct({ stringValue: Schema.optionalKey(Schema.String) })),
})
const ExportedLogs = Schema.Struct({
	resourceLogs: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				scopeLogs: Schema.Array(Schema.Struct({ logRecords: Schema.Array(ExportedLogRecord) })),
			}),
		),
	),
})
const decodeExportedLogs = Schema.decodeUnknownSync(ExportedLogs)

interface RecordedRequest {
	readonly url: string
	readonly body: string | null
}

const stubFetch = (recorded: Array<RecordedRequest>): typeof globalThis.fetch =>
	(async (input: string | URL | Request, init?: RequestInit) => {
		recorded.push({
			url: input instanceof Request ? input.url : String(input),
			body: typeof init?.body === "string" ? init.body : null,
		})
		return new Response("{}", { status: 200 })
	}) as typeof globalThis.fetch

const serverSpans = (recorded: ReadonlyArray<RecordedRequest>): Array<ExportedSpan> =>
	recorded
		.filter((request) => request.url.endsWith("/v1/traces"))
		.flatMap((request) => decodeExportedTraces(JSON.parse(request.body ?? "{}")).resourceSpans ?? [])
		.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans))
		.filter((span) => span.name.startsWith("http.server "))

const logBodies = (recorded: ReadonlyArray<RecordedRequest>): Array<string> =>
	recorded
		.filter((request) => request.url.endsWith("/v1/logs"))
		.flatMap((request) => decodeExportedLogs(JSON.parse(request.body ?? "{}")).resourceLogs ?? [])
		.flatMap((resource) => resource.scopeLogs.flatMap((scope) => scope.logRecords))
		.flatMap((record) => (record.body?.stringValue === undefined ? [] : [record.body.stringValue]))

/** One attribute as its rendered value — OTLP JSON carries ints as strings anyway. */
const attributeOf = (span: ExportedSpan | undefined, key: string): string | undefined => {
	const value = span?.attributes.find((attribute) => attribute.key === key)?.value
	const rendered = value === undefined ? undefined : Object.values(value)[0]
	return rendered === undefined ? undefined : String(rendered)
}

const statusCodeOf = (span: ExportedSpan | undefined): number | undefined => {
	const value = attributeOf(span, "http.response.status_code")
	return value === undefined ? undefined : Number(value)
}

/** What error tracking will group this span's failure under. */
const exceptionTypeOf = (span: ExportedSpan | undefined): string | undefined => {
	const event = span?.events?.find((candidate) => candidate.name === "exception")
	const value = event?.attributes.find((attribute) => attribute.key === "exception.type")?.value
	const rendered = value === undefined ? undefined : Object.values(value)[0]
	return rendered === undefined ? undefined : String(rendered)
}

/** No stage database exists in these requests, so the port is never reached. */
const noPorts = Layer.succeed(MapleDbConnection, Option.none())

const env = {
	MAPLE_INGEST_KEY: "maple_sk_test",
	MAPLE_ENDPOINT: "http://ingest.test",
	COMMIT_SHA: "deadbeefcafe",
}

class GraphBuildFailure extends Schema.TaggedError<GraphBuildFailure>()("GraphBuildFailure", {
	message: Schema.String,
}) {}

/** A route graph that answers everything with 404, as the real one does for an unknown path. */
const notFoundApp: Effect.Effect<HttpEffect, never> = Effect.succeed(
	Effect.succeed(HttpServerResponse.text("Not Found", { status: 404 })),
)

/** A graph that renders its own 500, the shape the unattributed prod 500s arrive in. */
const renderedServerErrorApp: Effect.Effect<HttpEffect, never> = Effect.succeed(
	Effect.succeed(HttpServerResponse.text("", { status: 500 })),
)

/** A graph whose handler dies, so the cause is still live when it leaves the router. */
const dyingApp: Effect.Effect<HttpEffect, never> = Effect.succeed(Effect.die(new Error("handler exploded")))

/** One route that answers with the bearer it was called with — the header a leaked request would get wrong. */
const EchoGroup = HttpApiGroup.make("echo").add(
	HttpApiEndpoint.get("echo", "/echo", { success: Schema.String }),
)
class EchoApi extends HttpApi.make("EchoApi").add(EchoGroup) {}
const EchoHandlersLive = HttpApiBuilder.group(EchoApi, "echo", (handlers) =>
	Effect.succeed(
		handlers.handle("echo", () =>
			Effect.map(
				HttpServerRequest.HttpServerRequest,
				(request) => request.headers["authorization"] ?? "",
			),
		),
	),
)

/**
 * One route that logs from inside its handler, the way `V1ErrorBoundaryLive`
 * logs a defect before answering `V1UnexpectedError`.
 *
 * The graph is built under the isolate's context, not the first event's, and
 * the HttpApi group layers wrap every handler in the context they were built
 * in — so a handler's logger is the one the build captured. This pins that it
 * is still the event's, and that what a route logs reaches the exporter: a
 * boundary that logs into a dropped batch is a 500 with no cause anywhere.
 */
const LoggingGroup = HttpApiGroup.make("logging").add(
	HttpApiEndpoint.get("logging", "/logging", { success: Schema.String }),
)
class LoggingApi extends HttpApi.make("LoggingApi").add(LoggingGroup) {}
const LoggingHandlersLive = HttpApiBuilder.group(LoggingApi, "logging", (handlers) =>
	Effect.succeed(
		handlers.handle("logging", () =>
			Effect.logError("boundary answered with a server error").pipe(Effect.as("logged")),
		),
	),
)

/** One route that records a rendered failure the way the boundaries do, to pin which span it lands on. */
const RecordingGroup = HttpApiGroup.make("recording").add(
	HttpApiEndpoint.get("recording", "/recording", { success: Schema.String }),
)
class RecordingApi extends HttpApi.make("RecordingApi").add(RecordingGroup) {}
const RecordingHandlersLive = HttpApiBuilder.group(RecordingApi, "recording", (handlers) =>
	Effect.succeed(
		handlers.handle("recording", () =>
			recordRenderedFailure({
				group: "recording",
				operation: "recording",
				errorType: "WarehouseQueryError",
				summary: "Route answered with a server error",
				message: "memory limit exceeded",
				status: 502,
				cause: new Error("memory limit exceeded"),
			}).pipe(Effect.as("recorded")),
		),
	),
)

const event = (
	method: string,
	path: string,
	app: Effect.Effect<HttpEffect, unknown>,
	headers?: Record<string, string>,
) =>
	Effect.gen(function* () {
		const recorded: Array<RecordedRequest> = []
		const realFetch = globalThis.fetch
		globalThis.fetch = stubFetch(recorded)
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				globalThis.fetch = realFetch
			}),
		)

		const request = yield* Scope.make()
		// One tag under two types: the SDK reads its env where the bridge provides the Worker's.
		const services = yield* Layer.buildWithScope(
			Layer.mergeAll(
				MapleCloudflareSDK.make(workerTelemetryConfig({ serviceName: "maple-api" })).requestLayer,
				Layer.succeed(Cloudflare.WorkerEnvironment, env),
			).pipe(Layer.provide(Layer.succeed(MapleCloudflareSDK.WorkerEnvironment, env))),
			request,
		)
		const fetchEvent = Cloudflare.Workers.makeRequestHandler(makeFetch(app, noPorts))({
			kind: "Cloudflare.Workers.WorkerEvent",
			type: "fetch",
			input: new Request(`http://api.maple.test${path}`, { method, headers }),
		})
		assert.isDefined(fetchEvent)
		const response: Response = yield* fetchEvent.pipe(Effect.provide(services), Scope.provide(request))
		const body = yield* Effect.promise(() => response.text())
		yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
		yield* Scope.close(request, Exit.void)
		return { response, body, server: serverSpans(recorded), logs: logBodies(recorded) }
	}).pipe(Effect.scoped)

describe("the api Worker through alchemy's bridge", () => {
	it.effect("answers liveness without the route graph", () =>
		Effect.gen(function* () {
			const { response, body } = yield* event(
				"GET",
				"/health",
				Effect.die("the graph must not be built"),
			)
			assert.strictEqual(response.status, 200)
			assert.strictEqual(body, "OK")
			assert.strictEqual(response.headers.get("access-control-allow-origin"), "*")
			// What `deploy-prd.yml` asserts against to catch a partial deploy.
			assert.strictEqual(response.headers.get("x-maple-revision"), "deadbeefcafe")
		}),
	)

	it.effect("answers a preflight without the route graph", () =>
		Effect.gen(function* () {
			const { response } = yield* event(
				"OPTIONS",
				"/v2/traces",
				Effect.die("the graph must not be built"),
			)
			assert.strictEqual(response.status, 204)
			assert.include(response.headers.get("access-control-allow-headers") ?? "", "Authorization")
		}),
	)

	it.effect("a route graph that fails to build answers the v2 envelope and a plain 504 elsewhere", () =>
		Effect.gen(function* () {
			const broken = Effect.fail(new GraphBuildFailure({ message: "binding unavailable" }))
			const v2 = yield* event("GET", "/v2/traces", broken)
			assert.strictEqual(v2.response.status, v2WorkerUnavailableDefinition.status)
			assert.strictEqual(
				v2.response.headers.get("retry-after"),
				String(v2WorkerUnavailableDefinition.retryAfterSeconds),
			)
			assert.strictEqual(JSON.parse(v2.body).error.code, v2WorkerUnavailableDefinition.code)
			const v1 = yield* event("GET", "/api/errors", broken)
			assert.strictEqual(v1.response.status, 504)
			assert.strictEqual(v1.body, "The API worker is temporarily unavailable.")
		}),
	)

	it.effect("a graph built on the first request serves the second request with ITS headers", () =>
		Effect.gen(function* () {
			// A lazily built graph, exactly as `buildApp` builds it: the first
			// event's fiber runs the build. Without `buildIsolateHandler`, the HttpApi
			// group layer captured that fiber's context and every later request ran
			// under the first request's `HttpServerRequest`.
			const app = yield* cachedRecoverable(
				buildIsolateHandler(
					Context.empty(),
					HttpApiBuilder.layer(EchoApi).pipe(
						Layer.provide(EchoHandlersLive),
						Layer.provide(WorkerPlatformLive),
					),
				),
			)
			const first = yield* event("GET", "/echo", app, { authorization: "Bearer first" })
			assert.strictEqual(first.response.status, 200)
			assert.strictEqual(first.body, JSON.stringify("Bearer first"))
			const second = yield* event("GET", "/echo", app, { authorization: "Bearer second" })
			assert.strictEqual(second.response.status, 200)
			assert.strictEqual(second.body, JSON.stringify("Bearer second"))
		}),
	)

	it.effect("a log emitted inside a route handler is exported", () =>
		Effect.gen(function* () {
			const app = yield* cachedRecoverable(
				buildIsolateHandler(
					Context.empty(),
					HttpApiBuilder.layer(LoggingApi).pipe(
						Layer.provide(LoggingHandlersLive),
						Layer.provide(WorkerPlatformLive),
					),
				),
			)
			const { response, logs } = yield* event("GET", "/logging", app)
			assert.strictEqual(response.status, 200)
			assert.include(logs, "boundary answered with a server error")
		}),
	)

	it.effect("a 5xx no seam recorded stays anonymous and carries the isolate shape", () =>
		Effect.gen(function* () {
			const { response, server } = yield* event("GET", "/boom", renderedServerErrorApp)
			assert.strictEqual(response.status, 500)
			// The exit is a success, so the tracer flags the span from the status alone.
			assert.strictEqual(server[0]?.status.code, 2 /* Error */)
			// Nothing named it, which is exactly what the generic type means.
			assert.strictEqual(exceptionTypeOf(server[0]), "HttpServerErrorResponse")
			assert.strictEqual(Number(attributeOf(server[0], "maple.isolate.age_ms")), 0)
			assert.strictEqual(Number(attributeOf(server[0], "maple.isolate.request_ordinal")), 1)
		}),
	)

	it.effect("a cause escaping the route graph reaches error tracking under its own name", () =>
		Effect.gen(function* () {
			const { response, server, logs } = yield* event("GET", "/boom", dyingApp)
			assert.strictEqual(response.status, 500)
			assert.include(logs, "Cause escaped the route graph")
			assert.strictEqual(attributeOf(server[0], "error.type"), "Error")
			// The real exception survives instead of being relabelled by the tracer.
			assert.strictEqual(exceptionTypeOf(server[0]), "Error")
		}),
	)

	it.effect("a failure recorded inside an HttpApi handler lands on the server span", () =>
		Effect.gen(function* () {
			const app = yield* cachedRecoverable(
				buildIsolateHandler(
					Context.empty(),
					HttpApiBuilder.layer(RecordingApi).pipe(
						Layer.provide(RecordingHandlersLive),
						Layer.provide(WorkerPlatformLive),
					),
				),
			)
			const { server } = yield* event("GET", "/recording", app)
			assert.strictEqual(exceptionTypeOf(server[0]), "WarehouseQueryError")
		}),
	)

	it.effect("a routed answer is recorded as a server span with its status", () =>
		Effect.gen(function* () {
			const { response, server } = yield* event("GET", "/nope", notFoundApp)
			assert.strictEqual(response.status, 404)
			assert.strictEqual(server.length, 1)
			assert.notStrictEqual(server[0]?.status.code, 2 /* Error */)
			assert.strictEqual(statusCodeOf(server[0]), 404)
		}),
	)
})
