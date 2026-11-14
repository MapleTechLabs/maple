import type { Html, HtmlBuilder } from "foldkit/html"
import { click, Command, expect as expectView, given, Mount, role, scene, text } from "foldkit/scene"
import { describe, test } from "vitest"
import { agentSetupPrompt } from "../kit/onboard-skill"
import { ingestUrl } from "../../platform/ingest-url"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Tabs from "@maple/views/ui/tabs"
import { init, Message, type Model, update as updateWith } from "./quick-start"
import { DEFAULT_QUICK_START_STATE, type QuickStartState } from "./quick-start-state"
import { ConnectMessage, ReadSetupLink, SETUP_LINK_COPY } from "./quick-start-connect"
import { connectStep } from "./quick-start-view"

const update = (model: Model, message: Message) => updateWith(model, message, true)

const state: QuickStartState = {
	...DEFAULT_QUICK_START_STATE,
	activeStep: "connect",
	stack: { languages: ["nodejs"], platforms: [] },
}

const atConnect = (privateKey: string | null = "maple_sk_test"): Model => {
	const model = init("maple-onboarding-v6-org_1", false, false, "/", "org_1").model
	return {
		...model,
		state,
		connect: { ...model.connect, keys: { _tag: "Ready", privateKey, publicKey: "maple_pk_test" } },
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

	test("a member, who reads only the public key, gets it in the prompt and is told whom to ask", () => {
		scene(
			{ update, view },
			given(atConnect(null)),
			indicatorMeasured(),
			expectView(text(/^This is your org's public key\./)).toExist(),
			click(role("button", { name: "Build with your agent" })),
			Command.expectExact(
				CopyButton.WriteClipboard({
					text: agentSetupPrompt(ingestUrl, "maple_pk_test"),
					generation: 1,
				}),
			),
			Command.resolve(CopyButton.WriteClipboard, CopyButton.Message.SucceededCopy({ generation: 1 })),
			Command.resolve(
				CopyButton.WaitCopyStatus,
				CopyButton.Message.ElapsedCopyStatus({ generation: 1 }),
			),
		)
	})
})

describe("carry on from a computer", () => {
	// Shown at phone width only (CSS): the step is about code that lives on another machine.
	test("Copy link copies the quick start's own address, then says so", () => {
		const setupLink = "https://app.maple.dev/quick-start"
		scene(
			{ update, view },
			given(atConnect()),
			indicatorMeasured(),
			expectView(text(/takes the computer your code is on/)).toExist(),
			click(role("button", { name: "Copy link to this setup" })),
			Command.resolve(
				ReadSetupLink,
				ConnectMessage.GotSnippetCopyMessage({
					snippet: SETUP_LINK_COPY,
					message: CopyButton.Message.ClickedCopy({ text: setupLink }),
				}),
			),
			Command.expectExact(CopyButton.WriteClipboard({ text: setupLink, generation: 1 })),
			Command.resolve(CopyButton.WriteClipboard, CopyButton.Message.SucceededCopy({ generation: 1 })),
			expectView(role("button", { name: "Copy link to this setup" })).toHaveAttr(
				"data-copy-status",
				"copied",
			),
			Command.resolve(
				CopyButton.WaitCopyStatus,
				CopyButton.Message.ElapsedCopyStatus({ generation: 1 }),
			),
			expectView(role("button", { name: "Copy link to this setup" })).toHaveAttr(
				"data-copy-status",
				"idle",
			),
		)
	})
})
