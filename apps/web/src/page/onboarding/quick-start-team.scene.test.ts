import type { Html, HtmlBuilder } from "foldkit/html"
import { expect as expectView, given, role, scene } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { init, Message, type Model, update as updateWith } from "./quick-start"
import { DEFAULT_QUICK_START_STATE } from "./quick-start-state"
import { ready } from "./quick-start-team"
import { teamStep } from "./quick-start-team-view"

const update = (model: Model, message: Message) => updateWith(model, message, true)

const atTeam = (): Model => ({
	...init("maple-onboarding-v6-org_1", false, false, "/services").model,
	state: {
		...DEFAULT_QUICK_START_STATE,
		activeStep: "team",
		completedSteps: { plan: true, stack: true, connect: true },
	},
	team: ready("Acme", [], true, null),
})

const view = (model: Model, h: HtmlBuilder<Message>): Html => teamStep(h, model.team)

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

	test("Continue moves on to the last screen, which reads what the org already shows", () => {
		scene(
			{ update, view },
			given(atTeam()),
			expectView(role("button", { name: "Continue" })).not.toBeDisabled(),
		)
		const next = update(atTeam(), Message.ClickedContinue({ step: "team" }))
		expect((next.commands ?? []).map((command) => command.name)).toContain("LoadOnboardingLiveFindings")
		expect(next.model.live._tag).toBe("Loading")
	})
})
