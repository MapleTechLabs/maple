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
	hookSaw.length = 0
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
	unpatch = instrument()
})

const instrument = (): (() => void) =>
	instrumentXhr({
		tracer: new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] }).getTracer(
			"test",
		),
		ignoreUrls: [],
		propagateTraceHeaderCorsUrls: [],
		applyCustomAttributesOnSpan: (_span, response) => void hookSaw.push(response.status),
	})

/** The response status the settlement hook saw, per request, in settling order. */
const hookSaw: number[] = []

/** Undoes a test's change to an XMLHttpRequest.prototype property. */
let restoreProto: (() => void) | undefined

afterEach(() => {
	unpatch?.()
	restoreProto?.()
	restoreProto = undefined
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

/**
 * Reopen and send from `readystatechange` at DONE, which runs before `load`/`error`; reopening
 * there means the browser never fires `load` for the first request.
 */
async function reuseFromReadyStateChange(first: string, second: string): Promise<void> {
	const xhr = new XMLHttpRequest()
	let reopened = false
	const done = new Promise<void>((resolve) => {
		xhr.onreadystatechange = () => {
			if (xhr.readyState !== XMLHttpRequest.DONE) return
			if (reopened) return resolve()
			reopened = true
			xhr.open("GET", second)
			xhr.send()
		}
	})
	xhr.open("GET", first)
	xhr.send()
	await done
	await ended(2)
}

const absolute = (path: string): string => new URL(path, location.href).href

describe("instrumentXhr with one XMLHttpRequest reused from readystatechange", () => {
	it("ends the first request's span when it succeeded", async () => {
		const [a, b] = [blobUrl("a"), blobUrl("b")]
		await reuseFromReadyStateChange(a, b)

		const spans = exporter.getFinishedSpans()
		expectTwoRequests(spans, [a, b], [200, 200])
		expect(spans.map((span) => span.events.at(-1)?.name)).toEqual(["loaded", "loaded"])
	})

	it("ends the first request's span, as an error, when it answered with an error status", async () => {
		const [a, b] = [absolute("/__maple_missing__.json"), blobUrl("b")]
		await reuseFromReadyStateChange(a, b)

		const spans = exporter.getFinishedSpans()
		expectTwoRequests(spans, [a, b], [404, 200])
		expect(spans.map((span) => span.events.at(-1)?.name)).toEqual(["error", "loaded"])
		expect(spans.map((span) => span.status.code)).toEqual([2, 0])
	})

	it("ends the first request's span when it failed without a response", async () => {
		const a = blobUrl("gone")
		URL.revokeObjectURL(a)
		const b = blobUrl("b")
		await reuseFromReadyStateChange(a, b)

		const spans = exporter.getFinishedSpans()
		expectTwoRequests(spans, [a, b], [undefined, 200])
		expect(spans.map((span) => span.attributes["error.type"])).toEqual(["error", undefined])
	})
})

describe("instrumentXhr reused synchronously after a failure", () => {
	it("hands the failed request's own empty response to the hook, not the next request's", async () => {
		const a = blobUrl("gone")
		URL.revokeObjectURL(a)
		const xhr = new XMLHttpRequest()
		xhr.onreadystatechange = () => {
			if (xhr.readyState !== XMLHttpRequest.DONE || xhr.onreadystatechange === null) return
			xhr.onreadystatechange = null
			// A synchronous request completes inside this handler, before the first one's error event.
			xhr.open("GET", blobUrl("b"), false)
			xhr.send()
		}
		xhr.open("GET", a)
		xhr.send()
		await vi.waitFor(() => expect(hookSaw).toHaveLength(2), { interval: 0 })
		await ended(2)

		expect(hookSaw).toEqual([200, 0])
	})
})

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

describe("instrumentXhr unpatched after another script locked open", () => {
	it("still restores send, so requests run untraced", async () => {
		unpatch?.()
		const proto = XMLHttpRequest.prototype
		const open = Object.getOwnPropertyDescriptor(proto, "open")
		const send = Object.getOwnPropertyDescriptor(proto, "send")
		if (!open || !send) throw new Error("no XMLHttpRequest methods")
		unpatch = instrument()
		const patchedOpen = Object.getOwnPropertyDescriptor(proto, "open")
		Object.defineProperty(proto, "open", { ...patchedOpen, writable: false })
		restoreProto = () => Object.defineProperty(proto, "open", open)
		unpatch()
		unpatch = undefined

		expect(Object.getOwnPropertyDescriptor(proto, "send")?.value).toBe(send.value)
		const xhr = new XMLHttpRequest()
		xhr.open("GET", blobUrl("a"))
		const done = settled(xhr)
		xhr.send()
		await done
		await ended(0)
		expect(traceparents).toEqual([])
	})
})

describe("instrumentXhr when another script locked send", () => {
	it("patches neither method, so requests run untraced instead of half-instrumented", async () => {
		unpatch?.()
		const proto = XMLHttpRequest.prototype
		const open = Object.getOwnPropertyDescriptor(proto, "open")
		const send = Object.getOwnPropertyDescriptor(proto, "send")
		if (!open || !send) throw new Error("no XMLHttpRequest methods")
		Object.defineProperty(proto, "send", { ...send, writable: false })
		restoreProto = () => Object.defineProperty(proto, "send", send)
		unpatch = instrument()

		expect(Object.getOwnPropertyDescriptor(proto, "open")?.value).toBe(open.value)
		const xhr = new XMLHttpRequest()
		xhr.open("GET", blobUrl("a"))
		const done = settled(xhr)
		xhr.send()
		await done
		await ended(0)
		expect(traceparents).toEqual([])
	})
})
