import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, expect, vi } from "vitest"
import { layer } from "./layer.js"

// Regression guard for the `withSessionLink` extraction: `Maple.layer` (the
// Otlp-based client preset) must still wire the replay-session decorator, so a
// span created under it reports its trace id to the published session sink.
// (That the decorator also stamps `session.id` onto the OTLP span is asserted
// robustly — off the actual exported body — in flushable.test.ts.)

// Shared by every mock: Effect reads `globalThis.fetch` once and keeps it, so
// later tests' requests still reach the first test's mock.
const requests: Array<Request> = []

const setupFetch = () => {
	const original = globalThis.fetch
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		requests.push(new Request(input, init))
		return new Response(null, { status: 200 })
	}) as typeof fetch
	return () => void (globalThis.fetch = original)
}

describe("Maple.layer (client) — session linking after refactor", () => {
	let restore: () => void

	afterEach(() => {
		restore?.()
	})

	it("records the trace id and stamps session.id via the published session sink", async () => {
		const restoreFetch = setupFetch()
		const g = globalThis as Record<string, unknown>
		const recordTraceId = vi.fn()
		g.__MAPLE_BROWSER_SESSION__ = { sessionId: "sess-xyz", recordTraceId }
		restore = () => {
			restoreFetch()
			delete g.__MAPLE_BROWSER_SESSION__
		}

		const TracerLive = layer({
			serviceName: "web-test",
			endpoint: "https://collector.test",
			ingestKey: "secret",
		})

		await Effect.runPromise(Effect.void.pipe(Effect.withSpan("page-load"), Effect.provide(TracerLive)))

		// The session sink saw this span's trace id — proves the decorator is
		// still wired into Maple.layer post-extraction.
		expect(recordTraceId).toHaveBeenCalledTimes(1)
		expect(recordTraceId.mock.calls[0][0]).toMatch(/^[0-9a-f]{32}$/i)
	})

	it("no-ops cleanly when no session sink is published", async () => {
		const restoreFetch = setupFetch()
		const g = globalThis as Record<string, unknown>
		delete g.__MAPLE_BROWSER_SESSION__
		restore = restoreFetch

		const TracerLive = layer({
			serviceName: "web-test",
			endpoint: "https://collector.test",
		})

		// Just has to run without throwing — proves the layer still composes.
		await Effect.runPromise(Effect.void.pipe(Effect.withSpan("page-load"), Effect.provide(TracerLive)))
	})

	it("leaves user-agent to the browser on its OTLP requests", async () => {
		// A script-set `user-agent` needs CORS approval where the browser sends it.
		restore = setupFetch()
		requests.length = 0

		const TracerLive = layer({
			serviceName: "web-test",
			endpoint: "https://collector.test",
			ingestKey: "secret",
		})
		await Effect.runPromise(Effect.void.pipe(Effect.withSpan("page-load"), Effect.provide(TracerLive)))

		expect(requests.map((request) => request.url)).toContain("https://collector.test/v1/traces")
		for (const request of requests) {
			expect(request.headers.get("authorization")).toBe("Bearer secret")
			expect(request.headers.has("user-agent")).toBe(false)
		}
	})
})
