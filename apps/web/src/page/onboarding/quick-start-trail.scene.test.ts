import type { Html, HtmlBuilder } from "foldkit/html"
import { click, Command, expect as expectView, given, Mount, role, scene } from "foldkit/scene"
import { describe, test } from "vitest"
import {
	init,
	Message,
	type Model,
	MountDitherField,
	SaveQuickStartState,
	update as updateWith,
} from "./quick-start"
import * as Tabs from "@maple/views/ui/tabs"
import { DEFAULT_QUICK_START_STATE } from "./quick-start-state"
import * as QuickStartView from "./quick-start-view"

const update = (model: Model, message: Message) => updateWith(model, message, true)

const atConnect = (): Model => ({
	...init("maple-onboarding-v6-org_1", false, false).model,
	state: {
		...DEFAULT_QUICK_START_STATE,
		activeStep: "connect",
		completedSteps: { plan: true, stack: true },
		stack: { languages: ["nodejs", "python"], platforms: [] },
	},
})

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	QuickStartView.view(h, model, {
		timeZone: "UTC",
		accountCluster: (label) => label,
		teamStep: () => h.empty,
		planStep: h.empty,
		needsRegion: false,
		hasPlan: true,
		orgName: "Acme",
	}) ?? h.empty

describe("quick start progress trail", () => {
	test("a done step's answer reopens it; steps not done yet and the held plan stay text", () => {
		scene(
			{ update, view },
			given(atConnect()),
			Mount.resolve(MountDitherField, Message.CompletedMountDitherField()),
			Mount.resolve<string, Tabs.Message>(
				Tabs.MeasureTabIndicator,
				Tabs.Message.MeasuredIndicator({
					rect: { left: 0, right: 96, top: 0, bottom: 32, width: 96, height: 32 },
				}),
			),
			expectView(role("heading", { name: "Connect your stack" })).toExist(),
			expectView(role("button", { name: "Go to Team" })).not.toExist(),
			expectView(role("button", { name: /go to Plan/ })).not.toExist(),
			click(role("button", { name: "2 picked, go to Stack" })),
			Command.resolve(SaveQuickStartState, Message.CompletedSaveQuickStartState()),
			// The connect step's tabs leave with it.
			Mount.expectEnded(Tabs.MeasureTabIndicator),
			expectView(role("heading", { name: "What are you running?" })).toExist(),
		)
	})
})
