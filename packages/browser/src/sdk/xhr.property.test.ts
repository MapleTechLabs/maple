// One XMLHttpRequest reused for many requests, in every order the spec allows the
// app to reopen it: each request that went out is spanned once, with its own outcome.
import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { InMemorySpanExporter, SimpleSpanProcessor } from "./testing"
import { TracerProvider } from "./tracer"
import { instrumentXhr } from "./xhr"

type Failure = "error" | "timeout" | "abort"
type Outcome = { readonly respond: number } | { readonly fail: Failure } | "reopenedMidFlight"
/** Where the app reopens the xhr for the next request. */
type Reuse = "afterLoadend" | "fromReadyStateChange"

/** The spec's event order, which is what the instrumentation has to survive. */
class FakeXhr extends EventTarget {
	static readonly DONE = 4
	readyState = 0
	status = 0
	private sent = false

	open(_method: string, _url: string): void {
		// Reopening a request in flight drops it with no events.
		this.readyState = 1
		this.status = 0
		this.sent = false
	}

	send(): void {
		this.sent = true
	}

	setRequestHeader(): void {}

	getAllResponseHeaders(): string {
		return ""
	}

	/** Response or failure steps: DONE and `readystatechange`, then the rest only if still DONE (load) or always (failures). */
	finish(outcome: { readonly respond: number } | { readonly fail: Failure }): void {
		if (!this.sent) return
		this.readyState = 4
		this.status = "respond" in outcome ? outcome.respond : 0
		this.dispatchEvent(new Event("readystatechange"))
		if ("respond" in outcome) {
			if (this.readyState !== 4) return
			this.dispatchEvent(new Event("load"))
		} else this.dispatchEvent(new Event(outcome.fail))
		this.dispatchEvent(new Event("loadend"))
	}
}

const exporter = new InMemorySpanExporter()
let unpatch: (() => void) | undefined

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout"] })
	vi.stubGlobal("XMLHttpRequest", FakeXhr)
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
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

/** The span end event and status code each outcome should leave. */
const expected = (outcome: Outcome): { event: string; status: unknown } => {
	if (outcome === "reopenedMidFlight") return { event: "abort", status: undefined }
	if ("fail" in outcome) return { event: outcome.fail, status: undefined }
	return { event: outcome.respond < 299 ? "loaded" : "error", status: outcome.respond }
}

const outcome: fc.Arbitrary<Outcome> = fc.oneof(
	fc.constantFrom(200, 204, 404, 503).map((respond) => ({ respond })),
	fc.constantFrom<Failure>("error", "timeout", "abort").map((fail) => ({ fail })),
	fc.constant<Outcome>("reopenedMidFlight"),
)
const reuse = fc.constantFrom<Reuse>("afterLoadend", "fromReadyStateChange")

/** Run each request on one xhr; the next one opens where `reuse` says. */
function run(requests: ReadonlyArray<{ readonly outcome: Outcome; readonly reuse: Reuse }>): void {
	const xhr = new FakeXhr()
	// The instrumentation patched FakeXhr's prototype, so these go through it.
	const begin = (index: number): void => {
		xhr.open("GET", `https://api.test/r${index}`)
		xhr.send()
	}
	begin(0)
	requests.forEach((request, index) => {
		const next = index + 1 < requests.length ? () => begin(index + 1) : undefined
		if (request.outcome === "reopenedMidFlight") return next?.()
		if (next && request.reuse === "fromReadyStateChange") {
			const onDone = (): void => {
				if (xhr.readyState !== 4) return
				xhr.removeEventListener("readystatechange", onDone)
				next()
			}
			xhr.addEventListener("readystatechange", onDone)
			xhr.finish(request.outcome)
		} else {
			xhr.finish(request.outcome)
			next?.()
		}
	})
}

describe("instrumentXhr on one reused XMLHttpRequest", () => {
	it("spans every request once, with its own outcome, whatever the reuse order", () => {
		const request = fc.record({ outcome, reuse })
		// The last request settles on its own: one reopened mid-flight needs a next `open()` to end.
		const last = fc.record({ outcome: outcome.filter((value) => value !== "reopenedMidFlight"), reuse })
		fc.assert(
			fc.property(fc.array(request, { maxLength: 6 }), last, (head, tail) => {
				exporter.reset()
				const requests = [...head, tail]
				run(requests)
				vi.runAllTimers()

				const spans = exporter.getFinishedSpans()
				const byUrl = new Map(spans.map((span) => [span.attributes["url.full"], span]))
				expect(spans).toHaveLength(requests.length)
				requests.forEach((entry, index) => {
					const span = byUrl.get(`https://api.test/r${index}`)
					expect({
						event: span?.events.at(-1)?.name,
						status: span?.attributes["http.response.status_code"],
					}).toEqual(expected(entry.outcome))
				})
			}),
			{ numRuns: 200 },
		)
	})
})
