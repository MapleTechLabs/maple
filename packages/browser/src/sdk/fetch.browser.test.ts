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

const setup = (options: { propagateTo?: RegExp[]; ignore?: RegExp[] } = {}): void => {
	const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] })
	unpatch = instrumentFetch({
		tracer: provider.getTracer("test"),
		ignoreUrls: options.ignore ?? [],
		propagateTraceHeaderCorsUrls: options.propagateTo ?? [],
		applyCustomAttributesOnSpan: () => {},
	})
}

beforeEach(() => {
	exporter.reset()
	sent.length = 0
	vi.useFakeTimers({ toFake: ["setTimeout"] })
	context.setGlobalContextManager(new StackContextManager().enable())
	propagation.setGlobalPropagator(new W3CTraceContextPropagator())
	vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
		const headers = input instanceof Request ? input.headers : new Headers(init?.headers)
		sent.push(headers.get("traceparent"))
		return Promise.resolve(new Response("ok", { status: 201 }))
	})
})

afterEach(() => {
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

	it("neither spans nor propagates to an ignored URL", async () => {
		setup({ ignore: [/\/v1\//] })
		await fetch(`${location.origin}/v1/traces`)

		expect(await finished(0)).toEqual([])
		expect(sent).toEqual([null])
	})
})
