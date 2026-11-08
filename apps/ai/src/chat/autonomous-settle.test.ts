import type { ChatAbortReason } from "@maple/domain/chat-session-stub"
import type { PrReviewFailureReason } from "@maple/domain/http"
import { Deferred, Effect, Fiber } from "effect"
import { assert, describe, it } from "vitest"
import { makeAutonomousOutcome } from "./autonomous-outcome"
import { NO_DIAGNOSIS_INTERRUPTED, makeUnfinishedSettler, runAutonomousTurn } from "./autonomous-settle"
import { interruptOnAbort, makeTurnObservability } from "./turn-outcome"

/** A turn that owns all three rows, recording every write that marks one failed. */
const harness = () => {
	const controller = new AbortController()
	const outcome = makeAutonomousOutcome()
	const observability = makeTurnObservability()
	const writes: Array<string> = []
	const settler = makeUnfinishedSettler({
		outcome,
		signal: controller.signal,
		observability,
		rows: {
			failInvestigation: (error: string) =>
				Effect.sync(() => void writes.push(`investigation:${error}`)),
			failReply: Effect.sync(() => void writes.push("reply")),
			failReview: (reason: PrReviewFailureReason) =>
				Effect.sync(() => void writes.push(`review:${reason}`)),
		},
	})
	let holds = true
	const settle = settler.failUnfinished("no_report", "no diagnosis")
	return {
		outcome,
		observability,
		writes,
		release: () => {
			holds = false
		},
		abort: (reason: ChatAbortReason) => controller.abort(reason),
		/** The runner's wiring: the turn is interrupted when the session aborts it. */
		turn: (phases: Effect.Effect<void>, settleWith: Effect.Effect<void> = settle) =>
			runAutonomousTurn({
				phases,
				settle: settleWith,
				aborted: settler.aborted,
				holdsTurn: () => holds,
			}).pipe(interruptOnAbort(controller.signal, observability)),
	}
}

const INTERRUPTED_ROWS = [`investigation:${NO_DIAGNOSIS_INTERRUPTED}`, "reply", "review:interrupted"]

describe("runAutonomousTurn", () => {
	it("marks every row interrupted when the user aborts mid-phase", async () => {
		const turn = harness()
		const started = Deferred.makeUnsafe<void>()
		const fiber = Effect.runFork(
			turn.turn(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))),
		)
		await Effect.runPromise(Deferred.await(started))

		turn.abort("user")
		await Effect.runPromise(Fiber.await(fiber))

		assert.deepEqual(turn.writes, INTERRUPTED_ROWS)
	})

	it("leaves the rows alone when a newer commit supersedes the review", async () => {
		const turn = harness()
		const started = Deferred.makeUnsafe<void>()
		const fiber = Effect.runFork(
			turn.turn(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))),
		)
		await Effect.runPromise(Deferred.await(started))

		turn.abort("superseded")
		await Effect.runPromise(Fiber.await(fiber))

		assert.deepEqual(turn.writes, [])
	})

	it("marks the rows interrupted when the slot expired between phases", async () => {
		const turn = harness()

		await Effect.runPromise(turn.turn(Effect.sync(() => turn.release())))

		assert.deepEqual(turn.writes, INTERRUPTED_ROWS)
		assert.strictEqual(turn.observability.outcome, "aborted")
	})

	it("settles a turn that still holds its slot with its own failure, not as interrupted", async () => {
		const turn = harness()

		await Effect.runPromise(turn.turn(Effect.void))

		assert.deepEqual(turn.writes, ["investigation:no diagnosis", "reply", "review:no_report"])
		assert.strictEqual(turn.observability.outcome, undefined)
	})

	it("writes nothing for a turn whose report landed before the abort", async () => {
		const turn = harness()
		turn.outcome.record("pass", true)

		await Effect.runPromise(turn.turn(Effect.sync(() => turn.release())))

		assert.deepEqual(turn.writes, [])
	})

	it("finishes settling once when an abort arrives mid-settle", async () => {
		const turn = harness()
		const settling = Deferred.makeUnsafe<void>()
		const proceed = Deferred.makeUnsafe<void>()
		const settle = Deferred.succeed(settling, undefined).pipe(
			Effect.andThen(Deferred.await(proceed)),
			Effect.andThen(Effect.sync(() => void turn.writes.push("settled"))),
		)
		const fiber = Effect.runFork(turn.turn(Effect.void, settle))
		await Effect.runPromise(Deferred.await(settling))

		turn.abort("user")
		await Effect.runPromise(Deferred.succeed(proceed, undefined))
		await Effect.runPromise(Fiber.await(fiber))

		assert.deepEqual(turn.writes, ["settled"])
	})
})
