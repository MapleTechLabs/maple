import type { Html, HtmlBuilder } from "foldkit/html"
import { expect as expectView, given, role, scene } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { init, Message, type Model, update as updateWith } from "./quick-start"
import { DEFAULT_QUICK_START_STATE } from "./quick-start-state"
import { ready } from "./quick-start-team"
import { teamStep } from "./quick-start-team-view"
import { Array as Arr } from "effect"

const update = (model: Model, message: Message) => updateWith(model, message, true)

const atTeam = (): Model => ({
	...init("maple-onboarding-v6-org_1", false, false, "/services").model,
	state: {
		...DEFAULT_QUICK_START_STATE,
		activeStep: "team",
		completedSteps: { plan: true, stack: true, connect: true, live: true },
	},
	team: ready("Acme", [], true, null),
})

const view = (model: Model, h: HtmlBuilder<Message>): Html => teamStep(h, model.team, "Acme")

describe("team and tools step", () => {
	test("each tool opens its own setup page in a new tab", () => {
		scene(
			{ update, view },
			given(atTeam()),
			expectView(role("link", { name: "Connect: GitHub (opens a new tab)" })).toHaveAttr(
				"target",
				"_blank",
			),
			expectView(role("link", { name: "Add to Slack: Slack (opens a new tab)" })).toHaveAttr(
				"href",
				"/integrations?integration=chat-slack",
			),
			expectView(role("link", { name: "Set up: Maple in your editor (opens a new tab)" })).toHaveAttr(
				"href",
				"/mcp",
			),
		)
	})

	test("it is the last step: its button leaves for the org", () => {
		scene(
			{ update, view },
			given(atTeam()),
			expectView(role("button", { name: "Go to Acme" })).not.toBeDisabled(),
		)
		const next = update(atTeam(), Message.ClickedContinue({ step: "team" }))
		expect(Arr.map(next.commands ?? [], (command) => [command.name, command.args]).at(-1)).toEqual([
			"FinishQuickStart",
			{ url: "/services" },
		])
	})
})
