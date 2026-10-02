import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, expect, vi } from "vitest"
import { layer } from "./layer.js"

// Regression guard for the `withSessionLink` extraction: `Maple.layer` (the
// Otlp-based client preset) must still wire the replay-session decorator, so a
// span created under it reports its trace id to the published session sink.
// (That the decorator also stamps `session.id` onto the OTLP span is asserted
// robustly — off the actual exported body — in flushable.test.ts.)

// `FetchHttpClient` resolves `globalThis.fetch` once, so the stub is installed
// for the whole file and each test swaps the handler behind it.
const ok = async (_request: Request) => new Response(null, { status: 200 })
let onFetch = ok
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
	onFetch(new Request(input, init))) as typeof fetch

const setupFetch = () => {
	onFetch = ok
	return () => void (onFetch = ok)
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

	it("applies span options and still stamps session.id on the exported span", async () => {
		const bodies: Array<string> = []
		onFetch = async (request) => {
			if (request.url.endsWith("/v1/traces")) bodies.push(await request.text())
			return new Response(null, { status: 200 })
		}
		const g = globalThis as Record<string, unknown>
		g.__MAPLE_BROWSER_SESSION__ = { sessionId: "sess-xyz", recordTraceId: vi.fn() }
		restore = () => {
			onFetch = ok
			delete g.__MAPLE_BROWSER_SESSION__
		}

		const TracerLive = layer({
			serviceName: "web-test",
			endpoint: "https://collector.test",
			ingestKey: "secret",
			dropSpanNames: ["noise."],
		})
		await Effect.runPromise(
			Effect.void.pipe(
				Effect.withSpan("noise.poll"),
				Effect.andThen(Effect.void.pipe(Effect.withSpan("page-load"))),
				Effect.provide(TracerLive),
			),
		)

		const payload = bodies.join("\n")
		expect(payload).toContain('"page-load"')
		expect(payload).not.toContain('"noise.poll"')
		expect(payload).toContain("sess-xyz")
	})
})
