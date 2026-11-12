import type { QueryEngineBatchOutcome, QueryEngineExecuteRequest } from "@maple/domain/query-engine"
import { WarehouseExecutor } from "@maple/web-data/warehouse/warehouse-services"
import { Duration, Effect, Fiber, Ref, Array as Arr } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "vitest"
import { makeExecuteBatcher } from "../../data/execute-batcher"
import { FetchLogSeries, FetchOverviewSeries } from "./command"

const window = {
	startTime: "2026-11-11 10:00:00",
	endTime: "2026-11-12 10:00:00",
	environments: ["production"],
}

const empty = (request: QueryEngineExecuteRequest): QueryEngineBatchOutcome => ({
	outcome: "success",
	result: { kind: "timeseries", source: request.query.source === "logs" ? "logs" : "traces", data: [] },
})

describe("the overview's log volume read", () => {
	test("a slow log volume read does not hold the request time series", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const batches = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([])
				// A raw log scan on a large org takes seconds; the time series answers fast.
				const batcher = yield* makeExecuteBatcher((requests) =>
					Effect.gen(function* () {
						const sources = Arr.map(requests, (request) => request.query.source)
						yield* Ref.update(batches, (sent) => [...sent, sources])
						yield* Effect.sleep(Duration.millis(Arr.contains(sources, "logs") ? 6000 : 300))
						return Arr.map(requests, empty)
					}),
				)
				const done = yield* Ref.make<ReadonlyArray<string>>([])
				const run = <A, E>(label: string, effect: Effect.Effect<A, E, WarehouseExecutor>) =>
					Effect.forkChild(
						Effect.provideService(effect, WarehouseExecutor, batcher).pipe(
							Effect.tap(() => Ref.update(done, (labels) => [...labels, label])),
						),
					)

				const logs = yield* run("logs", FetchLogSeries({ key: "logs", input: window }).effect)
				yield* run("series", FetchOverviewSeries({ key: "series", input: window }).effect)
				yield* TestClock.adjust("400 millis")

				expect(yield* Ref.get(batches)).toEqual([["logs"], ["traces"]])
				expect(yield* Ref.get(done)).toEqual(["series"])

				yield* TestClock.adjust("6 seconds")
				const message = yield* Fiber.join(logs)
				expect(message.result._tag).toBe("Success")
				expect(yield* Ref.get(done)).toEqual(["series", "logs"])
			}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
		))
})
