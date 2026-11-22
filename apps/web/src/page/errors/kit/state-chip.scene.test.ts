import type { HtmlBuilder } from "foldkit/html"
import { expect, given, role, scene } from "foldkit/scene"
import { describe, test } from "vitest"
import type { InvestigationSummary } from "./error-signal"
import { investigationChip } from "./state-chip"

// The compact chip hides its label below the wide layout; the button must still be named.

type Message = "opened"

const config = {
	update: (model: InvestigationSummary, _message: Message) => ({ model }),
	view: (model: InvestigationSummary, h: HtmlBuilder<Message>) =>
		h.main(
			[],
			[
				investigationChip<Message>(h, model, {
					compact: true,
					withConfidence: true,
					onOpen: "opened",
				}),
			],
		),
}

describe("investigation chip", () => {
	test("a compact chip is a button named by its state and the confidence it shows", () => {
		scene(
			config,
			given({ id: "inv_1", status: "diagnosed", confidence: "high" }),
			expect(role("button", { name: "Open investigation: Diagnosed, high confidence" })).toExist(),
		)
	})

	test("a state that shows no confidence names only the state", () => {
		scene(
			config,
			given({ id: "inv_2", status: "inconclusive", confidence: null }),
			expect(role("button", { name: "Open investigation: Inconclusive" })).toExist(),
		)
	})
})
