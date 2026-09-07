import { assert, describe, it } from "@effect/vitest"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { v2WorkerUnavailableDefinition } from "@maple/domain/http/v2-worker-unavailable"
import { workerTelemetryConfig } from "@maple/infra/worker-telemetry"
import * as Cloudflare from "alchemy/Cloudflare"
import type { HttpEffect } from "alchemy/Http"
import { Context, Effect, Exit, Layer, Option, Schema, Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { type KeyValueStore, MapleDbConnection, McpSessionStore } from "./platform/bindings"
import { cachedRecoverable } from "@maple/infra/cached-recoverable"
import { buildIsolateHandler, makeFetch, WorkerPlatformLive } from "./worker/http"

/**
 * One request the way alchemy's bridge runs it — `makeRequestHandler` is the
 * bridge's own fetch path, the SDK telemetry is built into the event's scope
 * exactly as `WorkerTelemetry` registers it, and the scope closes after the
 * same macrotask yield the bridge makes. Pins the paths that must not depend
 * on the route graph (liveness, preflights, the graph failing to build) and
 * that a routed answer exports as a server span.
 */
const ExportedSpan = Schema.Struct({
	name: Schema.String,
	status: Schema.Struct({ code: Schema.optionalKey(Schema.Finite) }),
	attributes: Schema.Array(
		Schema.Struct({ key: Schema.String, value: Schema.Record(Schema.String, Schema.Unknown) }),
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

const statusCodeOf = (span: ExportedSpan | undefined): number | undefined => {
	const value = span?.attributes.find((attribute) => attribute.key === "http.response.status_code")?.value
	return value === undefined ? undefined : Number(Object.values(value)[0])
}

/** No MCP session lands in these requests and no stage database exists, so neither port is reached. */
const noSessions: KeyValueStore = {
	getJson: () => Effect.succeed(Option.none()),
	put: () => Effect.void,
}
const noPorts = Layer.mergeAll(
	Layer.succeed(McpSessionStore, noSessions),
	Layer.succeed(MapleDbConnection, Option.none()),
)

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
		return { response, body, server: serverSpans(recorded) }
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
