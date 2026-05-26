import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { WorkerConfig } from "@maple/effect-cf"
import { Context, FileSystem, Layer, Path } from "effect"
import { HttpMiddleware, HttpRouter } from "effect/unstable/http"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { AllRoutes, ApiAuthLive, ApiObservabilityLive, MainLive } from "./app"
import { DatabaseD1Live } from "./lib/DatabaseD1Live"
import { WorkerEnvironmentLive } from "./lib/WorkerEnvironment"

const WorkerFileSystemLive = FileSystem.layerNoop({})

const WorkerHttpPlatformLive = Layer.effect(
	HttpPlatform.HttpPlatform,
	HttpPlatform.make({
		fileResponse: (_path, status, statusText, headers) =>
			HttpServerResponse.text("File responses are unavailable in the worker runtime", {
				status,
				statusText,
				headers,
			}),
		fileWebResponse: (_file, status, statusText, headers) =>
			HttpServerResponse.text("File responses are unavailable in the worker runtime", {
				status,
				statusText,
				headers,
			}),
	}),
).pipe(Layer.provideMerge(WorkerFileSystemLive), Layer.provideMerge(Etag.layer))

const WorkerPlatformLive = Layer.mergeAll(
	Path.layer,
	Etag.layer,
	WorkerFileSystemLive,
	WorkerHttpPlatformLive,
)

// Telemetry is built once at module scope; `telemetry.layer` lives in the same
// runtime as the routes (so spans share the Tracer), and `flush(env)` drains the
// in-isolate OTLP buffers — scheduled via `ctx.waitUntil` after each response.
const telemetry = MapleCloudflareSDK.make({
	serviceName: "maple-api",
	dropSpanNames: ["McpServer/Notifications."],
})

// Load-bearing despite looking pointless: with NO `middleware`, POST /mcp hangs
// (Cloudflare kills it as "worker hung" — verified). Any middleware flips
// `toHandled` onto its `matchCauseEffect(tracer(middleware(responded)))` path,
// which unsticks the RpcServer/HttpRouter scope bug. `disableLogger: true` keeps
// Effect's default request logger off (app logs flow through the OTLP logger).
const passThrough: HttpMiddleware.HttpMiddleware = (httpApp) => httpApp

// `WorkerEnvironmentLive` (outermost) satisfies the `WorkerEnvironment`
// requirement of `DatabaseD1Live` (D1 binding) and `WorkerConfig.providerLayer`
// (env-backed Effect ConfigProvider). `toWebHandler` provides the HttpRouter and
// runs the full HTTP chain (tracer + CORS pre-response handlers + error→response).
const { handler } = HttpRouter.toWebHandler(
	AllRoutes.pipe(
		Layer.provideMerge(MainLive),
		Layer.provideMerge(ApiAuthLive),
		Layer.provideMerge(ApiObservabilityLive),
		Layer.provideMerge(WorkerPlatformLive),
		Layer.provideMerge(DatabaseD1Live),
		Layer.provideMerge(telemetry.layer),
		Layer.provideMerge(WorkerConfig.providerLayer),
		Layer.provideMerge(WorkerEnvironmentLive),
	),
	{ middleware: passThrough, disableLogger: true },
)

export default {
	async fetch(
		request: Request,
		env: Record<string, unknown>,
		ctx: ExecutionContext,
	): Promise<Response> {
		// Providing `middleware` widens `toWebHandler`'s handler to require a base
		// context; we have none to add, so pass an empty one.
		const response = await handler(request, Context.empty() as never)
		ctx.waitUntil(telemetry.flush(env))
		return response
	},
}
