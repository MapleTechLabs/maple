import { context, propagation } from "@opentelemetry/api"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StackContextManager } from "./context"
import { W3CTraceContextPropagator } from "./propagation"
import type { ReadableSpan } from "./span"
import { InMemorySpanExporter, SimpleSpanProcessor } from "./testing"
import { TracerProvider } from "./tracer"
import { instrumentXhr } from "./xhr"

const exporter = new InMemorySpanExporter()
const traceparents: string[] = []
let unpatch: (() => void) | undefined

beforeEach(() => {
	exporter.reset()
	traceparents.length = 0
	vi.useFakeTimers({ toFake: ["setTimeout"] })
	context.setGlobalContextManager(new StackContextManager().enable())
	propagation.setGlobalPropagator(new W3CTraceContextPropagator())
	const setRequestHeader = XMLHttpRequest.prototype.setRequestHeader
	vi.spyOn(XMLHttpRequest.prototype, "setRequestHeader").mockImplementation(function (
		this: XMLHttpRequest,
		name: string,
		value: string,
	) {
		if (name === "traceparent") traceparents.push(value)
		setRequestHeader.call(this, name, value)
	})
	const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] })
	unpatch = instrumentXhr({
		tracer: provider.getTracer("test"),
		ignoreUrls: [],
		propagateTraceHeaderCorsUrls: [],
		applyCustomAttributesOnSpan: () => {},
	})
})

afterEach(() => {
	unpatch?.()
	vi.useRealTimers()
	vi.restoreAllMocks()
	context.disable()
	propagation.disable()
})

const blobUrl = (text: string): string => URL.createObjectURL(new Blob([text]))
const settled = (xhr: XMLHttpRequest): Promise<void> =>
	new Promise((resolve) => xhr.addEventListener("loadend", () => resolve(), { once: true }))
/** Runs the first request's 300ms deferred end while the second is still in flight. */
const passDeferredEnd = (): void => {
	vi.advanceTimersByTime(400)
}
const ended = async (count: number): Promise<void> => {
	await vi.advanceTimersByTimeAsync(400)
	expect(exporter.getFinishedSpans()).toHaveLength(count)
}

const nanos = ([seconds, ns]: readonly [number, number]): bigint =>
	BigInt(seconds) * 1_000_000_000n + BigInt(ns)

/** Each span's URL, status and own `traceparent`, and that the second began after the first settled. */
function expectTwoRequests(
	spans: ReadableSpan[],
	urls: [string, string],
	statuses: [unknown, unknown],
): void {
	const [first, second] = spans
	if (!first || !second) throw new Error("expected two spans")
	expect(spans.map((span) => span.attributes["url.full"])).toEqual(urls)
	expect(spans.map((span) => span.attributes["http.response.status_code"])).toEqual(statuses)
	expect(traceparents).toEqual(
		spans.map((span) => `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`),
	)
	expect(nanos(second.startTime) >= nanos(first.endTime)).toBe(true)
}

describe("instrumentXhr with one XMLHttpRequest reused", () => {
	it("spans a second request sent from the first one's loadend", async () => {
		const [a, b] = [blobUrl("a"), blobUrl("b")]
		const xhr = new XMLHttpRequest()
		const second = new Promise<void>((resolve) => {
			xhr.addEventListener(
				"loadend",
				() => {
					xhr.open("GET", b)
					void settled(xhr).then(resolve)
					xhr.send()
					passDeferredEnd()
				},
				{ once: true },
			)
		})
		xhr.open("GET", a)
		xhr.send()
		await second
		await ended(2)

		const spans = exporter.getFinishedSpans()
		expectTwoRequests(spans, [a, b], [200, 200])
		expect(spans.map((span) => span.events.at(-1)?.name)).toEqual(["loaded", "loaded"])
	})

	it("spans a request sent after the previous one was aborted", async () => {
		const [a, b] = [blobUrl("a"), blobUrl("b")]
		const xhr = new XMLHttpRequest()
		xhr.open("GET", a)
		xhr.send()
		xhr.abort()
		xhr.open("GET", b)
		const done = settled(xhr)
		xhr.send()
		passDeferredEnd()
		await done
		await ended(2)

		const spans = exporter.getFinishedSpans()
		expectTwoRequests(spans, [a, b], [undefined, 200])
		expect(spans.map((span) => span.events.at(-1)?.name)).toEqual(["abort", "loaded"])
	})
})
