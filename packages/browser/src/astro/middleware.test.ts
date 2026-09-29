import { context, SpanStatusCode, trace } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import type { APIContext, MiddlewareNext } from "astro"
import { defineMiddleware, sequence } from "astro/middleware"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetReportedErrorsForTests } from "../failures"
import { onRequest } from "./middleware"

const exporter = new InMemorySpanExporter()
const spans = () => exporter.getFinishedSpans()
const idOf = (span: ReadableSpan) => span.spanContext().spanId

const PAGE = '<!DOCTYPE html><html lang="en"><head></head><body>page</body></html>'
const STAMPED =
	'<!DOCTYPE html><html data-route="/projects/[id]" lang="en"><head></head><body>page</body></html>'

const html = (body: BodyInit | null = PAGE, init: ResponseInit = {}) =>
	new Response(body, { ...init, headers: { "content-type": "text/html", ...init.headers } })

/** The fields of Astro's context the middleware reads. `cache` is missing before Astro 7. */
interface PageContext {
	readonly routePattern: string | undefined
	readonly isPrerendered: boolean
	readonly cache?: { readonly options: { readonly maxAge?: number; readonly swr?: number } }
}

/** What Astro hands middleware, for a page at `/projects/[id]` rendered on demand. */
const ctx = (overrides: Partial<PageContext> = {}): APIContext => {
	const page: PageContext = {
		routePattern: "/projects/[id]",
		isPrerendered: false,
		cache: { options: {} },
		...overrides,
	}
	// SAFETY: the middleware reads only these fields
	return page as APIContext
}

const run = async (next: () => Promise<Response>, context = ctx()): Promise<Response> =>
	(await onRequest(context, next as MiddlewareNext)) as Response

const traceparentIn = (response: Response) =>
	/traceparent;desc="([^"]+)"/.exec(response.headers.get("server-timing") ?? "")?.[1]

beforeEach(() => {
	exporter.reset()
	resetReportedErrorsForTests()
})

it("leaves Astro 4 and older alone, which have no route pattern", async () => {
	const page = html()
	expect(await run(async () => page, ctx({ routePattern: undefined }))).toBe(page)
})

describe("without server OpenTelemetry", () => {
	it("adds the route and no Server-Timing", async () => {
		const response = await run(async () => html())
		expect(response.headers.has("server-timing")).toBe(false)
		expect(await response.text()).toBe(STAMPED)
	})
})

describe("with server OpenTelemetry", () => {
	beforeEach(() => {
		context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
		trace.setGlobalTracerProvider(
			new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
		)
	})

	afterEach(() => {
		trace.disable()
		context.disable()
	})

	it("renders on demand in an ssr span that the page load joins", async () => {
		let rendering: string | undefined
		const response = await run(async () => {
			rendering = trace.getActiveSpan()?.spanContext().spanId
			return html(PAGE, {
				status: 201,
				statusText: "Created",
				headers: { "set-cookie": "a=1", "content-length": "70" },
			})
		})
		const [span] = spans()
		expect(span?.name).toBe("ssr /projects/[id]")
		expect(rendering).toBe(idOf(span!))
		expect(traceparentIn(response)).toBe(`00-${span!.spanContext().traceId}-${idOf(span!)}-01`)
		expect(response.status).toBe(201)
		expect(response.statusText).toBe("Created")
		expect(response.headers.get("set-cookie")).toBe("a=1")
		// The body is longer now
		expect(response.headers.has("content-length")).toBe(false)
		expect(await response.text()).toBe(STAMPED)
	})

	it("keeps Server-Timing entries the response has", async () => {
		const response = await run(async () => html(PAGE, { headers: { "server-timing": "db;dur=5" } }))
		expect(response.headers.get("server-timing")).toMatch(/^db;dur=5, traceparent;desc="00-/)
	})

	it("ends the span when streaming starts, and streams the rest", async () => {
		let finish: (() => void) | undefined
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('<!DOCTYPE html><html lang="en"><body>'))
				finish = () => {
					controller.enqueue(new TextEncoder().encode("late</body></html>"))
					controller.close()
				}
			},
		})
		const response = await run(async () => html(body))
		expect(spans()).toHaveLength(1)
		const reader = response.body!.getReader()
		let head = ""
		while (!head.includes("<body>")) head += new TextDecoder().decode((await reader.read()).value)
		expect(head).toBe('<!DOCTYPE html><html data-route="/projects/[id]" lang="en"><body>')
		finish?.()
		expect(new TextDecoder().decode((await reader.read()).value)).toBe("late</body></html>")
	})

	it("sends no Server-Timing on responses that aren't HTML, and leaves them alone", async () => {
		const json = Response.json({ ok: true })
		expect(await run(async () => json, ctx({ routePattern: "/api/projects" }))).toBe(json)
		expect(spans().map((span) => span.name)).toEqual(["ssr /api/projects"])
		const redirect = new Response(null, { status: 302, headers: { location: "/" } })
		expect(await run(async () => redirect)).toBe(redirect)
	})

	it("sends no Server-Timing on pages the route cache replays", async () => {
		const response = await run(async () => html(), ctx({ cache: { options: { maxAge: 60 } } }))
		expect(response.headers.has("server-timing")).toBe(false)
		expect(await response.text()).toBe(STAMPED)
	})

	it("sends no Server-Timing on pages a shared cache may store", async () => {
		for (const headers of [
			{ "cache-control": "public, max-age=60" } as HeadersInit,
			{ "cache-control": "s-maxage=300, stale-while-revalidate" },
			{ "cache-control": "max-age=60" },
			{ "cdn-cache-control": "max-age=60" },
			{ "vercel-cdn-cache-control": "max-age=60" },
			{ "surrogate-control": "max-age=60" },
		]) {
			const response = await run(async () => html(PAGE, { headers }))
			expect(response.headers.has("server-timing"), JSON.stringify(headers)).toBe(false)
			expect(await response.text()).toBe(STAMPED)
		}
		for (const headers of [
			{ "cache-control": "private, max-age=60" } as HeadersInit,
			{ "cache-control": "no-store" },
			{ "cache-control": "max-age=0, must-revalidate" },
			{ "cdn-cache-control": "no-store" },
			{ "cdn-cache-control": "private" },
		]) {
			expect(
				traceparentIn(await run(async () => html(PAGE, { headers }))),
				JSON.stringify(headers),
			).toBeDefined()
		}
	})

	it("sends Server-Timing when the route cache doesn't store the page", async () => {
		expect(
			traceparentIn(await run(async () => html(), ctx({ cache: { options: { maxAge: 0 } } }))),
		).toBeDefined()
		const stale = await run(async () => html(), ctx({ cache: { options: { maxAge: 0, swr: 60 } } }))
		expect(stale.headers.has("server-timing")).toBe(false)
	})

	it("sends Server-Timing on Astro 6 and older, which have no route cache", async () => {
		expect(traceparentIn(await run(async () => html(), ctx({ cache: undefined })))).toBeDefined()
	})

	it("adds the route to prerendered pages at build time, with no span", async () => {
		const response = await run(async () => html(), ctx({ isPrerendered: true }))
		expect(spans()).toHaveLength(0)
		expect(response.headers.has("server-timing")).toBe(false)
		expect(await response.text()).toBe(STAMPED)
	})

	it("doesn't read a compressed body", async () => {
		const gzipped = new Uint8Array([31, 139, 8, 0])
		const response = await run(async () =>
			html(gzipped, { headers: { "content-encoding": "gzip", "content-length": "4" } }),
		)
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(gzipped)
		expect(response.headers.get("content-length")).toBe("4")
		expect(traceparentIn(response)).toBeDefined()
	})

	it("marks the span failed on a 5xx", async () => {
		await run(async () => html(PAGE, { status: 503 }))
		expect(spans()[0]?.status.code).toBe(SpanStatusCode.ERROR)
	})

	it("records an error that fails the render once, and rethrows it", async () => {
		const error = new Error("frontmatter exploded")
		await expect(
			run(async () => {
				throw error
			}),
		).rejects.toBe(error)
		const [span] = spans()
		expect(span?.status.code).toBe(SpanStatusCode.ERROR)
		expect(span?.events.filter((event) => event.name === "exception")).toHaveLength(1)
	})

	it("keeps the route of the page a rewrite rendered, which runs the middleware again", async () => {
		// `Astro.rewrite("/404")` renders the other page through the whole middleware chain
		const response = await run(() => run(async () => html(), ctx({ routePattern: "/404" })))
		expect(await response.text()).toBe(STAMPED.replace("/projects/[id]", "/404"))
		const [inner, outer] = spans()
		expect(inner?.name).toBe("ssr /404")
		expect(inner?.parentSpanContext?.spanId).toBe(idOf(outer!))
	})

	it("composes with sequence(), first in the chain", async () => {
		const own = defineMiddleware(async (_context, next) => {
			const response = await next()
			response.headers.set("x-own", trace.getActiveSpan()?.spanContext().spanId ?? "none")
			return response
		})
		const response = (await sequence(onRequest, own)(ctx(), (async () =>
			html()) as MiddlewareNext)) as Response
		expect(response.headers.get("x-own")).toBe(idOf(spans()[0]!))
		expect(traceparentIn(response)).toBeDefined()
		expect(await response.text()).toBe(STAMPED)
	})
})
