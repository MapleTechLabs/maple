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
})
