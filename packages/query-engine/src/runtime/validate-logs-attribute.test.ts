import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema, Array as Arr } from "effect"
import { LogsBreakdownQuery } from "@maple/domain/query-engine"
import { validateEvaluate, type AlertEvaluateRequest } from "./query-engine"

const makeRequest = (query: LogsBreakdownQuery): AlertEvaluateRequest => ({
	startTime: "2026-04-01 00:00:00",
	endTime: "2026-04-01 01:00:00",
	source: { kind: "spec", query },
	reducer: "sum",
	sampleCountStrategy: null,
})

const decodeBreakdown = Schema.decodeUnknownSync(LogsBreakdownQuery)

describe("logs attribute grouping", () => {
	it("rejects an unknown logs groupBy at decode", () => {
		assert.throws(() =>
			decodeBreakdown({ kind: "breakdown", source: "logs", metric: "count", groupBy: "span_name" }),
		)
	})

	it.effect("rejects groupBy=attribute without groupByAttributeKey", () =>
		Effect.gen(function* () {
			const error = yield* validateEvaluate(
				makeRequest({ kind: "breakdown", source: "logs", metric: "count", groupBy: "attribute" }),
			).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/QueryEngineValidationError")
			if (error._tag === "@maple/http/errors/QueryEngineValidationError") {
				assert.include(Arr.join(error.details, "; "), "filters.groupByAttributeKey")
			}
		}),
	)

	it.effect("rejects groupBy=resource_attribute with a blank key", () =>
		Effect.gen(function* () {
			const error = yield* validateEvaluate(
				makeRequest({
					kind: "breakdown",
					source: "logs",
					metric: "count",
					groupBy: "resource_attribute",
					filters: { groupByResourceAttributeKey: "  " },
				}),
			).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/QueryEngineValidationError")
			if (error._tag === "@maple/http/errors/QueryEngineValidationError") {
				assert.include(Arr.join(error.details, "; "), "filters.groupByResourceAttributeKey")
			}
		}),
	)

	it.effect("accepts groupBy=resource_attribute with its key", () =>
		Effect.gen(function* () {
			const range = yield* validateEvaluate(
				makeRequest({
					kind: "breakdown",
					source: "logs",
					metric: "count",
					groupBy: "resource_attribute",
					filters: { groupByResourceAttributeKey: "host.name" },
				}),
			)
			assert.strictEqual(range.rangeSeconds, 3600)
		}),
	)
})
