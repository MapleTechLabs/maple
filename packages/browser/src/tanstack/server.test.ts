import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import {
	type AnyRouter,
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	notFound,
	redirect,
} from "@tanstack/react-router"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetReportedErrorsForTests } from "../failures"
import { parseTraceparent } from "../traceparent"
import { tracedLoader, traceRouter } from "./index"
import { traceRender, traceRequests } from "./server"

const exporter = new InMemorySpanExporter()

/** What the app's `instrumentation.ts` (the Node SDK) registers. */
function registerServerOtel(): void {
	context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
	trace.setGlobalTracerProvider(
		new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
	)
	// W3C trace context, as the Node SDK's default propagator reads it
	propagation.setGlobalPropagator({
		inject: () => {},
		extract: (ctx, carrier, getter) => {
			const header = getter.get(carrier, "traceparent")
			const spanContext = parseTraceparent(typeof header === "string" ? header : undefined)
			return spanContext ? trace.setSpanContext(ctx, spanContext) : ctx
		},
		fields: () => ["traceparent"],
	})
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1))
const spans = () => exporter.getFinishedSpans()
const named = (name: string): ReadableSpan => {
	const span = spans().find((candidate) => candidate.name === name)
	if (!span)
		throw new Error(
			`no span named ${name}: ${spans()
				.map((s) => s.name)
				.join(", ")}`,
		)
	return span
}
const parentOf = (span: ReadableSpan) => span.parentSpanContext?.spanId
const idOf = (span: ReadableSpan) => span.spanContext().spanId
const exceptionEvents = () =>
	spans().flatMap((span) => span.events.filter((event) => event.name === "exception"))

const loaderError = new Error("loader exploded")
const rootRoute = createRootRoute()
const routeTree = rootRoute.addChildren([
	createRoute({
		getParentRoute: () => rootRoute,
		path: "/projects/$id",
		loader: ({ params }) =>
			tracedLoader("loader /projects/$id", async () => {
				if (params.id === "missing") throw notFound()
				await tick()
				// A fetch after an `await` keeps its parent on the server
				trace.getTracer("undici").startSpan("GET").end()
				return params.id
			}),
	}),
	createRoute({
		getParentRoute: () => rootRoute,
		path: "/old",
		beforeLoad: () =>
			tracedLoader("beforeLoad /old", async () => {
				throw redirect({ to: "/projects/$id", params: { id: "1" } })
			}),
	}),
	createRoute({
		getParentRoute: () => rootRoute,
		path: "/broken-loader",
		loader: () =>
			tracedLoader("loader /broken-loader", async () => {
				throw loaderError
			}),
	}),
])

/** The render step of TanStack Start's handler: the router has loaded by the time the callback runs. */
const render = traceRender(
	({ responseHeaders }: { router: AnyRouter; responseHeaders: Headers }) =>
		new Response("<html></html>", { headers: responseHeaders }),
)

/** What `createStartHandler(traceRender(defaultStreamHandler))` does for a page request. */
const startHandler = async (request: Request, opts?: { readonly status?: number }): Promise<Response> => {
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [new URL(request.url).pathname] }),
	})
	// Start calls `getRouter()` per request: the tracing call is part of it
	traceRouter(router)
	await router.load()
	const response = render({ router, responseHeaders: new Headers() })
	return opts?.status ? new Response(response.body, { status: opts.status }) : response
}

const fetchPage = traceRequests(startHandler)
const get = (path: string, headers?: HeadersInit) =>
	fetchPage(new Request(`https://app.test${path}`, { headers }))

beforeEach(() => {
	exporter.reset()
	resetReportedErrorsForTests()
})

afterEach(() => {
	trace.disable()
	context.disable()
	propagation.disable()
})

describe("without server OpenTelemetry", () => {
	it("passes the request, its options and the response through, with no header added", async () => {
		const response = await fetchPage(new Request("https://app.test/projects/1"), { status: 404 })
		expect(response.status).toBe(404)
		expect(response.headers.has("server-timing")).toBe(false)
	})

	it("rethrows what the handler throws", async () => {
		const error = new Error("handler failed")
		await expect(
			traceRequests(async () => {
				throw error
			})(new Request("https://app.test/")),
		).rejects.toBe(error)
	})
})

describe("with server OpenTelemetry", () => {
	beforeEach(registerServerOtel)

	it("puts the loaders and the render in one request span, named after the route", async () => {
		const response = await get("/projects/8f2a")

		const request = named("ssr /projects/$id")
		expect(request.kind).toBe(SpanKind.SERVER)
		expect(request.attributes).toMatchObject({
			"http.request.method": "GET",
			"url.path": "/projects/8f2a",
			"http.response.status_code": 200,
		})
		expect(parentOf(request)).toBeUndefined()
		const loader = named("loader /projects/$id")
		expect(parentOf(loader)).toBe(idOf(request))
		expect(parentOf(named("GET"))).toBe(idOf(loader))

		const { traceId, spanId } = request.spanContext()
		expect(response.headers.get("server-timing")).toBe(`traceparent;desc="00-${traceId}-${spanId}-01"`)
	})

	it("names a URL no route matches ssr not-found", async () => {
		await get("/does-not-exist")
		expect(named("ssr not-found").attributes["url.path"]).toBe("/does-not-exist")
	})

	it("doesn't count redirect() or notFound() as errors", async () => {
		await get("/old")
		await get("/projects/missing")
		expect(named("beforeLoad /old").status.code).toBe(SpanStatusCode.UNSET)
		expect(named("loader /projects/$id").status.code).toBe(SpanStatusCode.UNSET)
		expect(exceptionEvents()).toEqual([])
	})

	it("records a loader error once, on the loader span", async () => {
		await get("/broken-loader")
		expect(named("loader /broken-loader").status.code).toBe(SpanStatusCode.ERROR)
		expect(exceptionEvents()).toHaveLength(1)
	})

	it("keeps the method as the name of a request that doesn't render", async () => {
		const serverFunction = traceRequests(async () => Response.json({ ok: true }))
		const response = await serverFunction(
			new Request("https://app.test/_serverFn/abc", { method: "POST" }),
		)
		expect(named("POST").attributes["http.response.status_code"]).toBe(200)
		expect(response.headers.has("server-timing")).toBe(false)
	})

	it("marks a 5xx response Error, and a 4xx one not", async () => {
		await fetchPage(new Request("https://app.test/projects/1"), { status: 503 })
		await fetchPage(new Request("https://app.test/projects/2"), { status: 404 })
		const [failed, missing] = spans().filter((span) => span.kind === SpanKind.SERVER)
		expect(failed?.status.code).toBe(SpanStatusCode.ERROR)
		expect(missing?.status.code).toBe(SpanStatusCode.UNSET)
	})

	it("records what the handler throws and rethrows it", async () => {
		const error = new Error("handler failed")
		await expect(
			traceRequests(async () => {
				throw error
			})(new Request("https://app.test/")),
		).rejects.toBe(error)
		expect(named("GET").status.code).toBe(SpanStatusCode.ERROR)
		expect(exceptionEvents()).toHaveLength(1)
	})

	it("joins the trace a request carries, like a server function call from the browser", async () => {
		await get("/projects/1", { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" })
		const request = named("ssr /projects/$id")
		expect(request.spanContext().traceId).toBe("0af7651916cd43dd8448eb211c80319c")
		expect(parentOf(request)).toBe("b7ad6b7169203331")
	})

	it("nests under a request span the server's HTTP instrumentation already opened", async () => {
		await trace.getTracer("http").startActiveSpan("GET", async (span) => {
			await get("/projects/1", {
				traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
			})
			span.end()
		})
		const outer = spans().find((span) => span.instrumentationScope.name === "http")
		expect(outer).toBeDefined()
		expect(parentOf(named("ssr /projects/$id"))).toBe(outer && idOf(outer))
	})
})
