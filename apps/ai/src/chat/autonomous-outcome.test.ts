import { assert, describe, it } from "vitest"
import { makeAutonomousOutcome } from "./autonomous-outcome"

describe("makeAutonomousOutcome", () => {
	it("keeps an earlier phase's step limit in the final reason after a close-out reports", () => {
		const outcome = makeAutonomousOutcome()
		outcome.hold("max-steps")
		outcome.record("pass", false)
		outcome.hold("stop")
		outcome.record("close-out", true)

		assert.deepEqual(outcome.ending("no report"), { reason: "max-steps" })
		assert.strictEqual(outcome.failure(), "step_limit")
	})

	it("ends on stop when no phase hit the step limit", () => {
		const outcome = makeAutonomousOutcome()
		outcome.hold("stop")
		outcome.record("pass", true)

		assert.deepEqual(outcome.ending("no report"), { reason: "stop" })
		assert.strictEqual(outcome.failure(), undefined)
	})

	it("ends on the caller's error when no phase reported", () => {
		const outcome = makeAutonomousOutcome()
		outcome.record("pass", false, "model_error")
		outcome.record("close-out", false, "time_limit")

		assert.deepEqual(outcome.ending("no report"), { reason: "error", error: "no report" })
		// The first reason is the one the pull request is told.
		assert.strictEqual(outcome.failure(), "model_error")
	})

	it("discards the replaced attempt's failure once the pass restarts", () => {
		const outcome = makeAutonomousOutcome()
		outcome.record("pass", false, "stuck")
		outcome.hold("max-steps")
		outcome.record("restart", false)

		assert.strictEqual(outcome.failure(), "step_limit")
	})

	it("does not read a close-out's step limit as the pass's failure", () => {
		const outcome = makeAutonomousOutcome()
		outcome.hold("stop")
		outcome.record("pass", false)
		outcome.fail("answered_in_prose")
		outcome.hold("max-steps")
		outcome.record("close-out", false)

		assert.strictEqual(outcome.failure(), "answered_in_prose")
	})

	it("does not carry a held ending into the next phase", () => {
		const outcome = makeAutonomousOutcome()
		outcome.hold("max-steps")
		outcome.record("pass", false, "model_error")
		const next = outcome.record("close-out", true)

		assert.strictEqual(next.ending, undefined)
	})
})
