import type { Html, HtmlBuilder } from "foldkit/html"
import { click, Command, expect as expectView, given, Mount, role, scene } from "foldkit/scene"
import { describe, test } from "vitest"
import { agentSetupPrompt } from "../../components/ingest/onboard-skill"
import { ingestUrl } from "../../lib/services/common/ingest-url"
import * as CopyButton from "../../ui/copy-button"
import * as Tabs from "../../ui/tabs"
import { init, Message, type Model, update as updateWith } from "./quick-start"
import { DEFAULT_QUICK_START_STATE, type QuickStartState } from "./quick-start-state"
import { connectStep } from "./quick-start-view"

const update = (model: Model, message: Message) => updateWith(model, message, true)

const state: QuickStartState = {
	...DEFAULT_QUICK_START_STATE,
	activeStep: "connect",
	stack: { languages: ["nodejs"], platforms: [] },
}

const atConnect = (): Model => {
	const model = init("maple-onboarding-v6-org_1", false, false, "/", "org_1").model
	return {
		...model,
		state,
		connect: { ...model.connect, keys: { _tag: "Ready", privateKey: "maple_sk_test" } },
	}
}

const view = (model: Model, h: HtmlBuilder<Message>): Html => connectStep(h, model, state)

/** The setup tabs measure their indicator once they mount. */
const indicatorMeasured = () =>
	Mount.resolve<string, Tabs.Message>(
		Tabs.MeasureTabIndicator,
		Tabs.Message.MeasuredIndicator({
			rect: { left: 0, right: 120, top: 0, bottom: 2, width: 120, height: 2 },
		}),
	)

describe("build with your agent", () => {
	test("copies the setup prompt with the org's endpoint and key, then says so", () => {
		scene(
			{ update, view },
			given(atConnect()),
			indicatorMeasured(),
			click(role("button", { name: "Build with your agent" })),
			Command.expectExact(
				CopyButton.WriteClipboard({
					text: agentSetupPrompt(ingestUrl, "maple_sk_test"),
					generation: 1,
				}),
			),
			Command.resolve(CopyButton.WriteClipboard, CopyButton.Message.SucceededCopy({ generation: 1 })),
			expectView(role("button", { name: "Prompt copied" })).toHaveAttr("data-copy-state", "copied"),
			Command.resolve(
				CopyButton.WaitCopyStatus,
				CopyButton.Message.ElapsedCopyStatus({ generation: 1 }),
			),
			expectView(role("button", { name: "Build with your agent" })).toHaveAttr(
				"data-copy-state",
				"idle",
			),
		)
	})
})
