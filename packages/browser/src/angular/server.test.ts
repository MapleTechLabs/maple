import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { context, SpanStatusCode, trace } from "@opentelemetry/api"
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetReportedErrorsForTests } from "../failures"
import { traced } from "../server"
import { tracedRender } from "./server"

const exporter = new InMemorySpanExporter()
const spans = () => exporter.getFinishedSpans()

/** A page as `AngularNodeAppEngine.handle()` renders it. */
const page = () => new Response("<html></html>", { headers: { "content-type": "text/html;charset=UTF-8" } })

/** The request's server span, as the HTTP instrumentation opens it. */
const request = <T>(fn: () => Promise<T>): Promise<T> =>
	trace.getTracer("http").startActiveSpan("GET", async (span) => {
		try {
			return await fn()
		} finally {
			span.end()
		}
	})

beforeEach(() => {
	exporter.reset()
	resetReportedErrorsForTests()
})

afterEach(() => {
	trace.disable()
	context.disable()
})

describe("tracedRender without server OpenTelemetry", () => {
	it("only runs render, passing its response and error through unchanged", async () => {
		const response = page()
		await expect(tracedRender({ url: "/" }, async () => response)).resolves.toBe(response)
		expect(response.headers.get("server-timing")).toBeNull()
		const error = new Error("render failed")
		await expect(
			tracedRender({ url: "/" }, async () => {
				throw error
			}),
		).rejects.toBe(error)
	})
})

describe("tracedRender with server OpenTelemetry", () => {
	beforeEach(() => {
		context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
		trace.setGlobalTracerProvider(
			new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
		)
	})

	it("renders in an ssr span under the request's, and hands its trace to the page", async () => {
		const response = await request(() =>
			tracedRender({ url: "/projects/1?tab=members" }, async () => page()),
		)

		const [ssr, server] = spans()
		expect(ssr?.name).toBe("ssr")
		expect(ssr?.attributes["url.path"]).toBe("/projects/1")
		expect(ssr?.parentSpanContext?.spanId).toBe(server?.spanContext().spanId)
		expect(response?.headers.get("server-timing")).toBe(
			`traceparent;desc="00-${ssr?.spanContext().traceId}-${ssr?.spanContext().spanId}-01"`,
		)
	})

	it("parents the render's own spans to it, across await", async () => {
		await tracedRender({ url: "/projects/1" }, async () => {
			await new Promise((resolve) => setTimeout(resolve, 1))
			await traced("loader /projects/:id", async () => undefined)
			return page()
		})

		const [loader, ssr] = spans()
		expect(loader?.parentSpanContext?.spanId).toBe(ssr?.spanContext().spanId)
	})

	it("takes the path from an absolute URL, as a fetch Request carries it", async () => {
		await tracedRender(new Request("https://acme.test/projects/1?tab=members#top"), async () => page())
		await tracedRender({ url: "https://acme.test" }, async () => page())
		await tracedRender({ url: "*" }, async () => null)
		await tracedRender({}, async () => null)

		expect(spans().map((span) => span.attributes["url.path"])).toEqual([
			"/projects/1",
			"/",
			"*",
			undefined,
		])
	})

	it("passes a missing page through", async () => {
		await expect(tracedRender({ url: "/assets/x.js" }, async () => null)).resolves.toBeNull()
	})

	it("keeps a page whose headers are immutable as it is", async () => {
		const immutable = page()
		Object.defineProperty(immutable, "headers", { value: new ImmutableHeaders(immutable.headers) })
		await expect(tracedRender({ url: "/" }, async () => immutable)).resolves.toBe(immutable)

		expect(spans()[0]?.status.code).toBe(SpanStatusCode.UNSET)
	})

	it("keeps a server-timing header the page already has", async () => {
		const response = page()
		response.headers.set("server-timing", "cache;desc=miss")
		await tracedRender({ url: "/" }, async () => response)

		expect(response.headers.get("server-timing")).toMatch(/^cache;desc=miss, traceparent;desc="00-/)
	})

	it("records a render error on the span and rethrows it", async () => {
		const error = new Error("render failed")
		await expect(
			tracedRender({ url: "/" }, async () => {
				throw error
			}),
		).rejects.toBe(error)

		expect(spans()[0]?.status.code).toBe(SpanStatusCode.ERROR)
		expect(spans()[0]?.events[0]?.attributes?.["exception.message"]).toBe("render failed")
	})
})

/** Headers that throw on write, like a `fetch()` response's. */
class ImmutableHeaders extends Headers {
	override append(): void {
		throw new TypeError("immutable")
	}
}
