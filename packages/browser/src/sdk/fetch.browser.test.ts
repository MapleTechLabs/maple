import { context, propagation, SpanKind } from "@opentelemetry/api"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StackContextManager } from "./context"
import { instrumentFetch } from "./fetch"
import { W3CTraceContextPropagator } from "./propagation"
import { InMemorySpanExporter, SimpleSpanProcessor } from "./testing"
import { TracerProvider } from "./tracer"

const exporter = new InMemorySpanExporter()
/** The `traceparent` each request reached the network with, or null. */
const sent: Array<string | null> = []
let unpatch: (() => void) | undefined
/** What the settlement hook was handed, per request. */
const settledWith: unknown[] = []

const setup = (options: { propagateTo?: RegExp[]; ignore?: RegExp[] } = {}): void => {
	const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] })
	instrumentation = instrumentFetch({
		tracer: provider.getTracer("test"),
		ignoreUrls: options.ignore ?? [],
		propagateTraceHeaderCorsUrls: options.propagateTo ?? [],
		applyCustomAttributesOnSpan: (_span, _request, result) => void settledWith.push(result),
	})
	unpatch = instrumentation.stop
}
let instrumentation: ReturnType<typeof instrumentFetch> | undefined

beforeEach(() => {
	exporter.reset()
	sent.length = 0
	settledWith.length = 0
	vi.useFakeTimers({ toFake: ["setTimeout"] })
	context.setGlobalContextManager(new StackContextManager().enable())
	propagation.setGlobalPropagator(new W3CTraceContextPropagator())
	vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
		const headers = input instanceof Request ? input.headers : new Headers(init?.headers)
		sent.push(headers.get("traceparent"))
		return Promise.resolve(new Response("ok", { status: 201 }))
	})
})

/** Undoes a test's change to the `fetch` property itself, before the global stubs are removed. */
let restoreFetch: (() => void) | undefined

afterEach(() => {
	restoreFetch?.()
	restoreFetch = undefined
	unpatch?.()
	vi.useRealTimers()
	vi.unstubAllGlobals()
	context.disable()
	propagation.disable()
})

/** Past each span's 300ms deferred end, once every response body has been read. */
const finished = async (requests: number) => {
	await vi.waitFor(() => expect(vi.getTimerCount()).toBe(requests), { interval: 0 })
	await vi.advanceTimersByTimeAsync(400)
	return exporter.getFinishedSpans()
}

const traceparentOf = (span: { spanContext: () => { traceId: string; spanId: string } }): string =>
	`00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`

describe("instrumentFetch", () => {
	it("spans a request as a CLIENT span named after its method, and propagates to its own origin", async () => {
		setup()
		const url = `${location.origin}/api/things?id=1`
		await (await fetch(url, { method: "post" })).text()

		const [span] = await finished(1)
		if (!span) throw new Error("no span")
		expect(span.name).toBe("POST")
		expect(span.kind).toBe(SpanKind.CLIENT)
		expect(span.attributes).toMatchObject({
			"http.request.method": "POST",
			"http.request.method_original": "post",
			"url.full": url,
			"http.response.status_code": 201,
		})
		expect(sent).toEqual([traceparentOf(span)])
	})

	it("sends traceparent cross-origin only to the URLs listed for it", async () => {
		setup({ propagateTo: [/^https:\/\/api\.test\//] })
		await fetch("https://api.test/things")
		await fetch("https://other.test/things")

		const [listed, unlisted] = await finished(2)
		if (!listed || !unlisted) throw new Error("expected two spans")
		expect(listed.attributes["url.full"]).toBe("https://api.test/things")
		expect(unlisted.attributes["url.full"]).toBe("https://other.test/things")
		expect(sent).toEqual([traceparentOf(listed), null])
	})

	it("adds traceparent to a Request object", async () => {
		setup()
		await fetch(new Request(`${location.origin}/api/request`))

		const [span] = await finished(1)
		if (!span) throw new Error("no span")
		expect(sent).toEqual([traceparentOf(span)])
	})

	it("leaves a fetch another script locked alone, untraced, instead of failing setup", async () => {
		const locked = globalThis.fetch
		Object.defineProperty(globalThis, "fetch", { value: locked, writable: false, configurable: true })
		restoreFetch = () =>
			Object.defineProperty(globalThis, "fetch", { value: locked, writable: true, configurable: true })
		setup()
		await fetch(`${location.origin}/api/locked`)

		expect(globalThis.fetch).toBe(locked)
		expect(sent).toEqual([null])
		expect(await finished(0)).toEqual([])
	})

	it("keeps the status of a Response an earlier fetch wrapper rejected with", async () => {
		const rejection = new Response("unavailable", { status: 503 })
		vi.stubGlobal("fetch", () => Promise.reject(rejection))
		setup()
		await expect(fetch(`${location.origin}/api/wrapped`)).rejects.toBe(rejection)

		const [span] = await finished(1)
		expect(span?.attributes["http.response.status_code"]).toBe(503)
		expect(span?.status.code).toBe(2)
		expect(settledWith).toEqual([rejection])
	})

	it("stops tracing on unpatch when fetch was locked after install", async () => {
		setup()
		const patched = globalThis.fetch
		Object.defineProperty(globalThis, "fetch", { value: patched, writable: false, configurable: true })
		restoreFetch = () =>
			Object.defineProperty(globalThis, "fetch", { value: patched, writable: true, configurable: true })
		unpatch?.()
		unpatch = undefined
		await fetch(`${location.origin}/api/after`)

		expect(sent).toEqual([null])
		expect(await finished(0)).toEqual([])
	})

	it("still sends a Request whose headers cannot be changed, spanned but without traceparent", async () => {
		setup()
		const request = new Request(`${location.origin}/api/immutable`)
		// What a Request with the "immutable" headers guard does on set.
		Object.defineProperty(request.headers, "set", {
			value: () => {
				throw new TypeError("Headers are immutable")
			},
		})
		const response = await fetch(request)

		expect(response.status).toBe(201)
		expect(sent).toEqual([null])
		expect(await finished(1)).toHaveLength(1)
	})

	it("ends an event stream's span at its headers, though the stream never ends", async () => {
		const stream = new ReadableStream<Uint8Array>({ start: () => {} })
		vi.stubGlobal("fetch", () =>
			Promise.resolve(
				new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8" } }),
			),
		)
		setup()
		await fetch(`${location.origin}/api/events`)

		const [span] = await finished(1)
		expect(span?.attributes["http.response.status_code"]).toBe(200)
	})

	it("recognises an event stream whatever the media type's case and parameters", async () => {
		const stream = new ReadableStream<Uint8Array>({ start: () => {} })
		vi.stubGlobal("fetch", () =>
			Promise.resolve(
				new Response(stream, { headers: { "content-type": " Text/Event-Stream ; charset=utf-8" } }),
			),
		)
		setup()
		await fetch(`${location.origin}/api/events`)

		expect(await finished(1)).toHaveLength(1)
	})

	it("ends a body still streaming when asked, at once, marked unfinished", async () => {
		const stream = new ReadableStream<Uint8Array>({ start: () => {} })
		vi.stubGlobal("fetch", () => Promise.resolve(new Response(stream, { status: 206 })))
		setup()
		await fetch(`${location.origin}/api/long-poll`)
		expect(await finished(0)).toEqual([])

		instrumentation?.endUnfinishedBodies()
		const [span] = exporter.getFinishedSpans()
		expect(span?.attributes["maple.response_body_unfinished"]).toBe(true)
		expect(span?.attributes["http.response.status_code"]).toBe(206)
	})

	it("still ends any other streamed response's span only once its body is read", async () => {
		let close = (): void => {}
		const stream = new ReadableStream<Uint8Array>({
			start: (controller) => {
				close = () => controller.close()
			},
		})
		vi.stubGlobal("fetch", () => Promise.resolve(new Response(stream)))
		setup()
		await fetch(`${location.origin}/api/download`)

		expect(await finished(0)).toEqual([])
		close()
		expect(await finished(1)).toHaveLength(1)
	})

	it("neither spans nor propagates to an ignored URL", async () => {
		setup({ ignore: [/\/v1\//] })
		await fetch(`${location.origin}/v1/traces`)

		expect(await finished(0)).toEqual([])
		expect(sent).toEqual([null])
	})
})
