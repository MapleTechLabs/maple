// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import { resetConsentForTests, scrubUrl, setConsent } from "@maple/browser-session"
import {
	context,
	INVALID_SPAN_CONTEXT,
	type Span as ApiSpan,
	SpanStatusCode,
	trace,
	type Tracer,
	type TracerProvider,
} from "@opentelemetry/api"
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetUrlSanitizersForTests } from "../../browser-session/src/platform/url-privacy"

// What the batch processor hands to the exporter, so assertions are on the
// spans that would actually leave the page.
const exported: ReadableSpan[] = []
vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
	OTLPTraceExporter: class {
		export(spans: ReadableSpan[], callback: (result: { code: number }) => void): void {
			exported.push(...spans)
			callback({ code: 0 })
		}
		forceFlush(): Promise<void> {
			return Promise.resolve()
		}
		shutdown(): Promise<void> {
			return Promise.resolve()
		}
	},
}))

const { MapleBrowser } = await import("./index")
const { resetReportedErrorsForTests } = await import("./errors")
const { resetNavigationForTests } = await import("./navigation")

type InitConfig = Parameters<typeof MapleBrowser.init>[0]

const BASE: InitConfig = {
	ingestKey: "k",
	serviceName: "web",
	endpoint: "https://ingest.test",
	replay: { enabled: false },
}

const SERVER_TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
const SERVER_SPAN_ID = "b7ad6b7169203331"
const SERVER_TRACEPARENT = `00-${SERVER_TRACE_ID}-${SERVER_SPAN_ID}-01`

let handle: ReturnType<typeof MapleBrowser.init> | undefined

const start = (config: Partial<InitConfig> = {}) => {
	handle = MapleBrowser.init({ ...BASE, ...config })
	return handle
}

/** Shut down, which exports everything the batch processor holds. */
const stop = async (): Promise<void> => {
	await handle?.shutdown()
	handle = undefined
}

/** Document timing spans (`documentFetch`, `dns`, ...) are covered by their own tests. */
const TIMING_SPANS = new Set([
	"documentFetch",
	"dns",
	"connect",
	"request",
	"response",
	"domProcessing",
	"loadEvent",
])
const spanNames = () => exported.filter((span) => !TIMING_SPANS.has(span.name)).map((span) => span.name)

const named = (name: string): ReadableSpan => {
	const span = exported.find((candidate) => candidate.name === name)
	if (!span) throw new Error(`no exported span named ${name}: ${exported.map((s) => s.name).join(", ")}`)
	return span
}

const exceptionEvents = (span: ReadableSpan) => span.events.filter((event) => event.name === "exception")
const allExceptionEvents = () => exported.flatMap(exceptionEvents)
const parentOf = (span: ReadableSpan) => span.parentSpanContext?.spanId
const fetchSpans = (url: string) => exported.filter((span) => span.attributes["url.full"] === url)

/** A document navigation entry whose response carried `Server-Timing: traceparent;desc="…"`. */
const stubServerTiming = (description: string): void => {
	const entry: PerformanceNavigationTiming = Object.create(PerformanceNavigationTiming.prototype, {
		serverTiming: { value: [{ name: "traceparent", description, duration: 0 }] },
	})
	vi.spyOn(performance, "getEntriesByType").mockReturnValue([entry])
}

const setMeta = (content: string): HTMLMetaElement => {
	const meta = document.createElement("meta")
	meta.name = "traceparent"
	meta.content = content
	document.head.append(meta)
	return meta
}

beforeEach(() => {
	// Stands in for the API and for ingest's session endpoints. Installed before
	// `init`, so the fetch instrumentation wraps it like it would the real fetch.
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("{}")),
	)
})

afterEach(async () => {
	await stop()
	exported.length = 0
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	resetConsentForTests()
	resetReportedErrorsForTests()
	resetUrlSanitizersForTests()
	// Each test is a fresh document: a test that navigates consumes its page load
	resetNavigationForTests()
	MapleBrowser.identify(undefined)
	for (const meta of document.querySelectorAll('meta[name="traceparent"]')) meta.remove()
	trace.disable()
	context.disable()
})

describe("startNavigation / endNavigation", () => {
	it("opens a pageload span first, then navigate spans, renamed to the route on end", async () => {
		start()
		MapleBrowser.startNavigation("/projects/8f2a")
		MapleBrowser.endNavigation("/projects/:id")
		MapleBrowser.startNavigation("/settings")
		MapleBrowser.endNavigation("/settings")
		await stop()

		expect(spanNames()).toEqual(["pageload /projects/:id", "navigate /settings"])
		expect(named("pageload /projects/:id").attributes["url.path"]).toBe("/projects/8f2a")
		expect(named("navigate /settings").attributes["url.path"]).toBe("/settings")
		expect(named("navigate /settings").attributes["app.navigation.interrupted"]).toBeUndefined()
	})

	it("keeps the generic name when ended without a route", async () => {
		start()
		MapleBrowser.startNavigation("/a")
		MapleBrowser.endNavigation()
		await stop()

		expect(spanNames()).toEqual(["pageload"])
	})

	it("does nothing when no navigation is open", async () => {
		start()
		expect(() => MapleBrowser.endNavigation("/a")).not.toThrow()
		MapleBrowser.startNavigation("/a")
		MapleBrowser.endNavigation("/a")
		// Already ended: a second end must not rename or re-end it
		MapleBrowser.endNavigation("/b")
		await stop()

		expect(spanNames()).toEqual(["pageload /a"])
	})

	it("ends a navigation still open when the next starts, as interrupted", async () => {
		start()
		MapleBrowser.startNavigation("/a")
		MapleBrowser.endNavigation("/a")
		MapleBrowser.startNavigation("/slow")
		MapleBrowser.startNavigation("/fast")
		MapleBrowser.endNavigation("/fast")
		await stop()

		expect(spanNames()).toEqual(["pageload /a", "navigate", "navigate /fast"])
		expect(named("navigate").attributes["app.navigation.interrupted"]).toBe(true)
		expect(named("navigate").attributes["url.path"]).toBe("/slow")
		expect(named("navigate /fast").attributes["app.navigation.interrupted"]).toBeUndefined()
	})

	it("redacts credentials in the path like any other URL attribute", async () => {
		start({ privacy: { sanitizeUrl: (url) => url.replace(/\/reset\/[^/?]+/, "/reset/:token") } })
		MapleBrowser.startNavigation("/reset/s3cret?token=abc")
		MapleBrowser.endNavigation("/reset/:token")
		await stop()

		expect(named("pageload /reset/:token").attributes["url.path"]).toBe("/reset/:token?token=REDACTED")
	})

	it("redacts a concrete URL passed as the route", async () => {
		start()
		MapleBrowser.startNavigation("/a")
		MapleBrowser.endNavigation("/login?token=abc")
		await stop()

		expect(spanNames()).toEqual(["pageload /login?token=REDACTED"])
	})

	it("ends and exports a navigation still open when the page is left", async () => {
		start()
		MapleBrowser.startNavigation("/checkout")
		window.dispatchEvent(new Event("pagehide"))

		// Exported by the page-exit flush itself, not by shutdown
		await vi.waitFor(() => expect(spanNames()).toEqual(["pageload"]))
		expect(named("pageload").attributes["app.navigation.interrupted"]).toBe(true)
		expect(() => MapleBrowser.endNavigation("/checkout")).not.toThrow()
		await stop()
		expect(spanNames()).toEqual(["pageload"])
	})

	it("stamps session.id and user.id like every other span", async () => {
		MapleBrowser.identify("user_1")
		const { sessionId } = start()
		MapleBrowser.startNavigation("/a")
		await MapleBrowser.traced("loader /a", async () => undefined)
		MapleBrowser.endNavigation("/a")
		await stop()

		expect(sessionId).not.toBe("")
		for (const name of ["pageload /a", "loader /a"]) {
			expect(named(name).attributes["session.id"]).toBe(sessionId)
			expect(named(name).attributes["user.id"]).toBe("user_1")
		}
	})
})

describe("pageload parent", () => {
	it("joins the server render from a <meta name=traceparent>", async () => {
		setMeta(SERVER_TRACEPARENT)
		start()
		MapleBrowser.startNavigation("/a")
		MapleBrowser.endNavigation("/a")
		MapleBrowser.startNavigation("/b")
		MapleBrowser.endNavigation("/b")
		await stop()

		const pageload = named("pageload /a")
		expect(pageload.spanContext().traceId).toBe(SERVER_TRACE_ID)
		expect(parentOf(pageload)).toBe(SERVER_SPAN_ID)
		// Only the page load belongs to the server's trace
		const navigate = named("navigate /b")
		expect(navigate.spanContext().traceId).not.toBe(SERVER_TRACE_ID)
		expect(parentOf(navigate)).toBeUndefined()
	})

	it("prefers the Server-Timing entry over the meta tag", async () => {
		const headerTrace = "11111111111111111111111111111111"
		stubServerTiming(`00-${headerTrace}-2222222222222222-01`)
		setMeta(SERVER_TRACEPARENT)
		start()
		MapleBrowser.startNavigation("/a")
		MapleBrowser.endNavigation("/a")
		await stop()

		expect(named("pageload /a").spanContext().traceId).toBe(headerTrace)
		expect(parentOf(named("pageload /a"))).toBe("2222222222222222")
	})

	it("falls back to the meta tag when the Server-Timing entry has an all-zero trace id", async () => {
		stubServerTiming(`00-${"0".repeat(32)}-${SERVER_SPAN_ID}-01`)
		setMeta(SERVER_TRACEPARENT)
		start()
		MapleBrowser.startNavigation("/a")
		MapleBrowser.endNavigation("/a")
		await stop()

		expect(named("pageload /a").spanContext().traceId).toBe(SERVER_TRACE_ID)
	})

	it("falls back to the meta tag when the Server-Timing entry is malformed", async () => {
		stubServerTiming("not-a-traceparent")
		setMeta(SERVER_TRACEPARENT)
		start()
		MapleBrowser.startNavigation("/a")
		MapleBrowser.endNavigation("/a")
		await stop()

		expect(named("pageload /a").spanContext().traceId).toBe(SERVER_TRACE_ID)
	})

	it.each([
		["garbage", "garbage"],
		["an empty value", ""],
		["an all-zero trace id", `00-${"0".repeat(32)}-${SERVER_SPAN_ID}-01`],
		["an all-zero span id", `00-${SERVER_TRACE_ID}-${"0".repeat(16)}-01`],
		["version ff", `ff-${SERVER_TRACE_ID}-${SERVER_SPAN_ID}-01`],
		["version 00 with an extra field", `${SERVER_TRACEPARENT}-extra`],
		["uppercase hex", `00-${SERVER_TRACE_ID.toUpperCase()}-${SERVER_SPAN_ID}-01`],
		["a short trace id", `00-${SERVER_TRACE_ID.slice(1)}-${SERVER_SPAN_ID}-01`],
	])("ignores a traceparent with %s and starts its own trace", async (_label, value) => {
		setMeta(value)
		start()
		expect(() => MapleBrowser.startNavigation("/a")).not.toThrow()
		MapleBrowser.endNavigation("/a")
		await stop()

		const pageload = named("pageload /a")
		expect(parentOf(pageload)).toBeUndefined()
		expect(pageload.spanContext().traceId).not.toBe(SERVER_TRACE_ID)
	})

	it("accepts a future version with extra fields", async () => {
		setMeta(`01-${SERVER_TRACE_ID}-${SERVER_SPAN_ID}-01-future`)
		start()
		MapleBrowser.startNavigation("/a")
		MapleBrowser.endNavigation("/a")
		await stop()

		expect(named("pageload /a").spanContext().traceId).toBe(SERVER_TRACE_ID)
	})
})

describe("traced", () => {
	it("returns fn's value unchanged", async () => {
		start()
		const value = { rows: [1, 2] }
		await expect(MapleBrowser.traced("loader", async () => value)).resolves.toBe(value)
		await stop()

		expect(named("loader").status.code).toBe(SpanStatusCode.UNSET)
	})

	it("nests under the open navigation", async () => {
		start()
		MapleBrowser.startNavigation("/a")
		MapleBrowser.endNavigation("/a")
		MapleBrowser.startNavigation("/projects/1")
		await MapleBrowser.traced("loader /projects/:id", async () => undefined)
		MapleBrowser.endNavigation("/projects/:id")
		await stop()

		const navigate = named("navigate /projects/:id")
		const loader = named("loader /projects/:id")
		expect(loader.spanContext().traceId).toBe(navigate.spanContext().traceId)
		expect(parentOf(loader)).toBe(navigate.spanContext().spanId)
	})

	it("nests a traced call inside another under that one, not the navigation", async () => {
		start()
		MapleBrowser.startNavigation("/a")
		await MapleBrowser.traced("outer", () => MapleBrowser.traced("inner", async () => undefined))
		// Started after outer's first await: outer is no longer active
		await MapleBrowser.traced("later", async () => undefined)
		MapleBrowser.endNavigation("/a")
		await stop()

		const pageload = named("pageload /a").spanContext().spanId
		expect(parentOf(named("outer"))).toBe(pageload)
		expect(parentOf(named("inner"))).toBe(named("outer").spanContext().spanId)
		expect(parentOf(named("later"))).toBe(pageload)
	})

	it("nests under the open navigation, not an unrelated active span", async () => {
		start()
		MapleBrowser.startNavigation("/a")
		const unrelated = trace.getTracer("host").startSpan("host click")
		await context.with(trace.setSpan(context.active(), unrelated), () =>
			MapleBrowser.traced("loader /a", async () => undefined),
		)
		unrelated.end()
		MapleBrowser.endNavigation("/a")
		await stop()

		expect(parentOf(named("loader /a"))).toBe(named("pageload /a").spanContext().spanId)
	})

	it("nests under the active context when no navigation is open", async () => {
		start()
		await MapleBrowser.traced("outer", () => MapleBrowser.traced("inner", async () => undefined))
		await stop()

		expect(parentOf(named("inner"))).toBe(named("outer").spanContext().spanId)
		expect(parentOf(named("outer"))).toBeUndefined()
	})

	it("runs beforeCapture once for a loader failure in an unsampled session", async () => {
		let calls = 0
		start({
			tracing: { sampleRate: 0, instrumentFetch: false, instrumentXhr: false },
			errors: {
				beforeCapture: () => {
					calls++
					return true
				},
			},
		})
		await expect(
			MapleBrowser.traced("loader", async () => {
				throw new Error("load failed")
			}),
		).rejects.toThrow("load failed")
		await stop()
		expect(calls).toBe(1)
	})

	it("parents fetches started before the first await, but not after it", async () => {
		start()
		MapleBrowser.startNavigation("/a")
		await MapleBrowser.traced("loader /a", async () => {
			await Promise.all([fetch("https://api.test/one"), fetch("https://api.test/two")])
			// The browser has no async context: this one is outside the span
			await fetch("https://api.test/after-await")
		})
		MapleBrowser.endNavigation("/a")

		// The fetch instrumentation ends its spans up to 300ms after the response
		await vi.waitFor(
			() => {
				window.dispatchEvent(new Event("pagehide"))
				expect(fetchSpans("https://api.test/after-await")).toHaveLength(1)
				expect(fetchSpans("https://api.test/two")).toHaveLength(1)
			},
			{ timeout: 3_000, interval: 50 },
		)
		await stop()

		const loader = named("loader /a")
		for (const url of ["https://api.test/one", "https://api.test/two"]) {
			const [span] = fetchSpans(url)
			expect(parentOf(span!)).toBe(loader.spanContext().spanId)
		}
		const [after] = fetchSpans("https://api.test/after-await")
		expect(parentOf(after!)).toBeUndefined()
		expect(after!.spanContext().traceId).not.toBe(loader.spanContext().traceId)
	})

	it("records a throw, marks the span Error and rethrows the same error", async () => {
		start()
		const error = new TypeError("project not found")
		await expect(
			MapleBrowser.traced("loader", async () => {
				throw error
			}),
		).rejects.toBe(error)
		await stop()

		const loader = named("loader")
		expect(loader.status.code).toBe(SpanStatusCode.ERROR)
		const [event] = exceptionEvents(loader)
		expect(event?.attributes?.["exception.type"]).toBe("TypeError")
		expect(event?.attributes?.["exception.message"]).toBe("project not found")
		expect(loader.ended).toBe(true)
	})

	it("turns a synchronous throw into a rejection with the same error", async () => {
		start()
		const error = new Error("sync")
		// Not an async function: the throw happens synchronously, inside `traced`
		const fn = (): Promise<never> => {
			throw error
		}
		await expect(MapleBrowser.traced("loader", fn)).rejects.toBe(error)
		await stop()

		expect(exceptionEvents(named("loader"))).toHaveLength(1)
	})

	it("records an error-like object by its message and rethrows it unchanged", async () => {
		start()
		const thrown = { message: "Request failed with status 500", status: 500 }
		await expect(
			MapleBrowser.traced("loader", async () => {
				throw thrown
			}),
		).rejects.toBe(thrown)
		await expect(
			MapleBrowser.traced("loader-string", async () => {
				throw "plain string"
			}),
		).rejects.toBe("plain string")
		await stop()

		expect(exceptionEvents(named("loader"))[0]?.attributes?.["exception.message"]).toBe(
			"Request failed with status 500",
		)
		expect(exceptionEvents(named("loader-string"))[0]?.attributes?.["exception.message"]).toBe(
			"plain string",
		)
	})

	it("leaves the span Ok and the error unclaimed when isFailure returns false", async () => {
		start()
		const redirect = new Error("redirect")
		const isFailure = vi.fn((error: unknown) => error !== redirect)
		await expect(
			MapleBrowser.traced(
				"loader",
				async () => {
					throw redirect
				},
				{ isFailure },
			),
		).rejects.toBe(redirect)
		// Not claimed: the app can still report it
		MapleBrowser.captureException(redirect)
		await stop()

		expect(isFailure).toHaveBeenCalledWith(redirect)
		const loader = named("loader")
		expect(loader.status.code).toBe(SpanStatusCode.UNSET)
		expect(exceptionEvents(loader)).toHaveLength(0)
		expect(exceptionEvents(named("exception"))).toHaveLength(1)
	})

	it("rethrows the original error when isFailure itself throws", async () => {
		start()
		const error = new Error("loader failed")
		await expect(
			MapleBrowser.traced(
				"loader",
				async () => {
					throw error
				},
				{
					isFailure: () => {
						throw new Error("broken predicate")
					},
				},
			),
		).rejects.toBe(error)
		await stop()

		expect(named("loader").status.code).toBe(SpanStatusCode.ERROR)
		expect(exceptionEvents(named("loader"))[0]?.attributes?.["exception.message"]).toBe("loader failed")
	})
})

describe("error dedupe", () => {
	const dispatchRejection = (reason: unknown) =>
		window.dispatchEvent(
			Object.assign(new Event("unhandledrejection"), { reason, promise: Promise.resolve() }),
		)

	it("records a loader error once when a boundary reports it and it also goes unhandled", async () => {
		start()
		MapleBrowser.startNavigation("/a")
		const error = new Error("loader failed")
		await expect(
			MapleBrowser.traced("loader /a", async () => {
				throw error
			}),
		).rejects.toBe(error)
		// The framework's error boundary reports what it caught...
		MapleBrowser.captureException(error, { name: "react.render_error" })
		// ...and the same error also reaches the global handlers
		dispatchRejection(error)
		window.dispatchEvent(new ErrorEvent("error", { error, message: error.message }))
		MapleBrowser.endNavigation("/a")
		await stop()

		expect(allExceptionEvents()).toHaveLength(1)
		expect(exceptionEvents(named("loader /a"))).toHaveLength(1)
		expect(spanNames()).not.toContain("react.render_error")
		expect(spanNames()).not.toContain("browser.unhandled_rejection")
		expect(spanNames()).not.toContain("browser.uncaught_error")
	})

	it("puts the exception event on the innermost span only when traced calls nest", async () => {
		start()
		const error = new Error("inner failed")
		await expect(
			MapleBrowser.traced("outer", () =>
				MapleBrowser.traced("inner", async () => {
					throw error
				}),
			),
		).rejects.toBe(error)
		await stop()

		expect(exceptionEvents(named("inner"))).toHaveLength(1)
		expect(exceptionEvents(named("outer"))).toHaveLength(0)
		expect(named("outer").status.code).toBe(SpanStatusCode.ERROR)
	})

	it("does not claim an error thrown before init, so it is still reported later", async () => {
		const error = new Error("early")
		await expect(
			MapleBrowser.traced("loader", async () => {
				throw error
			}),
		).rejects.toBe(error)
		start()
		MapleBrowser.captureException(error)
		await stop()

		expect(spanNames()).toEqual(["exception"])
	})
})

describe("without live tracing", () => {
	const exercise = async () => {
		MapleBrowser.startNavigation("/a")
		const value = await MapleBrowser.traced("loader", async () => 42)
		const error = new Error("fails")
		await expect(
			MapleBrowser.traced("loader", async () => {
				throw error
			}),
		).rejects.toBe(error)
		MapleBrowser.endNavigation("/a")
		return value
	}

	it("is a no-op before init, and traced still runs fn", async () => {
		expect(await exercise()).toBe(42)
		start()
		await stop()
		expect(exported).toHaveLength(0)
	})

	it("does not treat the first navigation after init as the page load when the page load came before it", async () => {
		MapleBrowser.startNavigation("/a")
		start()
		MapleBrowser.startNavigation("/b")
		MapleBrowser.endNavigation("/b")
		await stop()

		expect(spanNames()).toEqual(["navigate /b"])
	})

	it("is a no-op with tracing disabled", async () => {
		start({ tracing: { enabled: false } })
		expect(await exercise()).toBe(42)
		await stop()
		expect(exported).toHaveLength(0)
	})

	it("spans nothing until consent is granted", async () => {
		setMeta(SERVER_TRACEPARENT)
		start({ privacy: { requireConsent: true } })
		expect(await exercise()).toBe(42)

		MapleBrowser.setConsent(true)
		// Export keeps spans that start at or after the grant's `Date.now()`;
		// span clocks run on `performance.now()`, which can trail it slightly
		await new Promise((resolve) => setTimeout(resolve, 20))
		MapleBrowser.startNavigation("/b")
		await MapleBrowser.traced("loader /b", async () => undefined)
		MapleBrowser.endNavigation("/b")
		await stop()

		// The page load came before consent: the first traced navigation is a
		// click, not the page load, and does not join the server render's trace
		expect(spanNames()).toEqual(["loader /b", "navigate /b"])
		expect(named("navigate /b").spanContext().traceId).not.toBe(SERVER_TRACE_ID)
	})

	it("spans and claims nothing while consent is revoked", async () => {
		start({ privacy: { requireConsent: true } })
		MapleBrowser.setConsent(true)
		MapleBrowser.setConsent(false)
		const error = new Error("while revoked")
		await expect(
			MapleBrowser.traced("loader", async () => {
				throw error
			}),
		).rejects.toBe(error)

		MapleBrowser.setConsent(true)
		await new Promise((resolve) => setTimeout(resolve, 20))
		// Nothing was exported for it, so it is still reportable
		MapleBrowser.captureException(error)
		await stop()

		expect(spanNames()).toEqual(["exception"])
	})

	it("is a no-op after shutdown", async () => {
		start()
		await stop()
		expect(await exercise()).toBe(42)
		expect(exported).toHaveLength(0)
	})
})

describe("shutdown", () => {
	it("ends the open navigation so it exports, and a re-init starts with a page load", async () => {
		setMeta(SERVER_TRACEPARENT)
		start()
		MapleBrowser.startNavigation("/a")
		await stop()

		expect(spanNames()).toEqual(["pageload"])
		expect(named("pageload").attributes["app.navigation.interrupted"]).toBe(true)
		// Ended and cleared: nothing left to end
		expect(() => MapleBrowser.endNavigation("/a")).not.toThrow()

		exported.length = 0
		start()
		MapleBrowser.startNavigation("/b")
		MapleBrowser.endNavigation("/b")
		await stop()
		expect(spanNames()).toEqual(["pageload /b"])
		// Long past the server render: only the document's own page load joins it
		expect(parentOf(named("pageload /b"))).toBeUndefined()
		expect(named("pageload /b").spanContext().traceId).not.toBe(SERVER_TRACE_ID)
	})
})

describe("host-owned global provider", () => {
	it("spans through Maple's provider and still parents loaders to the navigation", async () => {
		const hostSpan: ApiSpan = trace.wrapSpanContext(INVALID_SPAN_CONTEXT)
		const startSpan = vi.fn(() => hostSpan)
		const startActiveSpan = vi.fn()
		const hostTracer: Tracer = { startSpan, startActiveSpan }
		const hostProvider: TracerProvider = { getTracer: () => hostTracer }
		trace.setGlobalTracerProvider(hostProvider)

		start()
		MapleBrowser.startNavigation("/a")
		await MapleBrowser.traced("loader /a", async () => "ok")
		MapleBrowser.endNavigation("/a")
		await stop()

		expect(startSpan).not.toHaveBeenCalled()
		expect(startActiveSpan).not.toHaveBeenCalled()
		expect(parentOf(named("loader /a"))).toBe(named("pageload /a").spanContext().spanId)
	})
})

/** The deferred chunk spans the document a task after it lands (the test page loaded long ago). */
const timingRecorded = async (): Promise<void> => {
	await import("./deferred")
	await new Promise((resolve) => setTimeout(resolve, 20))
}

describe("document timing", () => {
	it("starts the page load at navigation start and spans the document's load under it", async () => {
		start()
		MapleBrowser.startNavigation("/a")
		MapleBrowser.endNavigation("/a")
		await timingRecorded()
		await stop()

		const pageload = named("pageload /a")
		const fetch = named("documentFetch")
		const toMs = ([s, ns]: [number, number]) => s * 1_000 + ns / 1_000_000
		expect(toMs(pageload.startTime)).toBeCloseTo(performance.timeOrigin, 0)
		expect(parentOf(fetch)).toBe(pageload.spanContext().spanId)
		expect(fetch.attributes["url.full"]).toBe(scrubUrl(location.href))
		const response = named("response")
		expect(parentOf(response)).toBe(fetch.spanContext().spanId)
		const [entry] = performance.getEntriesByType("navigation")
		if (!(entry instanceof PerformanceNavigationTiming)) throw new Error("no navigation entry")
		expect(toMs(response.endTime)).toBeCloseTo(performance.timeOrigin + entry.responseEnd, 0)
		expect(parentOf(named("domProcessing"))).toBe(pageload.spanContext().spanId)
	})

	it("starts the page load at the consent grant when consent came later, so it still exports", async () => {
		start({ privacy: { requireConsent: true } })
		setConsent(true)
		MapleBrowser.startNavigation("/a")
		MapleBrowser.endNavigation("/a")
		await stop()
		expect(spanNames()).toContain("pageload /a")
	})

	it("does not span the document again for a navigate", async () => {
		start()
		MapleBrowser.startNavigation("/a")
		MapleBrowser.endNavigation("/a")
		await timingRecorded()
		MapleBrowser.startNavigation("/b")
		MapleBrowser.endNavigation("/b")
		await stop()
		expect(exported.filter((span) => span.name === "documentFetch")).toHaveLength(1)
	})
})
