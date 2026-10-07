import { assert, describe, expect, it } from "@effect/vitest"
import { INVESTIGATION_PROGRESS_STEPS, type InvestigationProgress } from "@maple/domain/http"
import { Duration, Effect, Fiber, Ref } from "effect"
import { TestClock } from "effect/testing"

import {
	INVESTIGATION_PROGRESS_HEARTBEAT,
	makeProgressFeed,
	PROGRESS_WRITE_TIMEOUT,
	reviewStepLabel,
	stepLabel,
} from "./progress"

describe("stepLabel", () => {
	it("reads a verb-first tool name as a phrase, with no map to go stale", () => {
		expect(stepLabel("search_logs", {})).toBe("Search logs")
		expect(stepLabel("compare_periods", {})).toBe("Compare periods")
	})

	it("names the one argument a reader would want", () => {
		expect(stepLabel("inspect_trace", { trace_id: "7f3a9c", start_time: "…" })).toBe(
			"Inspect trace · 7f3a9c",
		)
		expect(stepLabel("diagnose_service", { service_name: "checkout-api" })).toBe(
			"Diagnose service · checkout-api",
		)
	})

	it("names a batch of review files by the first and a count", () => {
		expect(stepLabel("pr_file_diff", { repository: "o/r", paths: ["a.ts", "b.ts", "c.ts"] })).toBe(
			"Pr file diff · a.ts +2",
		)
	})

	it("shows a review only the files it read, never a pattern or a query", () => {
		expect(reviewStepLabel("sandbox_grep", { pattern: "user@example.com" })).toBe("Sandbox grep")
		expect(reviewStepLabel("search_traces", { query: "customer_id = 42" })).toBe("Search traces")
		expect(reviewStepLabel("sandbox_read_file", { path: "src/a.ts" })).toBe(
			"Sandbox read file · src/a.ts",
		)
	})

	/** A label padded with whichever key came first reads as detail while carrying none. */
	it("says nothing extra when the arguments are only time bounds", () => {
		expect(stepLabel("find_errors", { start_time: "a", end_time: "b", limit: 50 })).toBe("Find errors")
	})

	it("keeps a long argument to one clamped line", () => {
		const label = stepLabel("sandbox_grep", {
			pattern: "a".repeat(80),
		})
		expect(label.length).toBeLessThan(60)
		expect(label.endsWith("…")).toBe(true)
	})

	it("keeps acronyms upper case", () => {
		expect(stepLabel("run_sql", { sql: "SELECT 1" })).toBe("Run SQL · SELECT 1")
	})
})

const feedWith = (everyBeat = false) =>
	Effect.gen(function* () {
		const writes: Array<InvestigationProgress> = []
		const feed = yield* makeProgressFeed({
			label: stepLabel,
			heartbeat: INVESTIGATION_PROGRESS_HEARTBEAT,
			everyBeat,
			write: (record) => Effect.sync(() => writes.push(record)),
		})
		yield* Effect.yieldNow
		return { feed, writes }
	})

/** Lets the feed's fiber run what a step or a clock move made ready. */
const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 3 }))

describe("makeProgressFeed", () => {
	/** The write that turns "gathering evidence" into a page saying what. */
	it.effect("writes the first step immediately", () =>
		Effect.gen(function* () {
			const { feed, writes } = yield* feedWith()
			assert.lengthOf(writes, 0)
			feed.step("search_logs", {})
			yield* settle
			assert.lengthOf(writes, 1)
			assert.deepEqual(
				writes[0]!.steps.map((step) => step.label),
				["Search logs"],
			)
		}),
	)

	it.effect("holds later steps for the beat, then writes them together", () =>
		Effect.gen(function* () {
			const { feed, writes } = yield* feedWith()
			feed.step("search_logs", {})
			yield* settle
			feed.step("find_errors", {})
			feed.step("inspect_trace", {})
			yield* settle
			assert.lengthOf(writes, 1)
			yield* TestClock.adjust(INVESTIGATION_PROGRESS_HEARTBEAT)
			assert.lengthOf(writes, 2)
			assert.equal(writes[1]!.stepCount, 3)
		}),
	)

	it.effect("writes nothing on a beat with no new step, unless asked to write every beat", () =>
		Effect.gen(function* () {
			const quiet = yield* feedWith()
			yield* TestClock.adjust(Duration.times(INVESTIGATION_PROGRESS_HEARTBEAT, 3))
			assert.lengthOf(quiet.writes, 0)
			const beating = yield* feedWith(true)
			yield* TestClock.adjust(Duration.times(INVESTIGATION_PROGRESS_HEARTBEAT, 2))
			assert.isAtLeast(beating.writes.length, 3)
		}),
	)

	/**
	 * Without the flush, a run that took four quick steps and stopped reports the
	 * first one forever, which is the shape of a stall rather than a finish.
	 */
	it.effect("flushes the steps the beat held, and writes nothing once closed", () =>
		Effect.gen(function* () {
			const { feed, writes } = yield* feedWith()
			feed.step("search_logs", {})
			yield* settle
			feed.step("find_errors", {})
			yield* feed.flush
			assert.equal(writes.at(-1)!.stepCount, 2)
			yield* feed.close
			feed.step("inspect_trace", {})
			yield* feed.flush
			yield* TestClock.adjust(Duration.times(INVESTIGATION_PROGRESS_HEARTBEAT, 3))
			assert.lengthOf(writes, 2)
		}),
	)

	it.effect("writes again after a resume, as when the report it paused for was refused", () =>
		Effect.gen(function* () {
			const { feed, writes } = yield* feedWith()
			yield* feed.pause
			feed.step("search_logs", {})
			yield* TestClock.adjust(Duration.times(INVESTIGATION_PROGRESS_HEARTBEAT, 2))
			assert.lengthOf(writes, 0)
			yield* feed.resume
			yield* TestClock.adjust(INVESTIGATION_PROGRESS_HEARTBEAT)
			assert.equal(writes.at(-1)!.stepCount, 1)
		}),
	)

	it.effect("gives up on a hung write instead of holding the permit", () =>
		Effect.gen(function* () {
			const feed = yield* makeProgressFeed({
				label: stepLabel,
				heartbeat: INVESTIGATION_PROGRESS_HEARTBEAT,
				everyBeat: false,
				write: () => Effect.never,
			})
			feed.step("search_logs", {})
			yield* settle
			const closed = yield* Effect.forkChild(feed.close)
			yield* TestClock.adjust(PROGRESS_WRITE_TIMEOUT)
			yield* Fiber.join(closed)
		}),
	)

	it.effect("retries a timed-out write rather than dropping its steps", () =>
		Effect.gen(function* () {
			const writes: Array<InvestigationProgress> = []
			const attempts = yield* Ref.make(0)
			const feed = yield* makeProgressFeed({
				label: stepLabel,
				heartbeat: INVESTIGATION_PROGRESS_HEARTBEAT,
				everyBeat: false,
				// The first write hangs; the retry lands.
				write: (record) =>
					Ref.getAndUpdate(attempts, (count) => count + 1).pipe(
						Effect.flatMap((count) =>
							count === 0 ? Effect.never : Effect.sync(() => writes.push(record)),
						),
					),
			})
			feed.step("search_logs", {})
			yield* settle
			yield* TestClock.adjust(PROGRESS_WRITE_TIMEOUT)
			yield* feed.flush
			assert.equal(writes.at(-1)?.stepCount, 1)
		}),
	)

	it.effect("keeps the tail bounded, counts past it, and dates the record by its newest step", () =>
		Effect.gen(function* () {
			const { feed, writes } = yield* feedWith()
			const total = INVESTIGATION_PROGRESS_STEPS + 5
			yield* Effect.forEach(
				Array.from({ length: total }, (_, index) => index),
				(index) =>
					TestClock.adjust(Duration.seconds(1)).pipe(
						Effect.andThen(Effect.sync(() => feed.step(`tool_${index}`, {}))),
					),
				{ discard: true },
			)
			yield* feed.flush
			const record = writes.at(-1)!
			assert.lengthOf(record.steps, INVESTIGATION_PROGRESS_STEPS)
			assert.equal(record.stepCount, total)
			assert.equal(record.updatedAt, record.steps.at(-1)!.at)
		}),
	)
})
