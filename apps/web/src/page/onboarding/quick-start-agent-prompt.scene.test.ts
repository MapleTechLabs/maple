import type { Html, HtmlBuilder } from "foldkit/html"
import { click, Command, expect as expectView, given, Mount, role, scene, text } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { agentSetupPrompt } from "../kit/onboard-skill"
import { ingestUrl } from "../../platform/ingest-url"
import { apiPublicUrl } from "../../platform/api-base-url"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Tabs from "@maple/views/ui/tabs"
import { init, Message, type Model, update as updateWith } from "./quick-start"
import { DEFAULT_QUICK_START_STATE, type QuickStartState } from "./quick-start-state"
import { ConnectMessage, ReadSetupLink, SETUP_LINK_COPY } from "./quick-start-connect"
import { connectStep } from "./quick-start-view"
import * as AgentHandoff from "../kit/agent-handoff"
import { labHandoff } from "../../lab/onboarding-agent-fixture"

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
const HANDOFF = labHandoff()
const PROMPT_WITH_CODE = agentSetupPrompt(ingestUrl, "maple_pk_test", {
	code: HANDOFF.handoff_code,
	apiUrl: apiPublicUrl,
})

/** Every copy is tracked with whether it carried a handoff code. */
const copyTracked = (hasHandoffCode: boolean) =>
	Command.resolve(
		AgentHandoff.TrackAgentEvent({
			event: "onboarding_agent_prompt_copied",
			surface: "connect_step",
			hasHandoffCode,
		}),
		AgentHandoff.Message.CompletedTrack(),
	)

const copySettled = (generation: number) => [
	Command.resolve(CopyButton.WriteClipboard, CopyButton.Message.SucceededCopy({ generation })),
	Command.resolve(CopyButton.WaitCopyStatus, CopyButton.Message.ElapsedCopyStatus({ generation })),
]

describe("use my coding agent", () => {
	test("the prompt shows the handoff line masked until Copy prompt asks for a code", () => {
		scene(
			{ update, view },
			given(atConnect()),
			indicatorMeasured(),
			expectView(role("tab", { name: "Use my coding agent" })).toHaveAttr("aria-selected", "true"),
			expectView(text(/Handoff code \(single use, 1 hour\): ••••••••••/)).toExist(),
			expectView(text(/maple_ho_/)).not.toExist(),
			expectView(text(/maple_sk_test/)).not.toExist(),
		)
	})

	test("Copy prompt mints a handoff, then copies the prompt with its code and never the private key", () => {
		expect(PROMPT_WITH_CODE).toContain("Handoff code (single use, 1 hour): maple_ho_")
		expect(PROMPT_WITH_CODE).not.toContain("maple_sk_")
		scene(
			{ update, view },
			given(atConnect()),
			indicatorMeasured(),
			click(role("button", { name: "Copy prompt" })),
			Command.expectExact(AgentHandoff.MintHandoff({ publicKey: "maple_pk_test" })),
			Command.resolve(
				AgentHandoff.MintHandoff,
				AgentHandoff.Message.SucceededMint({
					publicKey: "maple_pk_test",
					handoff: HANDOFF,
					clipboard: "not_attempted",
				}),
			),
			Command.expectHas(CopyButton.WriteClipboard({ text: PROMPT_WITH_CODE, generation: 1 })),
			copyTracked(true),
			Command.resolve(CopyButton.WriteClipboard, CopyButton.Message.SucceededCopy({ generation: 1 })),
			expectView(role("button", { name: "Copy prompt" })).toHaveAttr("data-copy-status", "copied"),
			// The copy started a run: its progress shows under the prompt.
			expectView(text(/^Waiting for your agent to sign in\./)).toExist(),
			// The page keeps the code masked; it lives only on the clipboard.
			expectView(text(/maple_ho_/)).not.toExist(),
			Command.resolve(
				CopyButton.WaitCopyStatus,
				CopyButton.Message.ElapsedCopyStatus({ generation: 1 }),
			),
		)
	})

	test("a failed mint copies the prompt without a code and says progress tracking is unavailable", () => {
		scene(
			{ update, view },
			given(atConnect()),
			indicatorMeasured(),
			click(role("button", { name: "Copy prompt" })),
			Command.resolve(
				AgentHandoff.MintHandoff,
				AgentHandoff.Message.FailedMint({ publicKey: "maple_pk_test", clipboard: "not_attempted" }),
			),
			Command.expectHas(CopyButton.WriteClipboard({ text: PROMPT, generation: 1 })),
			copyTracked(false),
			...copySettled(1),
			expectView(text(/progress tracking is unavailable/)).toExist(),
			expectView(text("Agent progress")).not.toExist(),
		)
	})

	test("an org in the control arm copies the prompt without a code, with no masked line or note", () => {
		const control = atConnect()
		scene(
			{ update, view },
			given({
				...control,
				connect: { ...control.connect, agent: { ...control.connect.agent, arm: "control" } },
			}),
			indicatorMeasured(),
			expectView(text(/Handoff code/)).not.toExist(),
			click(role("button", { name: "Copy prompt" })),
			Command.resolve(
				AgentHandoff.MintHandoff,
				AgentHandoff.Message.SkippedMint({ publicKey: "maple_pk_test", clipboard: "not_attempted" }),
			),
			Command.expectHas(CopyButton.WriteClipboard({ text: PROMPT, generation: 1 })),
			copyTracked(false),
			...copySettled(1),
			expectView(text(/progress tracking is unavailable/)).not.toExist(),
			expectView(text("Agent progress")).not.toExist(),
		)
	})

	test("a refused clipboard offers the prompt to copy by hand", () => {
		scene(
			{ update, view },
			given(atConnect()),
			indicatorMeasured(),
			click(role("button", { name: "Copy prompt" })),
			Command.resolve(
				AgentHandoff.MintHandoff,
				AgentHandoff.Message.SucceededMint({
					publicKey: "maple_pk_test",
					handoff: HANDOFF,
					clipboard: "not_attempted",
				}),
			),
			copyTracked(true),
			Command.resolve(CopyButton.WriteClipboard, CopyButton.Message.FailedCopy({ generation: 1 })),
			Command.resolve(
				CopyButton.WaitCopyStatus,
				CopyButton.Message.ElapsedCopyStatus({ generation: 1 }),
			),
			expectView(role("textbox", { name: "Setup prompt" })).not.toExist(),
			click(role("button", { name: "Show prompt" })),
			expectView(role("textbox", { name: "Setup prompt" })).toHaveValue(PROMPT_WITH_CODE),
		)
	})

	test("a copy the click already wrote (Safari's path) shows as copied with no second write", () => {
		scene(
			{ update, view },
			given(atConnect()),
			indicatorMeasured(),
			click(role("button", { name: "Copy prompt" })),
			Command.resolve(
				AgentHandoff.MintHandoff,
				AgentHandoff.Message.SucceededMint({
					publicKey: "maple_pk_test",
					handoff: HANDOFF,
					clipboard: "written",
				}),
			),
			copyTracked(true),
			expectView(role("button", { name: "Copy prompt" })).toHaveAttr("data-copy-status", "copied"),
			Command.resolve(
				CopyButton.WaitCopyStatus,
				CopyButton.Message.ElapsedCopyStatus({ generation: 1 }),
			),
		)
	})

	test("a write the browser refused in the click offers the prompt to copy by hand", () => {
		scene(
			{ update, view },
			given(atConnect()),
			indicatorMeasured(),
			click(role("button", { name: "Copy prompt" })),
			Command.resolve(
				AgentHandoff.MintHandoff,
				AgentHandoff.Message.SucceededMint({
					publicKey: "maple_pk_test",
					handoff: HANDOFF,
					clipboard: "refused",
				}),
			),
			copyTracked(true),
			Command.resolve(
				CopyButton.WaitCopyStatus,
				CopyButton.Message.ElapsedCopyStatus({ generation: 1 }),
			),
			click(role("button", { name: "Show prompt" })),
			expectView(role("textbox", { name: "Setup prompt" })).toHaveValue(PROMPT_WITH_CODE),
		)
	})

	test("a member, who reads only the public key, gets the same prompt and is told whom to ask", () => {
		scene(
			{ update, view },
			given(atConnect(null)),
			indicatorMeasured(),
			expectView(text(/^This is your org's public key\./)).toExist(),
			click(role("button", { name: "Copy prompt" })),
			Command.resolve(
				AgentHandoff.MintHandoff,
				AgentHandoff.Message.SucceededMint({
					publicKey: "maple_pk_test",
					handoff: HANDOFF,
					clipboard: "not_attempted",
				}),
			),
			Command.expectHas(CopyButton.WriteClipboard({ text: PROMPT_WITH_CODE, generation: 1 })),
			copyTracked(true),
			...copySettled(1),
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
