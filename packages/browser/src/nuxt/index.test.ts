import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { context, trace } from "@opentelemetry/api"
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createApp, h } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { mapleNitroPlugin, mapleSsrPlugin } from "./index"

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

/** A request, as the HTTP instrumentation spans it. */
const request = <T>(fn: (traceparent: string) => Promise<T>): Promise<T> =>
	trace.getTracer("http").startActiveSpan("GET", async (span) => {
		const { traceId, spanId } = span.spanContext()
		try {
			return await fn(`00-${traceId}-${spanId}-01`)
		} finally {
			span.end()
		}
	})

describe("mapleNitroPlugin", () => {
	type RenderResponse = { headers?: Record<string, string> | undefined }

	/** Nitro's `render:response` hook, as the plugin registers it. */
	function renderResponse(): (response: RenderResponse) => void {
		let hook: ((response: RenderResponse) => void) | undefined
		mapleNitroPlugin({ hooks: { hook: (_name, fn) => (hook = fn) } })
		if (!hook) throw new Error("no render:response hook")
		return hook
	}

	it("adds the request's trace to a rendered page, keeping its headers", async () => {
		const hook = renderResponse()
		const response: RenderResponse = { headers: { "content-type": "text/html;charset=utf-8" } }
		const traceparent = await request(async (traceparent) => {
			hook(response)
			return traceparent
		})

		expect(response.headers).toEqual({
			"content-type": "text/html;charset=utf-8",
			"server-timing": `traceparent;desc="${traceparent}"`,
		})
	})

	it("appends to a Server-Timing header another plugin set", async () => {
		const hook = renderResponse()
		const response: RenderResponse = { headers: { "server-timing": "db;dur=53" } }
		const traceparent = await request(async (traceparent) => {
			hook(response)
			return traceparent
		})

		expect(response.headers?.["server-timing"]).toBe(`db;dur=53, traceparent;desc="${traceparent}"`)
	})

	it("changes nothing without an active span", () => {
		const hook = renderResponse()
		const response: RenderResponse = {}
		hook(response)

		expect(response).toEqual({})
	})
})

describe("mapleSsrPlugin", () => {
	/** The server render's router, with the plugin installed, as Nuxt sets them up. */
	function serverRouter() {
		const router = createRouter({
			history: createMemoryHistory(),
			routes: [
				{ path: "/", component: { render: () => h("p") } },
				{ path: "/projects/:id()", component: { render: () => h("p") } },
			],
		})
		const vueApp = createApp({ render: () => null }).use(router)
		mapleSsrPlugin({ vueApp })
		return router
	}

	it("names the request span after the page's route", async () => {
		const router = serverRouter()
		await request(() => router.push("/projects/8f2a"))

		expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["ssr /projects/:id()"])
	})

	it("keeps the request span's name for a URL no route matches", async () => {
		const router = serverRouter()
		await request(() => router.push("/does-not-exist"))

		expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["GET"])
	})
})
