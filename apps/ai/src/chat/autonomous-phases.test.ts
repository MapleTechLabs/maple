import { Effect, Array as Arr } from "effect"
import { assert, describe, it } from "vitest"
import { AGENTS, type RowMode } from "./agents"
import { makeAutonomousOutcome } from "./autonomous-outcome"
import { type PhaseTurn, runAutonomousPhases } from "./autonomous-phases"

/** Runs the phases over a scripted run: each phase files when `files` says so, and ends on `stop`. */
const phasesOf = (mode: RowMode, files: (turn: PhaseTurn, index: number) => boolean) => {
	const outcome = makeAutonomousOutcome()
	const turns: Array<PhaseTurn> = []
	const run = (turn: PhaseTurn) =>
		Effect.sync(() => {
			turns.push(turn)
			outcome.hold("stop")
			return { submitted: files(turn, turns.length - 1), compactions: 0 }
		})
	const agent = AGENTS[mode]
	return Effect.runPromise(
		runAutonomousPhases({
			agent,
			completion: agent.completion,
			text: "kickoff",
			prior: [],
			outcome,
			holdsTurn: () => true,
			transcript: () => [],
			run,
			ownKey: false,
		}),
	).then(() => ({ outcome, turns }))
}

describe("runAutonomousPhases", () => {
	it("ends after the pass when the pass files", async () => {
		const { outcome, turns } = await phasesOf("investigate", () => true)
		assert.lengthOf(turns, 1)
		assert.isTrue(outcome.submitted())
	})

	it("closes an investigation out with its own prompt, with no continuation", async () => {
		const { outcome, turns } = await phasesOf("investigate", (turn) => turn.closeOut === true)
		assert.deepEqual(
			Arr.map(turns, (turn) => turn.text),
			["kickoff", AGENTS.investigate.completion.closeOutPrompt],
		)
		assert.isTrue(outcome.submitted())
	})

	it("continues a review that answered in prose, then closes it out with the reason", async () => {
		const { outcome, turns } = await phasesOf("pr-review", () => false)
		assert.lengthOf(turns, 3)
		assert.include(turns[1]?.text ?? "", "kickoff")
		assert.isDefined(turns[1]?.agent, "a continuation runs on what is left of the pass's clock")
		assert.isTrue(turns[2]?.closeOut)
		assert.equal(turns[2]?.text, AGENTS["pr-review"].completion.closeOutPrompt)
		assert.equal(outcome.failure(), "answered_in_prose")
		assert.isFalse(outcome.submitted())
	})

	it("closes a reply out without a continuation, which only a review has", async () => {
		const { turns } = await phasesOf("pr-reply", () => false)
		assert.deepEqual(
			Arr.map(turns, (turn) => turn.closeOut === true),
			[false, true],
		)
	})
})
