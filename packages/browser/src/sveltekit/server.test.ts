import { context, INVALID_SPAN_CONTEXT, type Span, trace } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import type { RequestEvent } from "@sveltejs/kit"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadSpan } from "./index"
import { mapleHandle } from "./server"

const exporter = new InMemorySpanExporter()

beforeEach(() => {
	context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
	trace.setGlobalTracerProvider(
		new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
	)
})

afterEach(() => {
	exporter.reset()
	trace.disable()
	context.disable()
})

const html = () =>
	new Response("<!doctype html>", { headers: { "content-type": "text/html", etag: 'W/"1"' } })

const traceparentOf = (span: Span) => {
	const { traceId, spanId } = span.spanContext()
	return `traceparent;desc="00-${traceId}-${spanId}-01"`
}

/** `handle` as SvelteKit calls it, inside a span that isn't the request's root: a `sequence` step's. */
async function run(response: Response, tracing: { readonly root: Span } | undefined) {
	// SAFETY: `mapleHandle` reads only `event.tracing`
	const event = { tracing } as RequestEvent
	return trace
		.getTracer("sveltekit")
		.startActiveSpan("sveltekit.handle.sequenced.mapleHandle", async (sequenced) => {
			try {
				return await mapleHandle({ event, resolve: async () => response })
			} finally {
				sequenced.end()
			}
		})
}

describe("mapleHandle", () => {
	it("names the request's root span in Server-Timing on a page, and drops its ETag", async () => {
		const root = trace.getTracer("sveltekit").startSpan("sveltekit.handle.root")
		const response = await run(html(), { root })
		root.end()

		expect(response.headers.get("server-timing")).toBe(traceparentOf(root))
		expect(response.headers.has("etag")).toBe(false)
	})

	it("keeps a Server-Timing header the response already has", async () => {
		const root = trace.getTracer("sveltekit").startSpan("sveltekit.handle.root")
		const page = html()
		page.headers.set("server-timing", "db;dur=53")
		const response = await run(page, { root })
		root.end()

		expect(response.headers.get("server-timing")).toBe(`db;dur=53, ${traceparentOf(root)}`)
	})

	it("leaves responses that aren't pages alone", async () => {
		const root = trace.getTracer("sveltekit").startSpan("sveltekit.handle.root")
		const json = Response.json({}, { headers: { etag: 'W/"1"' } })
		const response = await run(json, { root })
		root.end()

		expect(response.headers.has("server-timing")).toBe(false)
		expect(response.headers.get("etag")).toBe('W/"1"')
	})

	it("leaves pages alone without server tracing, or before SvelteKit 2.31", async () => {
		// Without it, `tracing.root` is a no-op span
		for (const tracing of [{ root: trace.wrapSpanContext(INVALID_SPAN_CONTEXT) }, undefined]) {
			const response = await run(html(), tracing)
			expect(response.headers.has("server-timing")).toBe(false)
			expect(response.headers.get("etag")).toBe('W/"1"')
		}
	})

	it("passes a page with immutable headers through", async () => {
		const root = trace.getTracer("sveltekit").startSpan("sveltekit.handle.root")
		const page = html()
		// As on a `fetch()` response a `+server.ts` returns as is
		vi.spyOn(page.headers, "append").mockImplementation(() => {
			throw new TypeError("immutable")
		})
		const response = await run(page, { root })
		root.end()

		expect(response).toBe(page)
		expect(response.headers.get("etag")).toBe('W/"1"')
	})
})

describe("loadSpan on the server", () => {
	it("only runs fn: SvelteKit's tracing spans the load", async () => {
		await expect(loadSpan("loader /projects/[id]", async () => "data")).resolves.toBe("data")
		const failure = new Error("loader exploded")
		await expect(
			loadSpan("loader /broken", async () => {
				throw failure
			}),
		).rejects.toBe(failure)

		expect(exporter.getFinishedSpans()).toEqual([])
	})
})
