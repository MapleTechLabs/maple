import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { context, trace } from "@opentelemetry/api"
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base"
import { type NextFetchEvent, NextRequest, NextResponse } from "next/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { withMapleProxy } from "./server"

const PAGE = "https://acme.test/projects/1"
const BROWSER_TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
const event = {} as NextFetchEvent

const pageRequest = (headers: Record<string, string> = {}) =>
	new NextRequest(PAGE, { headers: { accept: "text/html", cookie: "session=abc", ...headers } })

/** Run `fn` inside a span, as Next.js runs the proxy inside its `middleware` span. */
const inMiddlewareSpan = <T>(fn: (traceparent: string) => Promise<T>): Promise<T> =>
	trace.getTracer("next.js").startActiveSpan("middleware GET", async (span) => {
		const { traceId, spanId } = span.spanContext()
		try {
			return await fn(`00-${traceId}-${spanId}-01`)
		} finally {
			span.end()
		}
	})

/** The request headers the render sees, the way Next.js applies a proxy's response. */
function renderHeaders(request: NextRequest, response: Response): Record<string, string> {
	const overridden = response.headers.get("x-middleware-override-headers")
	if (overridden === null) return Object.fromEntries(request.headers)
	return Object.fromEntries(
		overridden
			.split(",")
			.map((name) => [name, response.headers.get(`x-middleware-request-${name}`) ?? ""]),
	)
}

describe("withMapleProxy", () => {
	describe("without server OpenTelemetry", () => {
		it("changes nothing", async () => {
			expect(await withMapleProxy()(pageRequest(), event)).toBeUndefined()
			const own = NextResponse.next()
			expect(await withMapleProxy(() => own)(pageRequest(), event)).toBe(own)
		})
	})

	describe("with server OpenTelemetry", () => {
		beforeEach(() => {
			context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
			trace.setGlobalTracerProvider(new BasicTracerProvider())
		})

		afterEach(() => {
			trace.disable()
			context.disable()
		})

		it("hands the middleware span to the render and the browser", async () => {
			const request = pageRequest()
			await inMiddlewareSpan(async (traceparent) => {
				const response = await withMapleProxy()(request, event)
				expect(response).toBeInstanceOf(NextResponse)
				if (!response) return
				expect(response.headers.get("x-middleware-next")).toBe("1")
				expect(response.headers.get("server-timing")).toBe(`traceparent;desc="${traceparent}"`)
				expect(renderHeaders(request, response)).toEqual({
					accept: "text/html",
					cookie: "session=abc",
					traceparent,
				})
			})
		})

		it("produces the headers the hand-written proxy did", async () => {
			const request = pageRequest()
			await inMiddlewareSpan(async (traceparent) => {
				const response = await withMapleProxy()(request, event)
				const headers = new Headers(request.headers)
				headers.set("traceparent", traceparent)
				const expected = NextResponse.next({ request: { headers } })
				expected.headers.set("server-timing", `traceparent;desc="${traceparent}"`)
				const sorted = (value: Response | null | undefined | void) =>
					[...(value?.headers ?? [])].map(([name, v]) =>
						name === "x-middleware-override-headers"
							? [name, v.split(",").sort().join(",")]
							: [name, v],
					)
				expect(sorted(response)).toEqual(sorted(expected))
			})
		})

		it("leaves requests that already carry a traceparent alone", async () => {
			const own = NextResponse.next()
			await inMiddlewareSpan(async () => {
				const request = pageRequest({ traceparent: BROWSER_TRACEPARENT })
				expect(await withMapleProxy()(request, event)).toBeUndefined()
				expect(await withMapleProxy(() => own)(request, event)).toBe(own)
				expect(own.headers.has("server-timing")).toBe(false)
			})
		})

		it("does nothing when no span is active", async () => {
			expect(await withMapleProxy()(pageRequest(), event)).toBeUndefined()
		})

		it("keeps the request headers the proxy set, and its response headers", async () => {
			const request = pageRequest()
			await inMiddlewareSpan(async (traceparent) => {
				const headers = new Headers(request.headers)
				headers.set("x-tenant", "acme")
				headers.delete("cookie")
				const own = NextResponse.next({ request: { headers } })
				own.headers.set("server-timing", "db;dur=12")
				own.cookies.set("seen", "1")
				expect(await withMapleProxy(() => own)(request, event)).toBe(own)
				expect(renderHeaders(request, own)).toEqual({
					accept: "text/html",
					"x-tenant": "acme",
					traceparent,
				})
				expect(own.headers.get("server-timing")).toBe(`db;dur=12, traceparent;desc="${traceparent}"`)
				expect(own.cookies.get("seen")?.value).toBe("1")
			})
		})

		it("adds to a plain next() the proxy returned, keeping every request header", async () => {
			const request = pageRequest()
			await inMiddlewareSpan(async (traceparent) => {
				const own = NextResponse.next()
				own.headers.set("x-frame-options", "DENY")
				const response = await withMapleProxy(() => own)(request, event)
				expect(response).toBe(own)
				expect(own.headers.get("x-frame-options")).toBe("DENY")
				expect(renderHeaders(request, own)).toEqual({
					accept: "text/html",
					cookie: "session=abc",
					traceparent,
				})
			})
		})

		it("waits for an async proxy and passes it the request and event", async () => {
			const request = pageRequest()
			let seen: [NextRequest, NextFetchEvent] | undefined
			await inMiddlewareSpan(async () => {
				const response = await withMapleProxy(async (incoming, fetchEvent) => {
					seen = [incoming, fetchEvent]
					await new Promise((resolve) => setTimeout(resolve, 1))
					return undefined
				})(request, event)
				expect(response?.headers.get("x-middleware-next")).toBe("1")
			})
			expect(seen).toEqual([request, event])
		})

		it("follows a rewrite within the app", async () => {
			const request = pageRequest()
			await inMiddlewareSpan(async (traceparent) => {
				const own = NextResponse.rewrite(new URL("/tenants/acme/projects/1", request.url))
				const response = await withMapleProxy(() => own)(request, event)
				expect(response).toBe(own)
				expect(own.headers.get("x-middleware-request-traceparent")).toBe(traceparent)
				expect(own.headers.get("server-timing")).toBe(`traceparent;desc="${traceparent}"`)
			})
		})

		it("does not send the trace to another origin a rewrite proxies to", async () => {
			await inMiddlewareSpan(async () => {
				const own = NextResponse.rewrite("https://third-party.test/projects/1")
				expect(await withMapleProxy(() => own)(pageRequest(), event)).toBe(own)
				expect(own.headers.has("x-middleware-override-headers")).toBe(false)
				expect(own.headers.has("server-timing")).toBe(false)
			})
		})

		it("passes the proxy's own responses through untouched, even immutable ones", async () => {
			await inMiddlewareSpan(async () => {
				for (const own of [
					NextResponse.redirect(new URL("/login", PAGE)),
					Response.redirect(new URL("/login", PAGE)),
					new Response("blocked", { status: 403 }),
					NextResponse.json({ ok: true }),
				]) {
					expect(await withMapleProxy(() => own)(pageRequest(), event)).toBe(own)
					expect(own.headers.has("server-timing")).toBe(false)
				}
			})
		})

		it("rethrows the proxy's error", async () => {
			const error = new Error("proxy failed")
			await inMiddlewareSpan(async () => {
				await expect(
					withMapleProxy(() => {
						throw error
					})(pageRequest(), event),
				).rejects.toBe(error)
			})
		})
	})
})
