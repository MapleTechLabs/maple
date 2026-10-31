import { AgentPolicyError } from "@yielded/agent/agent-error"
import { Effect, Layer, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { assert, describe, it } from "vitest"
import { answeringWhenWarned, childFailureMessage, fanoutTimeRefusal } from "./review-fanout"

describe("fanoutTimeRefusal", () => {
	it("starts a group with time for the child and the parent's submit", () => {
		assert.isUndefined(fanoutTimeRefusal(10 * 60_000))
		assert.isUndefined(fanoutTimeRefusal(5.75 * 60_000))
	})

	// The engine does not stop a child at the parent's deadline: a late start loses its findings.
	it("refuses a group that could not finish before the review is stopped", () => {
		const late = fanoutTimeRefusal(5 * 60_000)
		assert.include(late ?? "", "300 s are left")
		assert.isDefined(fanoutTimeRefusal(5.4 * 60_000), "a child joins up to 15 s past its own clock")
		assert.include(late ?? "", "pr_file_diff")
		assert.include(fanoutTimeRefusal(-1_000) ?? "", "0 s are left")
	})
})

describe("childFailureMessage", () => {
	it("tells the parent a child that ran out of time left the group unread, and what to do", () => {
		const message = childFailureMessage(
			AgentPolicyError.make({ limit: "duration", message: "Agent exceeded its 4m duration limit" }),
		)
		assert.include(message, "ran out of its 4m")
		assert.include(message, "pr_file_diff")
	})

	it("names the failure of a child that failed some other way", () => {
		const message = childFailureMessage(
			AgentPolicyError.make({ limit: "tool-calls", message: "too many" }),
		)
		assert.include(message, "AgentPolicyError: too many")
		assert.notInclude(message, "ran out of")
	})
})

describe("answeringWhenWarned", () => {
	const toolChoiceFor = (prompt: Prompt.RawInput) => {
		const seen: Array<unknown> = []
		const model = Layer.effect(
			LanguageModel.LanguageModel,
			LanguageModel.make({
				generateText: () => Effect.succeed([]),
				streamText: (options) => {
					seen.push(options.toolChoice)
					return Stream.empty
				},
			}),
		)
		const toolkit = Toolkit.make(Tool.make("pr_file_diff"))
		return LanguageModel.streamText({
			prompt,
			toolkit,
			toolChoice: "auto",
			disableToolCallResolution: true,
		}).pipe(
			Stream.runDrain,
			Effect.provide(answeringWhenWarned(model)),
			Effect.as(seen),
			Effect.runPromise,
		)
	}
	const withStatus = (status: string) =>
		Prompt.make([
			{ role: "user", content: "Review src/a.ts." },
			{ role: "user", content: [{ type: "text", text: status }] },
		])

	it("makes the child answer once its run status warns it to deliver", async () => {
		const seen = await toolChoiceFor(
			withStatus(
				"<run-status>turn 9/100 · elapsed 193s/240s · WARNING: approaching limits — converge and deliver your final result now.</run-status>",
			),
		)
		assert.deepStrictEqual(seen, ["none"])
	})

	it("leaves a child inside its limits free to call tools", async () => {
		const seen = await toolChoiceFor(withStatus("<run-status>turn 2/100 · elapsed 40s/240s</run-status>"))
		assert.deepStrictEqual(seen, ["auto"])
	})
})
