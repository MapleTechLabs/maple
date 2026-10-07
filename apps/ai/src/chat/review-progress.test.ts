import { assert, describe, it } from "@effect/vitest"
import { PrReviewFinding, type PrReviewProgress } from "@maple/domain/http"
import { Duration, Effect } from "effect"
import { TestClock } from "effect/testing"
import type { ReviewCoverage } from "./review-coverage"
import type { ReviewLedger } from "./review-ledger"
import { makeReviewProgressFeed, REVIEW_PROGRESS_HEARTBEAT } from "./review-progress"

const coverage: ReviewCoverage = {
	observe: () => {},
	unread: () => ["b.ts"],
	counts: () => ({ due: 2, read: 1 }),
}

const ledger = (severities: ReadonlyArray<PrReviewFinding["severity"]>): ReviewLedger => ({
	record: () => "recorded",
	findings: () =>
		severities.map(
			(severity, index) =>
				new PrReviewFinding({
					path: "src/a.ts",
					line: index + 1,
					category: "correctness",
					severity,
					title: `Finding ${index}`,
					body: "",
				}),
		),
})

const feedWith = (findings: ReadonlyArray<PrReviewFinding["severity"]> = []) =>
	Effect.gen(function* () {
		const writes: Array<PrReviewProgress> = []
		const feed = yield* makeReviewProgressFeed({
			coverage,
			ledger: ledger(findings),
			write: (progress) => Effect.sync(() => writes.push(progress)),
		})
		// Let the forked heartbeat take its first beat.
		yield* Effect.yieldNow
		return { feed, writes }
	})

describe("makeReviewProgressFeed", () => {
	it.effect("writes on the beat while no tool call arrives, with a fresh time each time", () =>
		Effect.gen(function* () {
			const { writes } = yield* feedWith()
			assert.equal(writes.length, 1)
			yield* TestClock.adjust(Duration.sum(REVIEW_PROGRESS_HEARTBEAT, REVIEW_PROGRESS_HEARTBEAT))
			assert.equal(writes.length, 3)
			assert.equal(
				writes[2]!.updatedAt - writes[2]!.startedAt,
				Duration.toMillis(REVIEW_PROGRESS_HEARTBEAT) * 2,
			)
		}),
	)

	it.effect("shows steps, files and findings, and publishes only file arguments", () =>
		Effect.gen(function* () {
			const { feed, writes } = yield* feedWith(["critical", "warn", "warn"])
			feed.step("sandbox_grep", { pattern: "user@example.com" })
			feed.step("pr_file_diff", { paths: ["a.ts", "b.ts"] })
			yield* Effect.yieldNow
			yield* TestClock.adjust(REVIEW_PROGRESS_HEARTBEAT)
			const last = writes.at(-1)!
			assert.equal(last.stepCount, 2)
			assert.deepEqual(
				last.steps.map((step) => step.label),
				["Sandbox grep", "Pr file diff · a.ts +1"],
			)
			assert.deepEqual(last.findings, { critical: 1, warn: 2, info: 0 })
			assert.equal(last.filesDue, 2)
			assert.equal(last.filesRead, 1)
		}),
	)

	it.effect("says the close-out started right away, and writes nothing once closed", () =>
		Effect.gen(function* () {
			const { feed, writes } = yield* feedWith()
			yield* feed.closingOut
			assert.isTrue(writes.at(-1)!.closingOut)
			const before = writes.length
			yield* feed.close
			yield* feed.closingOut
			yield* TestClock.adjust(Duration.times(REVIEW_PROGRESS_HEARTBEAT, 3))
			assert.equal(writes.length, before)
		}),
	)
})
