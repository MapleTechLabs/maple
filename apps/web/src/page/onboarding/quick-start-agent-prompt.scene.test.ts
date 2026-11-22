import type { Html, HtmlBuilder } from "foldkit/html"
import { click, Command, expect as expectView, given, Mount, role, scene, text } from "foldkit/scene"
import { describe, expect, test } from "vitest"
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

const PROMPT = agentSetupPrompt(ingestUrl, "maple_pk_test")

describe("use my coding agent", () => {
	test("Copy prompt copies the guide URL, the endpoint and the public key, then says so", () => {
		expect(PROMPT).toContain("https://maple.dev/SKILL.md")
		expect(PROMPT).toContain("Public ingest key: maple_pk_test")
		scene(
			{ update, view },
			given(atConnect()),
			indicatorMeasured(),
			expectView(role("tab", { name: "Use my coding agent" })).toHaveAttr("aria-selected", "true"),
			expectView(text(/maple_sk_test/)).not.toExist(),
			click(role("button", { name: "Copy prompt" })),
			Command.expectExact(CopyButton.WriteClipboard({ text: PROMPT, generation: 1 })),
			Command.resolve(CopyButton.WriteClipboard, CopyButton.Message.SucceededCopy({ generation: 1 })),
			expectView(role("button", { name: "Copy prompt" })).toHaveAttr("data-copy-status", "copied"),
			Command.resolve(
				CopyButton.WaitCopyStatus,
				CopyButton.Message.ElapsedCopyStatus({ generation: 1 }),
			),
		)
	})

	test("a member, who reads only the public key, gets the same prompt and is told whom to ask", () => {
		scene(
			{ update, view },
			given(atConnect(null)),
			indicatorMeasured(),
			expectView(text(/^This is your org's public key\./)).toExist(),
			click(role("button", { name: "Copy prompt" })),
			Command.expectExact(CopyButton.WriteClipboard({ text: PROMPT, generation: 1 })),
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
