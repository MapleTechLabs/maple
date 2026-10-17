import {
	QUERY_ENGINE_BATCH_MAX,
	type QueryEngineBatchOutcome,
	QueryEngineExecuteRequest,
} from "@maple/query-engine"
import { Effect, Exit, Fiber, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "vitest"
import { makeExecuteBatcher, type SendExecuteBatch } from "./execute-batcher"
import { WarehouseQueryError } from "./warehouse-error"

const WINDOW_MS = 15

// The batcher never inspects the payload; the positional outcome tells the callers apart.
const request = (_index: number) =>
	new QueryEngineExecuteRequest({
		startTime: "2026-08-01 00:00:00",
		endTime: "2026-08-01 01:00:00",
		query: { kind: "count", source: "logs" },
	})

const countOf = (outcome: { readonly result: { readonly kind: string; readonly data?: unknown } }) =>
	outcome.result.kind === "count" ? outcome.result.data : undefined

const echo = (requests: ReadonlyArray<QueryEngineExecuteRequest>): ReadonlyArray<QueryEngineBatchOutcome> =>
	requests.map((_, index) => ({
		outcome: "success",
		result: { kind: "count", source: "logs", data: { total: index } },
	}))

/** A send that records each batch's size and answers with `reply`. */
const recording = (
	reply: (
		requests: ReadonlyArray<QueryEngineExecuteRequest>,
	) => ReadonlyArray<QueryEngineBatchOutcome> = echo,
) =>
	Effect.map(Ref.make<ReadonlyArray<number>>([]), (batches) => {
		const send: SendExecuteBatch = (requests) =>
			Effect.as(
				Ref.update(batches, (sizes) => [...sizes, requests.length]),
				reply(requests),
			)
		return { batches, send }
	})

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
	Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(TestClock.layer())))

describe("makeExecuteBatcher", () => {
	test("queries from separate fibers inside one window go out as one request, when the window closes", () =>
		run(
			Effect.gen(function* () {
				const { batches, send } = yield* recording()
				const batcher = yield* makeExecuteBatcher(send, WINDOW_MS)
				const first = yield* Effect.forkChild(batcher.execute("a", request(0)))
				yield* TestClock.adjust("10 millis")
				const second = yield* Effect.forkChild(batcher.execute("b", request(1)))
				yield* TestClock.adjust("4 millis")
				expect(yield* Ref.get(batches)).toEqual([])
				yield* TestClock.adjust("1 millis")
				const responses = yield* Fiber.joinAll([first, second])
				expect(yield* Ref.get(batches)).toEqual([2])
				expect(responses.map(countOf)).toEqual([{ total: 0 }, { total: 1 }])
			}),
		))

	test("a full batch goes out at once and the overflow waits for a fresh window", () =>
		run(
			Effect.gen(function* () {
				const { batches, send } = yield* recording()
				const batcher = yield* makeExecuteBatcher(send, WINDOW_MS)
				const fibers = yield* Effect.forEach(
					Array.from({ length: QUERY_ENGINE_BATCH_MAX + 1 }, (_, index) => index),
					(index) => Effect.forkChild(batcher.execute(`q${index}`, request(index))),
				)
				yield* TestClock.adjust("1 millis")
				expect(yield* Ref.get(batches)).toEqual([QUERY_ENGINE_BATCH_MAX])
				yield* TestClock.adjust(`${WINDOW_MS} millis`)
				yield* Fiber.joinAll(fibers)
				expect(yield* Ref.get(batches)).toEqual([QUERY_ENGINE_BATCH_MAX, 1])
			}),
		))

	test("a query after a full flush gets its own window, not the flushed batch's timer", () =>
		run(
			Effect.gen(function* () {
				const { batches, send } = yield* recording()
				const batcher = yield* makeExecuteBatcher(send, WINDOW_MS)
				const early = yield* Effect.forkChild(batcher.execute("early", request(0)))
				yield* TestClock.adjust("10 millis")
				const filling = yield* Effect.forEach([1, 2, 3], (index) =>
					Effect.forkChild(batcher.execute(`q${index}`, request(index))),
				)
				yield* TestClock.adjust("1 millis")
				const late = yield* Effect.forkChild(batcher.execute("late", request(4)))
				// The first window's timer would fire here; the late query must keep waiting.
				yield* TestClock.adjust("5 millis")
				expect(yield* Ref.get(batches)).toEqual([QUERY_ENGINE_BATCH_MAX])
				yield* TestClock.adjust("10 millis")
				yield* Fiber.joinAll([early, ...filling, late])
				expect(yield* Ref.get(batches)).toEqual([QUERY_ENGINE_BATCH_MAX, 1])
			}),
		))

	test("each caller settles from its own outcome: one failing query does not fail its siblings", () =>
		run(
			Effect.gen(function* () {
				const { send } = yield* recording((requests) =>
					requests.flatMap((_, index): ReadonlyArray<QueryEngineBatchOutcome> =>
						index === 1
							? [
									{
										outcome: "failure",
										error: {
											_tag: "@maple/http/errors/QueryEngineTimeoutError",
											type: "api_error",
											code: "query_engine_timeout",
											title: "Query timed out",
											message: "too slow",
											retryable: true,
											recovery: "retry",
										},
									},
								]
							: index === 2
								? []
								: echo(requests).slice(index, index + 1),
					),
				)
				const batcher = yield* makeExecuteBatcher(send, WINDOW_MS)
				const fibers = yield* Effect.forEach([0, 1, 2], (index) =>
					Effect.forkChild(Effect.exit(batcher.execute(`q${index}`, request(index)))),
				)
				yield* TestClock.adjust(`${WINDOW_MS} millis`)
				const [ok, timedOut, missing] = yield* Fiber.joinAll(fibers)
				expect(Exit.isSuccess(ok)).toBe(true)
				expect(timedOut).toEqual(
					Exit.fail(
						new WarehouseQueryError({
							operation: "q1",
							failure: {
								reason: "Rejected",
								message: "too slow",
								code: "query_engine_timeout",
								retryable: true,
							},
						}),
					),
				)
				expect(Exit.isFailure(missing)).toBe(true)
			}),
		))

	test("a failed request fails every query in that batch with the same error", () =>
		run(
			Effect.gen(function* () {
				const error = new WarehouseQueryError({
					operation: "QueryEngine.executeBatch",
					failure: { reason: "Unreachable", message: "Cannot reach Maple API", retryable: true },
				})
				const batcher = yield* makeExecuteBatcher(() => Effect.fail(error), WINDOW_MS)
				const fibers = yield* Effect.forEach([0, 1], (index) =>
					Effect.forkChild(Effect.exit(batcher.execute(`q${index}`, request(index)))),
				)
				yield* TestClock.adjust(`${WINDOW_MS} millis`)
				expect(yield* Fiber.joinAll(fibers)).toEqual([Exit.fail(error), Exit.fail(error)])
			}),
		))
})
