import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"
import { hasRootInside, lookupByTraceId, recentTraceWindow, type TraceWindow } from "./trace-lookup"

const NOW = Date.parse("2026-04-10T15:30:00Z")
const RECENT: TraceWindow = { startTime: "2026-04-08 00:00:00", endTime: "2100-01-01 00:00:00" }

/** A warehouse holding one row per timestamp, answering a read with the rows inside its bounds. */
const warehouse = (timestamps: ReadonlyArray<string>) => {
	const reads: Array<TraceWindow | undefined> = []
	const read = (window?: TraceWindow) =>
		Effect.sync(() => {
			reads.push(window)
			return timestamps.filter((ts) => !window || (ts >= window.startTime && ts <= window.endTime))
		})
	return { reads, read }
}

describe("lookupByTraceId", () => {
	it("starts the recent window on a day boundary, two days back", () => {
		assert.deepStrictEqual(recentTraceWindow(NOW), RECENT)
	})

	it.effect("reads only the hinted hour when the rows are there", () =>
		Effect.gen(function* () {
			const { reads, read } = warehouse(["2026-03-20 08:00:00.5"])
			const result = yield* lookupByTraceId({
				nowMs: NOW,
				hintMs: Date.parse("2026-03-20T08:30:00Z"),
				read,
			})
			assert.deepStrictEqual(result, { rows: ["2026-03-20 08:00:00.5"], stage: "hint" })
			assert.deepStrictEqual(reads, [
				{ startTime: "2026-03-20 07:30:00", endTime: "2026-03-20 09:30:00" },
			])
		}),
	)

	it.effect("reads only the recent window without a hint", () =>
		Effect.gen(function* () {
			const { reads, read } = warehouse(["2026-04-09 11:00:00"])
			const result = yield* lookupByTraceId({ nowMs: NOW, read })
			assert.deepStrictEqual(result, { rows: ["2026-04-09 11:00:00"], stage: "recent" })
			assert.deepStrictEqual(reads, [RECENT])
		}),
	)

	it.effect("reads unbounded once the hint and the recent window miss", () =>
		Effect.gen(function* () {
			const { reads, read } = warehouse(["2026-03-20 08:00:00"])
			const result = yield* lookupByTraceId({
				nowMs: NOW,
				hintMs: Date.parse("2026-04-01T00:00:00Z"),
				read,
			})
			assert.deepStrictEqual(result, { rows: ["2026-03-20 08:00:00"], stage: "retention" })
			assert.deepStrictEqual(reads, [
				{ startTime: "2026-03-31 23:00:00", endTime: "2026-04-01 01:00:00" },
				RECENT,
				undefined,
			])
		}),
	)

	it.effect("reads unbounded when the recent rows are not the whole answer", () =>
		Effect.gen(function* () {
			const { reads, read } = warehouse(["2026-03-20 08:00:00", "2026-04-09 11:00:00"])
			const result = yield* lookupByTraceId({ nowMs: NOW, read, whole: () => false })
			assert.deepStrictEqual(result.rows, ["2026-03-20 08:00:00", "2026-04-09 11:00:00"])
			assert.deepStrictEqual(reads, [RECENT, undefined])
		}),
	)
})

describe("hasRootInside", () => {
	const span = (parentSpanId: string, startTime: string) => ({
		parentSpanId,
		startTime: DateTime.makeUnsafe(startTime),
	})

	it("needs a root span more than an hour into the window", () => {
		assert.isTrue(hasRootInside([span("", "2026-04-08T01:00:00Z")], RECENT))
		assert.isFalse(hasRootInside([span("", "2026-04-08T00:59:59Z")], RECENT))
		assert.isFalse(hasRootInside([span("a1", "2026-04-09T12:00:00Z")], RECENT))
		assert.isFalse(hasRootInside([], RECENT))
	})
})
