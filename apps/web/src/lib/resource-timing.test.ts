import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	findResourceTiming,
	type ResourceTimingEntry,
	resourceTimingAttributes,
	withResourceTiming,
} from "./resource-timing"

const PATH = "/internal/query-engine/execute-batch"

const entry = (startTime: number, overrides: Partial<ResourceTimingEntry> = {}): ResourceTimingEntry => ({
	name: `https://app.maple.dev/_api${PATH}`,
	startTime,
	requestStart: startTime + 2,
	responseStart: startTime + 200,
	responseEnd: startTime + 210,
	nextHopProtocol: "h2",
	...overrides,
})

describe("findResourceTiming", () => {
	it("picks the request that ran inside the caller's window", () => {
		const before = entry(10)
		const own = entry(110)
		const later = entry(400)
		expect(findResourceTiming([before, own, later], PATH, 100, 500)).toBe(own)
	})

	it("ignores other paths and requests still running when the caller resumed", () => {
		const other = entry(110, { name: "https://app.maple.dev/_api/internal/query-engine/execute-raw-sql" })
		const unfinished = entry(120, { responseEnd: 900 })
		expect(findResourceTiming([other, unfinished], PATH, 100, 500)).toBeUndefined()
	})
})

describe("resourceTimingAttributes", () => {
	it("splits the wait into before, on the wire and after the bytes arrived", () => {
		const attributes = resourceTimingAttributes(entry(110), 100, 450)
		expect(attributes["maple.http.timing.start_delay_ms"]).toBe(10)
		expect(attributes["maple.http.timing.ttfb_ms"]).toBe(198)
		expect(attributes["maple.http.timing.download_ms"]).toBe(10)
		// Bytes in at 320, the caller resumed at 450.
		expect(attributes["maple.http.timing.after_response_ms"]).toBe(130)
	})
})

describe("withResourceTiming", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	/** Runs a fake request inside a span; `visibleFrom` is the lookup that first sees its entry. */
	const run = (visibleFrom: number | undefined) => {
		let lookups = 0
		let request: PerformanceEntry | undefined
		vi.spyOn(performance, "getEntriesByType").mockImplementation(() => {
			lookups += 1
			return request !== undefined && visibleFrom !== undefined && lookups >= visibleFrom
				? [request]
				: []
		})
		const fakeRequest = Effect.sync(() => {
			const startTime = performance.now()
			request = {
				...entry(startTime, { responseEnd: startTime }),
				entryType: "resource",
				duration: 0,
				toJSON: () => ({}),
			}
		})
		return Effect.runPromise(
			Effect.gen(function* () {
				yield* fakeRequest.pipe(withResourceTiming(PATH))
				const span = yield* Effect.currentSpan
				return span.attributes
			}).pipe(Effect.withSpan("QueryEngine.executeBatch")),
		)
	}

	it("writes the request's timing on the span", async () => {
		const attributes = await run(1)
		expect(attributes.get("maple.http.timing.protocol")).toBe("h2")
		expect(attributes.has("maple.http.timing.missing")).toBe(false)
	})

	it("finds an entry the browser delivers a task later", async () => {
		const attributes = await run(2)
		expect(attributes.get("maple.http.timing.protocol")).toBe("h2")
	})

	it("marks the span when no entry ever matches", async () => {
		const attributes = await run(undefined)
		expect(attributes.get("maple.http.timing.missing")).toBe(true)
	})
})
