import { Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import { describe, expect, test } from "vitest"
import * as RuleMessage from "../page/settings/ingest-rule/message"
import { init, Message, update } from "./ingest-rule-lab"

describe("ingest rule lab", () => {
	test("answers a new preview request from its fixtures", () => {
		const { model } = init({ state: "parse-json" })
		const next = update(
			model,
			Message.GotPageMessage({
				message: RuleMessage.Message.PickedPreviewService({ service: "checkout" }),
			}),
		).model
		expect(AsyncData.isSuccess(next.page.samples)).toBe(true)
	})

	test("answers a request that reuses the last request's key", () => {
		const { model } = init({ state: "parse-json" })
		const next = Arr.reduce(
			[
				RuleMessage.Message.PickedAction({ actionType: "drop" }),
				RuleMessage.Message.ToggledSignal({ signal: "metrics" }),
				RuleMessage.Message.ToggledSignal({ signal: "logs" }),
				RuleMessage.Message.ToggledSignal({ signal: "logs" }),
			],
			model,
			(current, message) => update(current, Message.GotPageMessage({ message })).model,
		)
		expect(AsyncData.isSuccess(next.page.samples)).toBe(true)
	})
})
