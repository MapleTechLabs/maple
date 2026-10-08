// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
import { describe, it } from "@effect/vitest"
import {
	OTLP_KEEPALIVE_BYTES,
	OTLP_UNLOAD_TAIL_BYTES,
	postToIngest,
	resetConsentForTests,
	setConsent,
} from "@maple/browser-session"
import { Effect, Metric } from "effect"
import { afterEach, expect, vi } from "vitest"
import { make } from "./flushable.js"

interface FetchCall {
	readonly url: string
	readonly headers: Record<string, string>
	readonly body: unknown
	readonly keepalive: boolean | undefined
	readonly bytes: number
}

const setupFetch = (
	responder: (url: string, init?: RequestInit) => Response | Promise<Response> = () =>
		new Response(null, { status: 200 }),
) => {
	const calls: Array<FetchCall> = []
	const original = globalThis.fetch
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		const headers: Record<string, string> = {}
		const initHeaders = init?.headers
		if (initHeaders instanceof Headers) {
			initHeaders.forEach((v, k) => (headers[k] = v))
		} else if (Array.isArray(initHeaders)) {
			for (const [k, v] of initHeaders) headers[k] = v
		} else if (initHeaders) {
			Object.assign(headers, initHeaders)
		}
		const text = typeof init?.body === "string" ? init.body : ""
		calls.push({
			url,
			headers,
			body: text ? JSON.parse(text) : undefined,
			keepalive: init?.keepalive,
			bytes: new TextEncoder().encode(text).byteLength,
		})
		return responder(url, init)
	}) as typeof fetch
	return { calls, restore: () => void (globalThis.fetch = original) }
}

/** A responder whose requests stay in flight until the test settles them. */
const pendingResponses = () => {
	const pending: Array<{ resolve: (response: Response) => void; reject: (cause: unknown) => void }> = []
	return {
		responder: () => new Promise<Response>((resolve, reject) => pending.push({ resolve, reject })),
		resolveAll: () => pending.splice(0).forEach((p) => p.resolve(new Response(null, { status: 200 }))),
		rejectAll: () => pending.splice(0).forEach((p) => p.reject(new TypeError("Failed to fetch"))),
	}
}

const recordSpans = (telemetry: ReturnType<typeof make>, names: ReadonlyArray<string>) =>
	Effect.runPromise(
		Effect.forEach(names, (name) => Effect.succeed(undefined).pipe(Effect.withSpan(name)), {
			discard: true,
		}).pipe(Effect.provide(telemetry.layer)),
	)

const numbered = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}-${i}`)

const traceCalls = (calls: ReadonlyArray<FetchCall>) => calls.filter((c) => c.url.endsWith("/v1/traces"))

const spanNames = (calls: ReadonlyArray<FetchCall>): Array<string> =>
	traceCalls(calls).flatMap((c) =>
		(
			c.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string }> }> }> }
		).resourceSpans[0].scopeSpans[0].spans.map((span) => span.name),
	)

// Minimal DOM event shim — vitest runs in node, where globalThis isn't an
// EventTarget. Lets us drive `pagehide` / `visibilitychange` without jsdom.
const setupDom = () => {
	const listeners: Record<string, Set<EventListenerOrEventListenerObject>> = {}
	const g = globalThis as Record<string, unknown>
	const orig = {
		add: g.addEventListener,
		remove: g.removeEventListener,
		document: g.document,
	}
	g.addEventListener = (type: string, fn: EventListenerOrEventListenerObject) => {
		;(listeners[type] ??= new Set()).add(fn)
	}
	g.removeEventListener = (type: string, fn: EventListenerOrEventListenerObject) => {
		listeners[type]?.delete(fn)
	}
	const doc = { visibilityState: "visible" as "visible" | "hidden" }
	g.document = doc
	return {
		fire: (type: string) => {
			for (const fn of listeners[type] ?? []) (fn as () => void)()
		},
		// A browser runs a microtask checkpoint after each listener; `fire` does not.
		fireWithCheckpoints: async (type: string) => {
			for (const fn of listeners[type] ?? []) {
				;(fn as () => void)()
				for (let turn = 0; turn < 50; turn++) await Promise.resolve()
			}
		},
		listen: (type: string, fn: () => void) => void (listeners[type] ??= new Set()).add(fn),
		setHidden: () => {
			doc.visibilityState = "hidden"
		},
		listenerCount: (type: string) => listeners[type]?.size ?? 0,
		restore: () => {
			g.addEventListener = orig.add
			g.removeEventListener = orig.remove
			g.document = orig.document
		},
	}
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const baseConfig = {
	serviceName: "unit-test",
	endpoint: "https://collector.test",
	ingestKey: "secret",
	environment: "test",
	autoFlushInterval: false as const,
	flushOnUnload: false as const,
}

describe("MapleFlush.make (client)", () => {
	let restore: () => void

	afterEach(() => {
		restore?.()
		delete (globalThis as Record<string, unknown>)["__MAPLE_BROWSER_SESSION__"]
		// Tests that leave requests in flight would otherwise leak their reservation.
		delete (globalThis as Record<string, unknown>)["__MAPLE_KEEPALIVE_INFLIGHT__"]
		vi.restoreAllMocks()
		setConsent(false)
		resetConsentForTests()
		vi.useRealTimers()
	})

	it("POSTs to /v1/traces with keepalive + client resource attrs", async () => {
		const { calls, restore: r } = setupFetch()
		restore = r
		const telemetry = make(baseConfig)

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op-1"), Effect.provide(telemetry.layer)),
		)
		await telemetry.flush()

		const traceCall = calls.find((c) => c.url.endsWith("/v1/traces"))
		expect(traceCall).toBeDefined()
		expect(traceCall!.url).toBe("https://collector.test/v1/traces")
		expect(traceCall!.headers.authorization).toBe("Bearer secret")
		// Must use fetch(keepalive), not sendBeacon — see flushable.ts header.
		expect(traceCall!.keepalive).toBe(true)
		const body = traceCall!.body as {
			resourceSpans: Array<{
				resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> }
				scopeSpans: Array<{ spans: Array<{ name: string }> }>
			}>
		}
		expect(body.resourceSpans[0].scopeSpans[0].spans.map((s) => s.name)).toEqual(["op-1"])
		const attrs = body.resourceSpans[0].resource.attributes
		const attrMap = Object.fromEntries(attrs.map((a) => [a.key, a.value.stringValue]))
		expect(attrMap["service.name"]).toBe("unit-test")
		expect(attrMap["maple.sdk.type"]).toBe("client")
		expect(attrMap["deployment.environment"]).toBe("test")
		expect(attrMap["deployment.environment.name"]).toBe("test")
	})

	it("captures and exports only after explicit consent is granted", async () => {
		const { calls, restore: r } = setupFetch()
		restore = r
		const recordTraceId = vi.fn()
		;(globalThis as Record<string, unknown>)["__MAPLE_BROWSER_SESSION__"] = {
			sessionId: "consented-session",
			recordTraceId,
		}
		const telemetry = make({ ...baseConfig, privacy: { requireConsent: true } })
		const counter = Metric.counter("consent_counter")

		await Effect.runPromise(
			Effect.all([
				Effect.succeed(undefined).pipe(Effect.withSpan("before-consent")),
				Metric.update(counter, 5),
			]).pipe(Effect.provide(telemetry.layer)),
		)
		await telemetry.flush()
		expect(calls.some((call) => call.url.endsWith("/v1/traces"))).toBe(false)
		expect(recordTraceId).not.toHaveBeenCalled()

		setConsent(true)
		await Effect.runPromise(
			Effect.all([
				Effect.succeed(undefined).pipe(Effect.withSpan("after-consent")),
				Metric.update(counter, 2),
			]).pipe(Effect.provide(telemetry.layer)),
		)
		await telemetry.flush()
		const traceCall = calls.find((call) => call.url.endsWith("/v1/traces"))
		expect(traceCall).toBeDefined()
		const spans = (traceCall!.body as any).resourceSpans[0].scopeSpans[0].spans
		expect(spans.map((span: { name: string }) => span.name)).toEqual(["after-consent"])
		expect(recordTraceId).toHaveBeenCalledTimes(1)
		const metricCall = calls.find((call) => call.url.endsWith("/v1/metrics"))
		const metrics = (metricCall!.body as any).resourceMetrics[0].scopeMetrics[0].metrics
		expect(
			metrics.find((metric: { name: string }) => metric.name === "consent_counter").sum.dataPoints[0]
				.asDouble,
		).toBe(2)
		await telemetry.dispose()
	})

	it("stops exporting metrics after a revoke, because cumulative state cannot be un-accumulated", async () => {
		const { calls, restore: r } = setupFetch()
		restore = r
		const telemetry = make({ ...baseConfig, privacy: { requireConsent: true } })
		const counter = Metric.counter("revoked_counter")

		setConsent(true)
		await Effect.runPromise(Metric.update(counter, 5).pipe(Effect.provide(telemetry.layer)))
		await telemetry.flush()
		expect(calls.some((call) => call.url.endsWith("/v1/metrics"))).toBe(true)
		calls.length = 0

		setConsent(false)
		setConsent(true)
		await Effect.runPromise(Metric.update(counter, 2).pipe(Effect.provide(telemetry.layer)))
		await telemetry.flush()

		// A counter that reached 5 under the first grant still reads 5, so the
		// post-re-grant snapshot would carry the revoked-era total. Spans and logs
		// resume (their buffers are droppable); metrics stay off for the page.
		expect(calls.some((call) => call.url.endsWith("/v1/metrics"))).toBe(false)
		await telemetry.dispose()
	})

	it("still exports metrics when consent simply arrives late", async () => {
		const { calls, restore: r } = setupFetch()
		restore = r
		const telemetry = make({ ...baseConfig, privacy: { requireConsent: true } })
		const counter = Metric.counter("late_grant_counter")

		// Nothing was recorded before the grant, so there is nothing to forget —
		// the buffer starting out disabled must not read as a revoke.
		setConsent(true)
		await Effect.runPromise(Metric.update(counter, 3).pipe(Effect.provide(telemetry.layer)))
		await telemetry.flush()

		const metricCall = calls.find((call) => call.url.endsWith("/v1/metrics"))
		expect(metricCall).toBeDefined()
		await telemetry.dispose()
	})

	it("captures browser navigator + Intl resource attributes", async () => {
		const { calls, restore: rf } = setupFetch()
		// `navigator` is a getter-only global in modern Node — stubGlobal handles it.
		vi.stubGlobal("navigator", { userAgent: "TestAgent/1.0", language: "en-GB" })
		restore = () => {
			rf()
			vi.unstubAllGlobals()
		}
		const telemetry = make(baseConfig)

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op"), Effect.provide(telemetry.layer)),
		)
		await telemetry.flush()

		const traceCall = calls.find((c) => c.url.endsWith("/v1/traces"))!
		const attrs = (
			traceCall.body as {
				resourceSpans: Array<{
					resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> }
				}>
			}
		).resourceSpans[0].resource.attributes
		const attrMap = Object.fromEntries(attrs.map((a) => [a.key, a.value.stringValue]))
		expect(attrMap["user_agent.original"]).toBe("TestAgent/1.0")
		expect(attrMap["browser.language"]).toBe("en-GB")
		// Intl is always present in node/browsers; just assert it's a non-empty string.
		expect(typeof attrMap["browser.timezone"]).toBe("string")
	})

	it("links the active replay session: records the trace id + stamps session.id", async () => {
		const { calls, restore: rf } = setupFetch()
		const g = globalThis as Record<string, unknown>
		const recordTraceId = vi.fn()
		g.__MAPLE_BROWSER_SESSION__ = { sessionId: "sess-123", recordTraceId }
		restore = () => {
			rf()
			delete g.__MAPLE_BROWSER_SESSION__
		}
		const telemetry = make(baseConfig)

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op"), Effect.provide(telemetry.layer)),
		)
		await telemetry.flush()

		expect(recordTraceId).toHaveBeenCalledTimes(1)
		expect(recordTraceId.mock.calls[0][0]).toMatch(/^[0-9a-f]{32}$/i)

		const traceCall = calls.find((c) => c.url.endsWith("/v1/traces"))!
		const span = (
			traceCall.body as {
				resourceSpans: Array<{
					scopeSpans: Array<{
						spans: Array<{ attributes: Array<{ key: string; value: { stringValue?: string } }> }>
					}>
				}>
			}
		).resourceSpans[0].scopeSpans[0].spans[0]
		const sessionAttr = span.attributes.find((a) => a.key === "session.id")
		expect(sessionAttr?.value.stringValue).toBe("sess-123")
	})

	it("stamps session.id from the self-managed session when no sink is published", async () => {
		const { calls, restore: rf } = setupFetch()
		// Standalone: no @maple-dev/browser sink, just a browser DOM with
		// sessionStorage. The bundled @maple/browser-session core must mint a
		// session and stamp its id on every span.
		const store = new Map<string, string>()
		vi.stubGlobal(
			"window",
			Object.assign(new EventTarget(), {
				sessionStorage: {
					getItem: (k: string) => store.get(k) ?? null,
					setItem: (k: string, v: string) => void store.set(k, v),
				},
			}),
		)
		vi.stubGlobal(
			"document",
			Object.assign(new EventTarget(), { cookie: "", visibilityState: "visible" }),
		)
		restore = () => {
			rf()
			vi.unstubAllGlobals()
		}
		const telemetry = make({ ...baseConfig, replay: { enabled: false } })

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op-a"), Effect.provide(telemetry.layer)),
		)
		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op-b"), Effect.provide(telemetry.layer)),
		)
		await telemetry.flush()

		const stored = JSON.parse(store.get("maple.session")!) as { id: string }
		const traceCall = calls.find((c) => c.url.endsWith("/v1/traces"))!
		const spans = (
			traceCall.body as {
				resourceSpans: Array<{
					scopeSpans: Array<{
						spans: Array<{ attributes: Array<{ key: string; value: { stringValue?: string } }> }>
					}>
				}>
			}
		).resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans))
		expect(spans.length).toBeGreaterThanOrEqual(2)
		for (const span of spans) {
			const sessionAttr = span.attributes.find((a) => a.key === "session.id")
			expect(sessionAttr?.value.stringValue).toBe(stored.id)
		}
		await telemetry.dispose()
	})

	it("flushes on pagehide and dispose() removes the unload listeners", async () => {
		const { calls, restore: rf } = setupFetch()
		const dom = setupDom()
		restore = () => {
			rf()
			dom.restore()
		}
		const telemetry = make({ ...baseConfig, flushOnUnload: true })

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op"), Effect.provide(telemetry.layer)),
		)

		expect(dom.listenerCount("pagehide")).toBe(1)
		expect(dom.listenerCount("pageshow")).toBe(1)
		// No manual flush — the unload handler should do it.
		dom.fire("pagehide")
		await tick()
		expect(calls.some((c) => c.url.endsWith("/v1/traces"))).toBe(true)

		await telemetry.dispose()
		expect(dom.listenerCount("pagehide")).toBe(0)
		expect(dom.listenerCount("pageshow")).toBe(0)
		expect(dom.listenerCount("visibilitychange")).toBe(0)
	})

	it("auto-flushes on the interval, and dispose() stops the timer", async () => {
		vi.useFakeTimers()
		const { calls, restore: r } = setupFetch()
		restore = r
		const telemetry = make({ ...baseConfig, autoFlushInterval: 5_000 })

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("timed-op"), Effect.provide(telemetry.layer)),
		)

		await vi.advanceTimersByTimeAsync(5_000)
		expect(calls.some((c) => c.url.endsWith("/v1/traces"))).toBe(true)
		const afterAuto = calls.length

		await telemetry.dispose()
		await vi.advanceTimersByTimeAsync(10_000)
		expect(calls.length).toBe(afterAuto)
	})

	it("does not re-export unchanged cumulative metrics on every interval", async () => {
		vi.useFakeTimers()
		const { calls, restore: r } = setupFetch()
		restore = r
		const telemetry = make({ ...baseConfig, autoFlushInterval: 5_000 })
		const counter = Metric.counter("rare_browser_metric")

		await Effect.runPromise(Metric.update(counter, 1).pipe(Effect.provide(telemetry.layer)))
		await vi.advanceTimersByTimeAsync(5_000)
		expect(calls.filter((call) => call.url.endsWith("/v1/metrics"))).toHaveLength(1)

		// The metric is cumulative, but it has not changed. Subsequent trace/log
		// flush ticks must not generate duplicate metrics requests.
		await vi.advanceTimersByTimeAsync(15_000)
		expect(calls.filter((call) => call.url.endsWith("/v1/metrics"))).toHaveLength(1)

		await Effect.runPromise(Metric.update(counter, 1).pipe(Effect.provide(telemetry.layer)))
		await vi.advanceTimersByTimeAsync(5_000)
		expect(calls.filter((call) => call.url.endsWith("/v1/metrics"))).toHaveLength(2)

		await telemetry.dispose()
		expect(calls.filter((call) => call.url.endsWith("/v1/metrics"))).toHaveLength(2)
	})

	it("still exports without Authorization when no ingest key is set, for a proxy to add", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const { calls, restore: rf } = setupFetch()
		restore = () => {
			rf()
			warnSpy.mockRestore()
		}
		const telemetry = make({
			serviceName: "unit-test",
			endpoint: "https://collector.test",
			autoFlushInterval: false,
			flushOnUnload: false,
		})

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op"), Effect.provide(telemetry.layer)),
		)
		await telemetry.flush()

		const traces = calls.find((call) => call.url.endsWith("/v1/traces"))
		expect(traces).toBeDefined()
		expect(traces!.headers).not.toHaveProperty("authorization")
		// A custom endpoint is a proxy or collector: keyless is legitimate there.
		expect(warnSpy).not.toHaveBeenCalled()
	})

	it("flushes on visibilitychange only when the document is hidden", async () => {
		const { calls, restore: rf } = setupFetch()
		const dom = setupDom()
		restore = () => {
			rf()
			dom.restore()
		}
		const telemetry = make({ ...baseConfig, flushOnUnload: true })

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op"), Effect.provide(telemetry.layer)),
		)

		// Still visible → the handler must not flush.
		dom.fire("visibilitychange")
		await tick()
		expect(calls.some((c) => c.url.endsWith("/v1/traces"))).toBe(false)

		// Hidden → flush the tail before the tab is backgrounded.
		dom.setHidden()
		dom.fire("visibilitychange")
		await tick()
		expect(calls.some((c) => c.url.endsWith("/v1/traces"))).toBe(true)
	})

	it("registers no unload listeners when flushOnUnload is false", () => {
		const dom = setupDom()
		restore = dom.restore
		make({ ...baseConfig, flushOnUnload: false })
		expect(dom.listenerCount("pagehide")).toBe(0)
		expect(dom.listenerCount("visibilitychange")).toBe(0)
	})

	it("dispose() flushes buffered spans even without a manual flush", async () => {
		const { calls, restore: r } = setupFetch()
		restore = r
		const telemetry = make(baseConfig) // autoFlushInterval + flushOnUnload both off

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("late-op"), Effect.provide(telemetry.layer)),
		)
		// No manual flush, no timer, no unload event — dispose must still drain.
		expect(calls.length).toBe(0)
		await telemetry.dispose()
		expect(calls.some((c) => c.url.endsWith("/v1/traces"))).toBe(true)
	})

	it("sends a batch over the keepalive ceiling as a plain request, and keeps flushing after it", async () => {
		const { calls, restore: r } = setupFetch()
		restore = r
		const telemetry = make(baseConfig)

		await recordSpans(telemetry, numbered("big", 400))
		await telemetry.flush()
		expect(traceCalls(calls)).toHaveLength(1)
		expect(traceCalls(calls)[0].bytes).toBeGreaterThan(OTLP_KEEPALIVE_BYTES)
		// The browser would reject this body with keepalive set, whatever the server says.
		expect(traceCalls(calls)[0].keepalive).toBe(false)

		await recordSpans(telemetry, ["small"])
		await telemetry.flush()
		expect(traceCalls(calls)).toHaveLength(2)
		expect(traceCalls(calls)[1].keepalive).toBe(true)
		expect(spanNames(calls)).toHaveLength(401)
	})

	it("aborts a POST that never answers, restores its batch, and lets the queue continue", async () => {
		vi.useFakeTimers()
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		let answer = false
		const { calls, restore: r } = setupFetch((_url, init) =>
			answer
				? new Response(null, { status: 200 })
				: new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
					}),
		)
		restore = r
		const telemetry = make(baseConfig)

		await recordSpans(telemetry, ["stuck"])
		const stuck = telemetry.flush()
		const queued = telemetry.flush()
		await vi.advanceTimersByTimeAsync(31_000)
		await Promise.all([stuck, queued])

		expect(calls).toHaveLength(1)
		expect(String(errorSpy.mock.calls[0]?.[1])).toContain("OTLP POST timed out after 30s")

		answer = true
		// The aborted request gave its reservation back: a body the size of the whole budget fits.
		await postToIngest("https://collector.test/x", {}, JSON.stringify("x".repeat(48 * 1024 - 2)), true)
		expect(calls.pop()?.keepalive).toBe(true)
		await vi.advanceTimersByTimeAsync(60_000)
		await telemetry.flush()
		expect(spanNames(calls.slice(1))).toEqual(["stuck"])
		// An answered POST leaves no timeout behind.
		expect(vi.getTimerCount()).toBe(0)
	})

	it("flushes on pagehide while a periodic flush is still in flight", async () => {
		const inflight = pendingResponses()
		const { calls, restore: rf } = setupFetch(inflight.responder)
		const dom = setupDom()
		restore = () => {
			rf()
			dom.restore()
		}
		const telemetry = make({ ...baseConfig, flushOnUnload: true })

		await recordSpans(telemetry, ["periodic"])
		const periodic = telemetry.flush()
		await tick()
		expect(spanNames(calls)).toEqual(["periodic"])
		await recordSpans(telemetry, ["tail"])
		dom.fire("pagehide")
		// No await: the request has to leave inside the event handler.
		expect(spanNames(calls)).toEqual(["periodic", "tail"])

		inflight.resolveAll()
		await periodic
	})

	it("during a cooldown a hidden tab sends nothing, and pagehide still sends", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		let status = 503
		const { calls, restore: rf } = setupFetch(() => new Response(null, { status }))
		const dom = setupDom()
		restore = () => {
			rf()
			dom.restore()
		}
		const telemetry = make({ ...baseConfig, flushOnUnload: true })

		await recordSpans(telemetry, ["rejected"])
		await telemetry.flush()
		expect(errorSpy).toHaveBeenCalledTimes(1)

		status = 200
		dom.setHidden()
		dom.fire("visibilitychange")
		expect(traceCalls(calls)).toHaveLength(1)
		expect(warnSpy).toHaveBeenCalledTimes(1)

		dom.fire("pagehide")
		expect(spanNames(traceCalls(calls).slice(1))).toEqual(["rejected"])
	})

	it("sends a backlog on pagehide as two requests per signal, the newest items first with keepalive", async () => {
		const inflight = pendingResponses()
		const { calls, restore: rf } = setupFetch(inflight.responder)
		const dom = setupDom()
		restore = () => {
			rf()
			dom.restore()
		}
		const telemetry = make({ ...baseConfig, flushOnUnload: true })
		const names = numbered("backlog", 5_000)

		await recordSpans(telemetry, names)
		await Effect.runPromise(
			Effect.all([
				Effect.logInfo("last words"),
				Metric.update(Metric.counter("unload_counter"), 1),
			]).pipe(Effect.provide(telemetry.layer)),
		)
		dom.fire("pagehide")

		// All in the one handler: traces, then logs, then metrics.
		expect(calls.map((call) => call.url.replace("https://collector.test/v1/", ""))).toEqual([
			"traces",
			"traces",
			"logs",
			"metrics",
		])
		const [newest, older] = traceCalls(calls)
		const tail = spanNames([newest])
		expect(tail.length).toBeGreaterThan(1)
		expect(tail).toEqual(names.slice(-tail.length))
		expect(newest.bytes).toBeLessThanOrEqual(OTLP_UNLOAD_TAIL_BYTES)
		expect(newest.keepalive).toBe(true)
		// Everything older is one request, which no keepalive budget could hold.
		expect(spanNames([older])).toEqual(names.slice(0, -tail.length))
		expect(older.keepalive).toBe(false)

		inflight.resolveAll()
		await tick()
	})

	it("sends only the newest part of each signal with keepalive, which leaves room for metrics", async () => {
		// Effect's default logger prints every log line.
		vi.spyOn(console, "log").mockImplementation(() => {})
		const inflight = pendingResponses()
		const { calls, restore: rf } = setupFetch(inflight.responder)
		const dom = setupDom()
		restore = () => {
			rf()
			dom.restore()
		}
		const telemetry = make({ ...baseConfig, flushOnUnload: true })

		await recordSpans(telemetry, numbered("span", 200))
		await Effect.runPromise(
			Effect.all([
				Effect.forEach(numbered("log", 40), (line) => Effect.logInfo(`${line} ${"x".repeat(1024)}`), {
					discard: true,
				}),
				Metric.update(Metric.counter("unload_counter"), 1),
			]).pipe(Effect.provide(telemetry.layer)),
		)
		dom.fire("pagehide")

		expect(
			calls.map((call) => [call.url.replace("https://collector.test/v1/", ""), call.keepalive]),
		).toEqual([
			["traces", true],
			["traces", false],
			["logs", true],
			["logs", false],
			["metrics", true],
		])
		// Both tails are full, and OTLP's share still holds the metrics snapshot.
		const keepalive = calls.filter((call) => call.keepalive)
		expect(keepalive[0].bytes + keepalive[1].bytes).toBeGreaterThan(24 * 1024)
		expect(keepalive.reduce((sum, call) => sum + call.bytes, 0)).toBeLessThanOrEqual(OTLP_KEEPALIVE_BYTES)

		inflight.resolveAll()
		await tick()
	})

	it("sends the older part without keepalive even when room is left", async () => {
		const inflight = pendingResponses()
		const { calls, restore: rf } = setupFetch(inflight.responder)
		const dom = setupDom()
		restore = () => {
			rf()
			dom.restore()
		}
		const telemetry = make({ ...baseConfig, flushOnUnload: true })

		await recordSpans(telemetry, numbered("span", 62))
		dom.fire("pagehide")

		const [newest, older] = traceCalls(calls)
		expect(newest.keepalive).toBe(true)
		expect(newest.bytes).toBeLessThanOrEqual(OTLP_UNLOAD_TAIL_BYTES)
		// It would fit OTLP's share; the next signal's newest items need that room more.
		expect(newest.bytes + older.bytes).toBeLessThan(OTLP_KEEPALIVE_BYTES)
		expect(older.keepalive).toBe(false)

		inflight.resolveAll()
		await tick()
	})

	it("sizes the newest-first request to the keepalive room a periodic flush leaves", async () => {
		const inflight = pendingResponses()
		const { calls, restore: rf } = setupFetch(inflight.responder)
		const dom = setupDom()
		restore = () => {
			rf()
			dom.restore()
		}
		const telemetry = make({ ...baseConfig, flushOnUnload: true })
		const names = numbered("tail", 40)

		await recordSpans(telemetry, numbered("periodic", 70))
		const periodic = telemetry.flush()
		await tick()
		await recordSpans(telemetry, names)
		dom.fire("pagehide")

		const [inFlight, newest, older] = traceCalls(calls)
		expect(inFlight.keepalive).toBe(true)
		// The newest spans take what is left of OTLP's share; the older ones go plain.
		const tail = spanNames([newest])
		expect(tail).toEqual(names.slice(-tail.length))
		expect(newest.keepalive).toBe(true)
		expect(inFlight.bytes + newest.bytes).toBeLessThanOrEqual(OTLP_KEEPALIVE_BYTES)
		expect(spanNames([older])).toEqual(names.slice(0, -tail.length))
		expect(older.keepalive).toBe(false)

		// OTLP's share leaves room for the session's final row.
		const row = JSON.stringify("x".repeat(8 * 1024))
		const sessionRow = postToIngest("https://collector.test/v1/sessionReplays/meta", {}, row, true)
		expect(calls.at(-1)?.keepalive).toBe(true)

		inflight.resolveAll()
		await Promise.all([periodic, sessionRow])
	})

	it("still gets keepalive when session writes reserved first", async () => {
		const inflight = pendingResponses()
		const { calls, restore: rf } = setupFetch(inflight.responder)
		const dom = setupDom()
		restore = () => {
			rf()
			dom.restore()
		}
		const telemetry = make({ ...baseConfig, flushOnUnload: true })

		const rows = JSON.stringify("x".repeat(30 * 1024))
		const sessionRows = postToIngest("https://collector.test/v1/sessionEvents", {}, rows, true)
		await recordSpans(telemetry, numbered("span", 40))
		dom.fire("pagehide")

		// Session bytes count against the shared total, not against OTLP's share.
		expect(traceCalls(calls)).toHaveLength(1)
		expect(traceCalls(calls)[0].keepalive).toBe(true)

		inflight.resolveAll()
		await sessionRows
	})

	it("ignores a periodic POST the browser rejects before this pagehide listener has run", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const inflight = pendingResponses()
		const { calls, restore: rf } = setupFetch(inflight.responder)
		const dom = setupDom()
		restore = () => {
			rf()
			dom.restore()
		}
		// Another listener of the same event runs first, and the rejection is
		// handled at the microtask checkpoint right after it.
		dom.listen("pagehide", inflight.rejectAll)
		const telemetry = make({ ...baseConfig, flushOnUnload: true })

		await recordSpans(telemetry, ["periodic"])
		const periodic = telemetry.flush()
		await tick()
		await dom.fireWithCheckpoints("pagehide")
		await periodic

		// Sent once: not put back for the pagehide flush or for a later one.
		dom.fire("pageshow")
		await telemetry.flush()
		expect(spanNames(calls)).toEqual(["periodic"])
		expect(errorSpy).not.toHaveBeenCalled()
		expect(warnSpy).not.toHaveBeenCalled()
	})

	it("ignores a rejection seen after pagehide, until pageshow", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const inflight = pendingResponses()
		const { calls, restore: rf } = setupFetch(inflight.responder)
		const dom = setupDom()
		restore = () => {
			rf()
			dom.restore()
		}
		const telemetry = make({ ...baseConfig, flushOnUnload: true })

		await recordSpans(telemetry, ["periodic"])
		const periodic = telemetry.flush()
		await tick()
		await recordSpans(telemetry, ["tail"])
		dom.fire("pagehide")
		// An unloading document rejects keepalive fetches the server still receives.
		inflight.rejectAll()
		await periodic
		await tick()
		expect(errorSpy).not.toHaveBeenCalled()

		// Restored from the back/forward cache: nothing was put back or is cooling
		// down, and a failure counts again.
		dom.fire("pageshow")
		await recordSpans(telemetry, ["after-restore"])
		const next = telemetry.flush()
		await tick()
		inflight.rejectAll()
		await next
		expect(spanNames(calls)).toEqual(["periodic", "tail", "after-restore"])
		expect(warnSpy).not.toHaveBeenCalled()
		expect(errorSpy).toHaveBeenCalledTimes(1)
	})

	it("still treats an error status after pagehide as a failed flush", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const { restore: rf } = setupFetch(() => new Response(null, { status: 503 }))
		const dom = setupDom()
		restore = () => {
			rf()
			dom.restore()
		}
		const telemetry = make({ ...baseConfig, flushOnUnload: true })

		await recordSpans(telemetry, ["refused"])
		dom.fire("pagehide")
		await tick()
		// Ingest answered, so this is not the unloading document's own rejection.
		expect(errorSpy).toHaveBeenCalledTimes(1)
	})

	it("restores and cools down when the flush fails on a page that is only hidden", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		vi.useFakeTimers({ toFake: ["Date"] })
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		let fail = true
		const { calls, restore: rf } = setupFetch(() =>
			fail ? Promise.reject(new TypeError("Failed to fetch")) : new Response(null, { status: 200 }),
		)
		const dom = setupDom()
		restore = () => {
			rf()
			dom.restore()
		}
		const telemetry = make({ ...baseConfig, flushOnUnload: true })

		await recordSpans(telemetry, ["hidden"])
		dom.setHidden()
		dom.fire("visibilitychange")
		// The rejection is judged one task after it arrives.
		await tick()
		await tick()
		expect(errorSpy).toHaveBeenCalledTimes(1)

		fail = false
		await telemetry.flush()
		expect(warnSpy).toHaveBeenCalledTimes(1)
		expect(traceCalls(calls)).toHaveLength(1)
		vi.advanceTimersByTime(60_000)
		await telemetry.flush()
		expect(spanNames(traceCalls(calls).slice(1))).toEqual(["hidden"])
	})

	it("sends nothing on pagehide or hide without consent", async () => {
		const { calls, restore: rf } = setupFetch()
		const dom = setupDom()
		restore = () => {
			rf()
			dom.restore()
		}
		const telemetry = make({ ...baseConfig, flushOnUnload: true, privacy: { requireConsent: true } })

		await recordSpans(telemetry, ["before-consent"])
		dom.setHidden()
		dom.fire("visibilitychange")
		dom.fire("pagehide")
		await tick()
		expect(calls).toHaveLength(0)

		// Dropped, not held back for a later grant.
		setConsent(true)
		await telemetry.flush()
		expect(calls).toHaveLength(0)
		await telemetry.dispose()
	})
})
