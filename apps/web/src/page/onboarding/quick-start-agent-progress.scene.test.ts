import { timestamp, type V2OnboardingAgentRun } from "@maple/domain/http/v2"
import { Array as Arr, Result } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
	all,
	Command,
	expect as expectView,
	expectAll,
	given,
	Mount,
	role,
	scene,
	Subscription,
	text,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Tabs from "@maple/views/ui/tabs"
import { labAgentRun } from "../../lab/onboarding-agent-fixture"
import * as AgentHandoff from "../kit/agent-handoff"
import { init, Message, type Model, update as updateWith } from "./quick-start"
import { ConnectMessage, initConnect, LoadConnectPresence, updateConnect } from "./quick-start-connect"
import { DEFAULT_QUICK_START_STATE, type QuickStartState } from "./quick-start-state"
import { connectStep } from "./quick-start-view"

// The connect step's agent progress: the run a copy started, re-read on the step's poll.

const update = (model: Model, message: Message) => updateWith(model, message, true)

const state: QuickStartState = {
	...DEFAULT_QUICK_START_STATE,
	activeStep: "connect",
	stack: { languages: ["nodejs"], platforms: [] },
}

/** The connect step after a copy: its run waits for the agent, and the poll is running. */
const atConnect = (run: V2OnboardingAgentRun | null = labAgentRun("waiting")): Model => {
	const model = init("maple-onboarding-v6-org_1", false, false, "/", "org_1").model
	return {
		...model,
		state,
		connect: {
			...model.connect,
			isActive: true,
			keys: { _tag: "Ready", privateKey: "maple_sk_test", publicKey: "maple_pk_test" },
			agent: { ...model.connect.agent, run },
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

const poll = Subscription.emit(Message.GotConnectMessage({ message: ConnectMessage.ElapsedPoll() }))

const presenceRead = Command.resolve(
	LoadConnectPresence({ orgId: "org_1" }),
	ConnectMessage.LoadedPresence({ result: Result.succeed({}) }),
)

/** One poll whose run read answers `run`. */
const polledRun = (run: V2OnboardingAgentRun) => [
	poll,
	presenceRead,
	Command.resolve(AgentHandoff.LoadAgentRun(), AgentHandoff.Message.SucceededLoadRun({ run })),
]

const tracked = (event: "onboarding_agent_run_reported" | "onboarding_agent_run_completed") =>
	Command.resolve(
		AgentHandoff.TrackAgentEvent({ event, surface: "connect_step", hasHandoffCode: null }),
		AgentHandoff.Message.CompletedTrack(),
	)

describe("agent progress", () => {
	test("a waiting run says so and lists every stage as pending", () => {
		scene(
			{ update, view },
			given(atConnect()),
			indicatorMeasured(),
			expectView(role("region", { name: "Agent progress" })).toExist(),
			expectView(text("Waiting for your agent…")).toExist(),
			expectView(text("Connect agent")).toExist(),
			expectView(text("Prepare production")).toExist(),
			expectAll(all.selector('li[data-state="pending"]')).toHaveCount(6),
		)
	})

	test("the poll shows the agent's stages and notes as it reports, then the verification trace", () => {
		scene(
			{ update, view },
			given(atConnect()),
			indicatorMeasured(),
			...polledRun(labAgentRun("progress")),
			tracked("onboarding_agent_run_reported"),
			expectView(text("Your agent is setting up Maple.")).toExist(),
			expectView(text("The dev server would not start on port 3000")).toExist(),
			expectAll(all.selector('li[data-state="failed"]')).toHaveCount(1),
			expectAll(all.selector('li[data-state="active"]')).toHaveCount(1),
			...polledRun(labAgentRun("completed")),
			tracked("onboarding_agent_run_completed"),
			expectView(text(/Setup complete for checkout-api, web\./)).toExist(),
			expectView(role("link", { name: "Open the verification trace" })).toHaveAttr(
				"href",
				"/traces/4bf92f3577b34da6a3ce929d0e0e4736",
			),
			expectAll(all.selector('li[data-state="skipped"]')).toHaveCount(1),
		)
	})

	test("an expired or failed run says so in one sentence", () => {
		scene(
			{ update, view },
			given(atConnect()),
			indicatorMeasured(),
			...polledRun(labAgentRun("expired")),
			tracked("onboarding_agent_run_reported"),
			expectView(text(/ran out of time before your agent finished/)).toExist(),
		)
		scene(
			{ update, view },
			given(atConnect()),
			indicatorMeasured(),
			...polledRun({ ...labAgentRun("progress"), status: "failed" }),
			tracked("onboarding_agent_run_reported"),
			expectView(text(/Your agent stopped before setup finished/)).toExist(),
		)
	})

	test("no run yet shows the prompt alone", () => {
		scene(
			{ update, view },
			given(atConnect(null)),
			indicatorMeasured(),
			expectView(text("Agent progress")).toBeAbsent(),
		)
	})
})

describe("agent run polling", () => {
	const withRun = (run: V2OnboardingAgentRun | null) => ({
		...initConnect(),
		isActive: true,
		agent: { ...AgentHandoff.init("connect_step"), run },
	})
	const reads = (run: V2OnboardingAgentRun | null) =>
		Arr.filter(
			updateConnect(withRun(run), ConnectMessage.ElapsedPoll(), "org_1", []).commands,
			(command) => command.name === AgentHandoff.LoadAgentRun.name,
		).length

	test("the poll reads an open run and stops once the run is closed", () => {
		expect(reads(labAgentRun("waiting"))).toBe(1)
		expect(reads(labAgentRun("progress"))).toBe(1)
		expect(reads(labAgentRun("completed"))).toBe(0)
		expect(reads(labAgentRun("expired"))).toBe(0)
		expect(reads({ ...labAgentRun("progress"), status: "failed" })).toBe(0)
	})

	test("an older run read mid-copy does not replace the newer one", () => {
		const older = { ...labAgentRun("progress"), created_at: timestamp("2026-11-21T10:00:00.000Z") }
		const next = AgentHandoff.update(
			{ ...AgentHandoff.init("connect_step"), run: labAgentRun("waiting") },
			AgentHandoff.Message.SucceededLoadRun({ run: older }),
		)
		expect(next.model.run?.status).toBe("waiting_for_agent")
	})
})
