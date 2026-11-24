import { ModelProtocolError } from "@yielded/agent/agent-error"
import { Duration, Effect, Array as Arr, String as Str } from "effect"
import { assert, describe, it } from "vitest"
import { AGENTS, type RowMode } from "./agents"
import { makeAutonomousOutcome } from "./autonomous-outcome"
import { CLOSE_OUT_MAX_DURATION } from "./budgets"
import { type PhaseTurn, runAutonomousPhases } from "./autonomous-phases"

/** What the engine raises when a 200 stream ends on the provider's `error` part. */
const PROVIDER_500 = ModelProtocolError.make({
	message: "Model response failed: The server had an error while processing your request.",
})

/** What the engine raises when the provider streams a tool call before its parameters end. */
const CUT_SHORT_CALL = ModelProtocolError.make({
	message: "Model response declared Tool Call call-1 before its parameters completed",
})

/** Runs the phases over a scripted run: each phase files when `files` says so, and ends on `stop`. */
const phasesOf = (
	mode: RowMode,
	files: (turn: PhaseTurn, index: number) => boolean,
	fails: (index: number) => boolean = () => false,
	failure: ModelProtocolError = PROVIDER_500,
) => {
	const outcome = makeAutonomousOutcome()
	const turns: Array<PhaseTurn> = []
	const run = (turn: PhaseTurn) =>
		Effect.suspend(() => {
			turns.push(turn)
			const index = turns.length - 1
			if (fails(index)) return Effect.fail(failure)
			outcome.hold("stop")
			return Effect.succeed({ submitted: files(turn, index), compactions: 0 })
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

	it("runs an investigation's close-out on its own short clock, not the pass's", async () => {
		const { turns } = await phasesOf("investigate", (turn) => turn.closeOut === true)
		const clock = (turn: PhaseTurn | undefined) =>
			turn?.agent === undefined ? undefined : Duration.toMillis(turn.agent.budget.maxDuration)
		assert.strictEqual(
			clock(turns[1]),
			Duration.toMillis(Duration.fromInputUnsafe(CLOSE_OUT_MAX_DURATION)),
		)
		assert.isBelow(
			clock(turns[1]) ?? Infinity,
			Duration.toMillis(Duration.fromInputUnsafe(AGENTS.investigate.budget.maxDuration)),
		)
	})

	it("closes a reply out without a continuation, which only a review has", async () => {
		const { turns } = await phasesOf("pr-reply", () => false)
		assert.deepEqual(
			Arr.map(turns, (turn) => turn.closeOut === true),
			[false, true],
		)
	})

	it("resumes a review a provider error cut short, which then files", async () => {
		const { outcome, turns } = await phasesOf(
			"pr-review",
			(_, index) => index === 1,
			(index) => index === 0,
		)
		assert.lengthOf(turns, 2)
		assert.notStrictEqual(turns[1]?.closeOut, true, "the second run is the resume, not the close-out")
		assert.isTrue(
			Str.startsWith(AGENTS["pr-review"].completion.resumePrompt ?? "-")(turns[1]?.text ?? ""),
		)
		assert.include(turns[1]?.text ?? "", "kickoff")
		assert.isDefined(turns[1]?.agent, "a resume runs on what is left of the pass's clock")
		assert.isTrue(outcome.submitted())
	})

	it("resumes a review a malformed tool call cut short, which then files", async () => {
		const { outcome, turns } = await phasesOf(
			"pr-review",
			(_, index) => index === 1,
			(index) => index === 0,
			CUT_SHORT_CALL,
		)
		assert.lengthOf(turns, 2)
		assert.isTrue(
			Str.startsWith(AGENTS["pr-review"].completion.resumePrompt ?? "-")(turns[1]?.text ?? ""),
		)
		assert.isTrue(outcome.submitted())
	})

	it("resumes only once, then closes out with the provider as the reason", async () => {
		const { outcome, turns } = await phasesOf(
			"pr-review",
			(turn) => turn.closeOut === true,
			(index) => index < 2,
		)
		assert.deepEqual(
			Arr.map(turns, (turn) => turn.closeOut === true),
			[false, false, true],
		)
		assert.equal(outcome.failure(), "provider_unavailable")
	})

	it("closes an investigation out after a provider error, with no resume", async () => {
		const { turns } = await phasesOf(
			"investigate",
			(turn) => turn.closeOut === true,
			(index) => index === 0,
		)
		assert.deepEqual(
			Arr.map(turns, (turn) => turn.closeOut === true),
			[false, true],
		)
	})

	it("resumes a review whose prose continuation a provider error cut short", async () => {
		const { outcome, turns } = await phasesOf(
			"pr-review",
			(turn) => turn.closeOut === true,
			(index) => index === 1,
		)
		const prompts = AGENTS["pr-review"].completion
		assert.deepEqual(
			Arr.map(turns, (turn) => Str.slice(0, 40)(turn.text)),
			Arr.map(
				["kickoff", prompts.continuePrompt ?? "", prompts.resumePrompt ?? "", prompts.closeOutPrompt],
				Str.slice(0, 40),
			),
		)
		assert.equal(outcome.failure(), "provider_unavailable")
	})
})
