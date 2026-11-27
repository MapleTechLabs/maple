import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, Effect, Layer, Option } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterEach, vi } from "vitest"
import { type ExportDrop, makeDropReporter, makeOtlpLayer } from "./otlp-layer.js"

describe("makeDropReporter", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("warns once per order of magnitude of each signal's dropped total", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const report = makeDropReporter({ logPrefix: "[Test]" })
		const traces = report("traces")
		const logs = report("logs")

		for (const count of [1, 3, 5, 1, 89, 1]) traces(count)
		logs(4)

		expect(Arr.map(warn.mock.calls, ([line]) => line)).toEqual([
			"[Test] export queue full: spans dropped, 1 so far. Raise `maxQueueSize` or check that the ingest endpoint is reachable.",
			"[Test] export queue full: spans dropped, 10 so far. Raise `maxQueueSize` or check that the ingest endpoint is reachable.",
			"[Test] export queue full: spans dropped, 100 so far. Raise `maxQueueSize` or check that the ingest endpoint is reachable.",
			"[Test] export queue full: log records dropped, 4 so far. Raise `maxQueueSize` or check that the ingest endpoint is reachable.",
		])
	})

	it("hands every drop to the caller's hook instead of warning", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const drops: Array<ExportDrop> = []
		const report = makeDropReporter({ logPrefix: "[Test]", onDrop: (drop) => drops.push(drop) })

		report("traces")(2)
		report("logs")(1)
		report("traces")(3)

		expect(drops).toEqual([
			{ signal: "traces", count: 2, total: 2 },
			{ signal: "logs", count: 1, total: 1 },
			{ signal: "traces", count: 3, total: 5 },
		])
		expect(warn).not.toHaveBeenCalled()
	})
})

describe("makeOtlpLayer", () => {
	it("counts drops per build when one layer value is built twice", async () => {
		const totals: Array<number> = []
		const shared = makeOtlpLayer({
			baseUrl: "https://collector.test",
			resource: { serviceName: "unit-test" },
			logPrefix: "[Test]",
			maxQueueSize: 3,
			onDrop: (drop) => totals.push(drop.total),
			spans: {},
		}).pipe(
			Layer.provide(FetchHttpClient.layer),
			Layer.provide(
				Layer.succeed(FetchHttpClient.Fetch, async () => new Response(null, { status: 200 })),
			),
		)
		const tenSpans = Effect.forEach(
			Arr.range(1, 10),
			(i) => Effect.void.pipe(Effect.withSpan(`job.${i}`)),
			{
				discard: true,
			},
		)

		await Effect.runPromise(tenSpans.pipe(Effect.provide(shared)))
		const firstRun = Arr.last(totals)
		await Effect.runPromise(tenSpans.pipe(Effect.provide(shared)))

		expect(firstRun).toEqual(Option.some(7))
		expect(Arr.last(totals)).toEqual(Option.some(7))
	})
})
