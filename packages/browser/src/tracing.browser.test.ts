// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import {
	diag,
	DiagLogLevel,
	INVALID_SPAN_CONTEXT,
	type Span as ApiSpan,
	trace,
	type Tracer,
	type TracerProvider,
} from "@opentelemetry/api"
import type { ReadableSpan, Span } from "@opentelemetry/sdk-trace-base"
import { afterEach, describe, expect, it, vi } from "vitest"

// Capture what the batch processor actually hands to the exporter, so the
// unload flush can be asserted on exported spans rather than on a spy.
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

const { setupTracing, TraceIdCollector } = await import("./tracing")

const CONFIG = {
	ingestKey: "k",
	serviceName: "web",
	endpoint: "https://ingest.test",
	serviceNamespace: undefined,
	serviceVersion: undefined,
	environment: undefined,
	identity: undefined,
	tracingEnabled: true,
	tracingInstrumentFetch: false,
	tracingCaptureErrors: false,
	replayEnabled: false,
	replaySampleRate: 0,
	replayOnErrorSampleRate: 0,
	canvasFps: undefined,
	networkBodies: undefined,
	captureHeaders: { request: [], response: [] },
	longFrames: false,
	slowInteractions: false,
	maskAllInputs: true,
	maskAllText: false,
	persistVisitorId: true,
	crossSubdomainCookie: true,
	cookieDomain: undefined,
	requireConsent: false,
	captureUserEmail: true,
	respectDoNotTrack: false,
	propagateTraceHeaderCorsUrls: [],
	tracingSampleRate: 1,
	tracingInstrumentXhr: false,
	errorFilters: {},
	webVitals: false,
	breadcrumbs: false,
	captureConsole: [],
	reportCsp: false,
	reportBrowser: false,
	offlineQueue: false,
	sanitizeUrl: undefined,
}

function makeSpan() {
	const attributes = new Map<string, unknown>()
	const span = {
		spanContext: () => ({ traceId: "0123456789abcdef0123456789abcdef" }),
		get attributes() {
			return Object.fromEntries(attributes)
		},
		setAttribute: (key: string, value: unknown) => {
			attributes.set(key, value)
			return span
		},
	} as Span
	return { attributes, span }
}

describe("TraceIdCollector", () => {
	it("redacts credential-shaped parameters in URL attributes", () => {
		const { attributes, span } = makeSpan()
		span.setAttribute("url.full", "https://app.test/reset?token=secret&tab=2")
		new TraceIdCollector().onStart(span)
		expect(attributes.get("url.full")).toBe("https://app.test/reset?token=REDACTED&tab=2")
	})

	it("stamps future spans with the current identified user", () => {
		const state: { userId: string | undefined } = { userId: undefined } satisfies {
			userId: string | undefined
		}
		const collector = new TraceIdCollector(() => state.userId)

		const anonymous = makeSpan()
		collector.onStart(anonymous.span)
		expect(anonymous.attributes.get("user.id")).toBeUndefined()

		state.userId = "user_123"
		const identified = makeSpan()
		collector.onStart(identified.span)
		expect(identified.attributes.get("user.id")).toBe("user_123")

		state.userId = undefined
		const cleared = makeSpan()
		collector.onStart(cleared.span)
		expect(cleared.attributes.get("user.id")).toBeUndefined()
	})
})

describe("setupTracing unload flush", () => {
	let shutdown: (() => Promise<void>) | undefined

	afterEach(async () => {
		vi.useRealTimers()
		vi.restoreAllMocks()
		diag.disable()
		await shutdown?.()
		shutdown = undefined
		exported.length = 0
		trace.disable()
	})

	const endOneSpan = (): void => {
		trace.getTracer("test").startSpan("click").end()
	}

	it("exports queued spans on pagehide instead of losing them with the tab", async () => {
		shutdown = setupTracing(CONFIG)
		endOneSpan()
		// The batch processor would otherwise sit on this span until its timer
		// fires — a timer the closing tab never reaches.
		expect(exported).toHaveLength(0)

		window.dispatchEvent(new Event("pagehide"))
		await vi.waitFor(() => expect(exported).toHaveLength(1))
		expect(exported[0]?.name).toBe("click")
	})

	it("exports queued spans when the page is hidden, which is the mobile signal", async () => {
		shutdown = setupTracing(CONFIG)
		endOneSpan()

		vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
		document.dispatchEvent(new Event("visibilitychange"))
		await vi.waitFor(() => expect(exported).toHaveLength(1))
	})

	it("ignores a visibilitychange back to visible", async () => {
		shutdown = setupTracing(CONFIG)
		endOneSpan()

		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
		document.dispatchEvent(new Event("visibilitychange"))
		await Promise.resolve()
		expect(exported).toHaveLength(0)
	})

	it("exports spans again after init → shutdown → init, without a manual trace.disable", async () => {
		// The global OTel registration is first-write-wins: unless shutdown
		// releases it, the proxy keeps delegating to the shut-down provider and a
		// second SDK session silently exports nothing.
		const first = setupTracing(CONFIG)
		endOneSpan()
		window.dispatchEvent(new Event("pagehide"))
		await vi.waitFor(() => expect(exported).toHaveLength(1))
		await first()

		shutdown = setupTracing(CONFIG)
		endOneSpan()
		window.dispatchEvent(new Event("pagehide"))
		await vi.waitFor(() => expect(exported).toHaveLength(2))
	})

	it("leaves a host app's earlier provider registration alone on shutdown", async () => {
		// A host that registered its own provider owns the globals; losing them
		// (trace.disable) would break the host's tracing, not just ours.
		const hostSpan: ApiSpan = trace.wrapSpanContext(INVALID_SPAN_CONTEXT)
		const hostTracer: Tracer = {
			startSpan: vi.fn(() => hostSpan),
			startActiveSpan: vi.fn(),
		}
		const hostProvider: TracerProvider = { getTracer: () => hostTracer }
		trace.setGlobalTracerProvider(hostProvider)

		const teardown = setupTracing(CONFIG)
		await teardown()

		expect(trace.getTracer("host").startSpan("still-host")).toBeDefined()
		expect(hostTracer.startSpan).toHaveBeenCalledWith("still-host")
	})

	it("exports a fetch span that settled just before pagehide", async () => {
		// The fetch instrumentation ends its span 300ms after the response; a
		// navigation inside that window used to flush before the span existed.
		vi.useFakeTimers({ toFake: ["setTimeout"] })
		// `vi.waitFor` advances fake timers by its interval on every poll; 0 keeps
		// the instrumentation's 300ms timer parked until this test runs it.
		const poll = { interval: 0 }
		shutdown = setupTracing({ ...CONFIG, tracingInstrumentFetch: true })
		const url = URL.createObjectURL(new Blob(["ok"]))

		await (await fetch(url)).text()
		// The instrumentation has settled the response and parked the span's end.
		await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1), poll)

		window.dispatchEvent(new Event("pagehide"))
		await vi.waitFor(() => expect(exported).toHaveLength(1), poll)
		expect(exported[0]?.attributes["url.full"]).toBe(url)
		URL.revokeObjectURL(url)
	})

	it("spans an XMLHttpRequest and ends it on pagehide like a fetch", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] })
		const poll = { interval: 0 }
		shutdown = setupTracing({ ...CONFIG, tracingInstrumentXhr: true })
		const url = URL.createObjectURL(new Blob(["ok"]))

		const xhr = new XMLHttpRequest()
		xhr.open("GET", url)
		await new Promise<void>((resolve) => {
			xhr.addEventListener("loadend", () => resolve())
			xhr.send()
		})
		await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0), poll)

		window.dispatchEvent(new Event("pagehide"))
		await vi.waitFor(() => expect(exported).toHaveLength(1), poll)
		expect(exported[0]?.attributes["url.full"] ?? exported[0]?.attributes["http.url"]).toBe(url)
		URL.revokeObjectURL(url)
	})

	it("records allowlisted headers as semconv attributes, never credentials", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] })
		const poll = { interval: 0 }
		shutdown = setupTracing({
			...CONFIG,
			tracingInstrumentFetch: true,
			captureHeaders: { request: ["x-request-id"], response: ["content-type"] },
		})
		const url = URL.createObjectURL(new Blob(["ok"], { type: "text/plain" }))

		await (
			await fetch(url, { headers: { "x-request-id": "req-1", authorization: "Bearer secret" } })
		).text()
		await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1), poll)
		window.dispatchEvent(new Event("pagehide"))
		await vi.waitFor(() => expect(exported).toHaveLength(1), poll)

		const attributes = exported[0]?.attributes ?? {}
		expect(attributes["http.request.header.x-request-id"]).toEqual(["req-1"])
		expect(attributes["http.response.header.content-type"]).toEqual(["text/plain"])
		expect(Object.keys(attributes).some((key) => key.includes("authorization"))).toBe(false)
		URL.revokeObjectURL(url)
	})

	it("marks a fetch that never got a response as an error", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] })
		const poll = { interval: 0 }
		shutdown = setupTracing({ ...CONFIG, tracingInstrumentFetch: true })
		const url = URL.createObjectURL(new Blob(["gone"]))
		URL.revokeObjectURL(url)

		await expect(fetch(url)).rejects.toThrow(TypeError)
		await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1), poll)
		window.dispatchEvent(new Event("pagehide"))
		await vi.waitFor(() => expect(exported).toHaveLength(1), poll)

		expect(exported[0]?.status.code).toBe(2)
		expect(exported[0]?.attributes["error.type"]).toBe("TypeError")
		expect(exported[0]?.attributes["error.message"]).toBe(`GET ${url} -> TypeError`)
	})

	it("does not count a fetch aborted with a custom reason as a network failure", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] })
		const poll = { interval: 0 }
		shutdown = setupTracing({ ...CONFIG, tracingInstrumentFetch: true })
		const url = URL.createObjectURL(new Blob(["ok"]))
		const controller = new AbortController()
		controller.abort(new Error("unmounted"))

		await expect(fetch(url, { signal: controller.signal })).rejects.toThrow("unmounted")
		await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1), poll)
		window.dispatchEvent(new Event("pagehide"))
		await vi.waitFor(() => expect(exported).toHaveLength(1), poll)

		expect(exported[0]?.status.code).toBe(0)
		expect(exported[0]?.attributes["error.type"]).toBeUndefined()
		URL.revokeObjectURL(url)
	})

	it("does not end a fetch span the instrumentation already ended", async () => {
		const errors: string[] = []
		const noop = (): void => {}
		diag.setLogger(
			{ error: (message) => errors.push(message), warn: noop, info: noop, debug: noop, verbose: noop },
			DiagLogLevel.ERROR,
		)
		vi.useFakeTimers({ toFake: ["setTimeout"] })
		const poll = { interval: 0 }
		shutdown = setupTracing({ ...CONFIG, tracingInstrumentFetch: true })
		const url = URL.createObjectURL(new Blob(["ok"]))

		await (await fetch(url)).text()
		await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1), poll)
		// The instrumentation's timer ends the span; no later fetch prunes it.
		vi.runAllTimers()

		window.dispatchEvent(new Event("pagehide"))
		await vi.waitFor(() => expect(exported).toHaveLength(1), poll)
		expect(errors).toEqual([])
		URL.revokeObjectURL(url)
	})

	it("leaves a settled fetch span to the instrumentation when the page is only hidden", async () => {
		// A hidden page (tab switch) lives on: ending the span early would leave
		// the instrumentation's timer writing to an ended span.
		vi.useFakeTimers({ toFake: ["setTimeout"] })
		const poll = { interval: 0 }
		shutdown = setupTracing({ ...CONFIG, tracingInstrumentFetch: true })
		const url = URL.createObjectURL(new Blob(["ok"]))

		await (await fetch(url)).text()
		await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1), poll)

		vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
		document.dispatchEvent(new Event("visibilitychange"))
		vi.useRealTimers()
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(exported).toHaveLength(0)
		URL.revokeObjectURL(url)
	})

	it("removes its listeners on shutdown", async () => {
		const teardown = setupTracing(CONFIG)
		await teardown()

		// A torn-down provider must not still be reachable from a page event.
		expect(() => window.dispatchEvent(new Event("pagehide"))).not.toThrow()
		expect(exported).toHaveLength(0)
	})
})
