import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { context, SpanStatusCode, trace } from "@opentelemetry/api"
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { createRequestHandler, type HandleDocumentRequestFunction, type ServerBuild } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetReportedErrorsForTests } from "../failures"
import { serverTiming } from "../server"
import { handleError, serverInstrumentation } from "./server"

const exporter = new InMemorySpanExporter()
const spans = () => exporter.getFinishedSpans()
const names = () => spans().map((span) => span.name)
const named = (name: string): ReadableSpan => {
	const span = spans().find((candidate) => candidate.name === name)
	if (!span) throw new Error(`no span named ${name}: ${names().join(", ")}`)
	return span
}
const parentOf = (span: ReadableSpan) => span.parentSpanContext?.spanId
const idOf = (span: ReadableSpan) => span.spanContext().spanId
const exceptions = (span: ReadableSpan) =>
	span.events
		.filter((event) => event.name === "exception")
		.map((event) => event.attributes?.["exception.message"])

/** `entry.server.tsx`'s `handleRequest`, reduced to the line that hands the trace to the browser. */
const handleRequest: HandleDocumentRequestFunction = (request, status, headers) => {
	const timing = serverTiming()
	if (timing) headers.append("server-timing", timing)
	// The first render throws; the second renders the error boundary
	if (new URL(request.url).pathname === "/broken-render" && status !== 500)
		throw new Error("render exploded")
	return new Response("<html></html>", { status, headers })
}

const page = { default: () => null }
/** A React Router build with the Maple exports in its server entry, as `react-router build` makes it. */
const build: ServerBuild = {
	entry: { module: { default: handleRequest, instrumentations: [serverInstrumentation], handleError } },
	routes: {
		root: { id: "root", path: "", module: { ...page, ErrorBoundary: () => null } },
		"routes/project": {
			id: "routes/project",
			parentId: "root",
			path: "projects/:id",
			module: {
				...page,
				loader: async ({ params }) => ({ id: params.id }),
			},
		},
		"routes/broken-loader": {
			id: "routes/broken-loader",
			parentId: "root",
			path: "broken-loader",
			module: {
				...page,
				loader: () => {
					throw new Error("loader exploded")
				},
			},
		},
		"routes/broken-render": {
			id: "routes/broken-render",
			parentId: "root",
			path: "broken-render",
			module: page,
		},
	},
	assets: { entry: { module: "", imports: [] }, routes: {}, url: "", version: "1" },
	future: {},
	publicPath: "/",
	assetsBuildDirectory: "",
	ssr: true,
	isSpaMode: false,
	prerender: [],
	routeDiscovery: { mode: "lazy", manifestPath: "/__manifest" },
}

const handler = createRequestHandler(build, "production")

/** A request through the handler, inside the HTTP span the Node SDK opens for it. */
const serve = (path: string): Promise<Response> =>
	trace.getTracer("http").startActiveSpan("GET", async (span) => {
		try {
			return await handler(new Request(`https://acme.test${path}`))
		} finally {
			span.end()
		}
	})

let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
	consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
	exporter.reset()
	resetReportedErrorsForTests()
	vi.restoreAllMocks()
	trace.disable()
	context.disable()
})

describe("with server OpenTelemetry", () => {
	beforeEach(() => {
		context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
		trace.setGlobalTracerProvider(
			new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
		)
	})

	it("names the request span after the route, under the HTTP span, with the loader under it", async () => {
		const response = await serve("/projects/1")

		const request = named("GET /projects/:id")
		expect(parentOf(request)).toBe(idOf(named("GET")))
		expect(parentOf(named("loader routes/project"))).toBe(idOf(request))
		expect(request.attributes["http.response.status_code"]).toBe(200)
		expect(request.status.code).toBe(SpanStatusCode.UNSET)
		// The page load joins the request span
		const { traceId, spanId } = request.spanContext()
		expect(response.headers.get("server-timing")).toBe(`traceparent;desc="00-${traceId}-${spanId}-01"`)
	})

	it("traces a client navigation's data request, which carries no Server-Timing", async () => {
		const response = await serve("/projects/1.data")

		expect(response.headers.get("server-timing")).toBeNull()
		expect(parentOf(named("loader routes/project"))).toBe(idOf(named("GET /projects/:id")))
	})

	it("records a loader error once, on the loader span", async () => {
		await serve("/broken-loader")

		expect(named("loader routes/broken-loader").status.code).toBe(SpanStatusCode.ERROR)
		expect(spans().flatMap(exceptions)).toEqual(["loader exploded"])
		// Logged as React Router's default `handleError` logs it
		expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({ message: "loader exploded" }))
	})

	it("records a render error on the request span, which fails with the 500", async () => {
		const response = await serve("/broken-render")

		expect(response.status).toBe(500)
		const request = named("GET /broken-render")
		expect(exceptions(request)).toEqual(["render exploded"])
		expect(request.status.code).toBe(SpanStatusCode.ERROR)
		expect(spans().flatMap(exceptions)).toHaveLength(1)
	})

	it("records nothing for a URL no route matches, and logs it as React Router does", async () => {
		const response = await serve("/does-not-exist")

		expect(response.status).toBe(404)
		const request = named("GET /")
		expect(request.attributes["http.response.status_code"]).toBe(404)
		expect(request.status.code).toBe(SpanStatusCode.UNSET)
		expect(spans().flatMap(exceptions)).toEqual([])
		expect(consoleError).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining("No route matches") }),
		)
	})

	it("neither logs nor records an aborted request's error", () => {
		const aborted = new AbortController()
		aborted.abort()
		trace.getTracer("http").startActiveSpan("GET", (span) => {
			handleError(new Error("client went away"), {
				request: new Request("https://acme.test/", { signal: aborted.signal }),
				context: undefined as never,
				params: {},
			})
			span.end()
		})

		expect(consoleError).not.toHaveBeenCalled()
		expect(spans().flatMap(exceptions)).toEqual([])
	})
})

describe("without server OpenTelemetry", () => {
	it("serves the page unchanged", async () => {
		const response = await serve("/projects/1")

		expect(response.status).toBe(200)
		expect(response.headers.get("server-timing")).toBeNull()
		expect(spans()).toEqual([])
	})
})
