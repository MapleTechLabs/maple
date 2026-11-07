import type { Html, HtmlBuilder } from "foldkit/html"
import { click, Command, expect as expectView, given, Mount, role, scene, text } from "foldkit/scene"
import { Result } from "effect"
import { describe, test } from "vitest"
import * as Tabs from "@maple/views/ui/tabs"
import { init, Message, type Model, update as updateWith } from "./quick-start"
import { ConnectMessage, LoadConnectPresence, SendTestTrace } from "./quick-start-connect"
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
		connect: {
			...model.connect,
			keys: { _tag: "Ready", privateKey: "maple_sk_test", publicKey: "maple_pk_test" },
		},
	}
}

const view = (model: Model, h: HtmlBuilder<Message>): Html => connectStep(h, model, state)

const indicatorMeasured = () =>
	Mount.resolve<string, Tabs.Message>(
		Tabs.MeasureTabIndicator,
		Tabs.Message.MeasuredIndicator({
			rect: { left: 0, right: 120, top: 0, bottom: 2, width: 120, height: 2 },
		}),
	)

describe("send test trace", () => {
	test("sends one span with the org's key, then says where it will show up", () => {
		scene(
			{ update, view },
			given(atConnect()),
			indicatorMeasured(),
			click(role("button", { name: "Send test trace" })),
			Command.expectHas(SendTestTrace({ apiKey: "maple_sk_test" })),
			Command.resolve(SendTestTrace, ConnectMessage.SucceededSendTestTrace()),
			// It reads what is arriving at once instead of waiting for the next poll.
			Command.resolve(
				LoadConnectPresence,
				ConnectMessage.LoadedPresence({ result: Result.succeed({}) }),
			),
			expectView(text(/^Sent as maple-test\. It reaches Maple within a minute/)).toExist(),
			expectView(role("button", { name: "Send another" })).toExist(),
		)
	})

	test("a rejected key shows what ingest said, which names the other region", () => {
		const message =
			"Invalid ingest key. Keys are region-specific: if your Maple org is in the EU, send to https://ingest.eu.maple.dev."
		scene(
			{ update, view },
			given(atConnect()),
			indicatorMeasured(),
			click(role("button", { name: "Send test trace" })),
			Command.resolve(SendTestTrace, ConnectMessage.FailedSendTestTrace({ message })),
			expectView(role("alert")).toHaveText(message),
			expectView(role("button", { name: "Send test trace" })).not.toBeDisabled(),
		)
	})
})
