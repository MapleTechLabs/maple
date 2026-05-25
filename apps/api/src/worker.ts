import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { Worker, WorkerEnvironment } from "@maple/effect-cf"
import { Cause, Effect, FileSystem, Layer, Option, Path } from "effect"
import { Headers, HttpMiddleware, HttpRouter } from "effect/unstable/http"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { AllRoutes, ApiAuthLive, ApiObservabilityLive, MainLive } from "./app"
import { DatabaseD1Live } from "./lib/DatabaseD1Live"
import { persistSession, preloadSession, type SessionsBinding } from "./mcp/lib/session-store"

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

// Telemetry is constructed once at module scope — `layer` is stable, `flush(env)`
// resolves env lazily. `telemetry.layer` lives in the same runtime as the routes
// (it's part of `AppLayer`) so the Tracer reference is shared with the spans the
// HTTP tracer middleware emits.
const telemetry = MapleCloudflareSDK.make({
	serviceName: "maple-api",
	dropSpanNames: ["McpServer/Notifications."],
})

// The full application layer. `Worker.make` supplies `WorkerEnvironment`, the
// `ConfigProvider` (from the worker `env`), `ExecutionContext`, and
// `WorkerContext` automatically — so `DatabaseD1Live` (which needs
// `WorkerEnvironment`) and any `Config` reads resolve without manual wiring.
// `HttpRouter.layer` provides the router service that `AllRoutes` registers into
// (previously supplied internally by `HttpRouter.toWebHandler`).
const composedLayer = AllRoutes.pipe(
	Layer.provideMerge(MainLive),
	Layer.provideMerge(ApiAuthLive),
	Layer.provideMerge(ApiObservabilityLive),
	Layer.provideMerge(WorkerPlatformLive),
	Layer.provideMerge(DatabaseD1Live),
	Layer.provideMerge(telemetry.layer),
	Layer.provideMerge(HttpRouter.layer),
)

// `HttpApiBuilder` encodes each API error as a phantom `Request<"Error", E>`
// layer requirement — a contract that "whoever runs this converts those errors
// to HTTP responses." `render` does exactly that (`asHttpEffect` + `catchCause`),
// and `Worker.make` supplies the worker services, so we discharge the phantom
// requirements down to `WorkerEnvironment`. This mirrors effect-cf's own HTTP
// worker example, which casts the `HttpApiBuilder` layer the same way.
const AppLayer: Layer.Layer<
	Layer.Success<typeof composedLayer>,
	Layer.Error<typeof composedLayer>,
	WorkerEnvironment
> = composedLayer as never

const isMcpPost = (request: Request): boolean => {
	if (request.method !== "POST") return false
	try {
		return new URL(request.url).pathname === "/mcp"
	} catch {
		return false
	}
}

const readMcpSessionsBinding = (env: Record<string, unknown>): SessionsBinding | undefined => {
	const candidate = env.MCP_SESSIONS
	if (candidate && typeof candidate === "object" && "get" in candidate && "put" in candidate) {
		return candidate as SessionsBinding
	}
	return undefined
}

type McpFrame = { method: string; id: string }

// Peek the JSON-RPC body without consuming the request stream (we read a clone,
// leaving the original body for the router). Tolerates batch payloads and
// malformed JSON — diagnostics only, never throws.
const peekMcpFrame = (body: string): McpFrame => {
	try {
		const parsed = JSON.parse(body)
		const first = Array.isArray(parsed) ? parsed[0] : parsed
		const method = typeof first?.method === "string" ? first.method : "-"
		const id = first?.id === undefined || first?.id === null ? "-" : String(first.id)
		return { method, id }
	} catch {
		return { method: "-", id: "-" }
	}
}

// Yield one macrotask so Effect's scheduler can drain `scheduleTask(fn, 0)` tasks
// — notably `HttpMiddleware.tracer`'s `span.end` — before we flush the OTLP
// buffer, so the root server span lands instead of appearing parentless.
const drainMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const sessionIdOf = (response: HttpServerResponse.HttpServerResponse): string | null =>
	Option.getOrNull(Headers.get(response.headers, "mcp-session-id"))

// Per-request HTTP handler. Runs inside the `Worker.make` runtime, so `env` is a
// real `WorkerEnvironment` service (not AsyncLocalStorage) — which is why MCP KV
// session persistence + body-peek diagnostics + telemetry flush can all live
// here rather than in an outer wrapper.
const render = Effect.gen(function* () {
	const request = yield* Worker.NativeRequest
	const env = (yield* WorkerEnvironment) as Record<string, unknown>
	const workerCtx = yield* Worker.WorkerContext

	const kv = readMcpSessionsBinding(env)
	const isMcp = isMcpPost(request)
	const reqSid = isMcp ? request.headers.get("mcp-session-id") : null
	const startedAt = Date.now()

	let mcpFrame: McpFrame | null = null
	if (isMcp) {
		const bodyText = yield* Effect.promise(() => request.clone().text())
		const frame = peekMcpFrame(bodyText)
		mcpFrame = frame
		yield* Effect.sync(() =>
			console.log(
				`[mcp-in] method=${frame.method} id=${frame.id}` +
					` sid=${reqSid ?? "-"} body_len=${bodyText.length}`,
			),
		)
	}

	if (kv && reqSid) {
		yield* Effect.promise(() => preloadSession(kv, reqSid))
	}

	const router = yield* HttpRouter.HttpRouter
	const response = yield* HttpMiddleware.tracer(router.asHttpEffect()).pipe(
		Effect.catchCause((cause) =>
			Effect.sync(() => {
				console.error("[worker] handler failed:", Cause.pretty(cause))
				return HttpServerResponse.text(`worker handler error: ${Cause.pretty(cause)}`, {
					status: 504,
				})
			}),
		),
	)

	// Persist only when the server issued a new session — i.e. on `initialize`,
	// where the response sid differs from the request sid. Subsequent requests
	// echo the same sid; re-putting every call would burn KV write quota.
	if (kv && isMcp) {
		const resSid = sessionIdOf(response)
		if (resSid && resSid !== reqSid) {
			const put = persistSession(kv, resSid)
			if (put) yield* workerCtx.waitUntil(Effect.promise(() => put))
		}
	}

	if (isMcp && mcpFrame) {
		const frame = mcpFrame
		yield* Effect.sync(() =>
			console.log(
				`[mcp-out] method=${frame.method} id=${frame.id}` +
					` status=${response.status} dur=${Date.now() - startedAt}ms` +
					` resp_sid=${sessionIdOf(response) ?? "-"}`,
			),
		)
	}

	yield* workerCtx.waitUntil(
		Effect.promise(() => drainMacrotask().then(() => telemetry.flush(env))),
	)

	return response
})

export default Worker.make(AppLayer, { fetch: render })
