import { Result } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { expect as expectView, given, role, scene, text } from "foldkit/scene"
import { describe, test } from "vitest"
import type { SignalPresence } from "../kit/signal-presence"
import { init, Message, type Model, update as updateWith } from "./quick-start"
import { DEFAULT_QUICK_START_STATE, type QuickStartState } from "./quick-start-state"
import { liveStep } from "./quick-start-view"

const update = (model: Model, message: Message) => updateWith(model, message, true)

const PRESENT: SignalPresence = { status: "present", lastSeenMs: 1 }

const state: QuickStartState = {
	...DEFAULT_QUICK_START_STATE,
	activeStep: "live",
	stack: { languages: ["nodejs"], platforms: ["cloudflare", "aws"] },
}

/** The live screen with what the connect step last read: signal presence and provider statuses. */
const atLive = (present: ReadonlyArray<string>, connected: Readonly<Record<string, boolean>>): Model => {
	const model = init("maple-onboarding-v6-org_1", false, false, "/", "org_1").model
	const presences = Object.fromEntries(present.map((signal) => [signal, PRESENT]))
	return {
		...model,
		state,
		connect: {
			...model.connect,
			presence: AsyncData.settle(model.connect.presence, Result.succeed(presences)),
			connected,
		},
	}
}

const view = (model: Model, h: HtmlBuilder<Message>): Html => liveStep(h, model, state, "Acme")

describe("you're live step", () => {
	test("with nothing arriving it waits for the first data and lists what is left to connect", () => {
		scene(
			{ update, view },
			given(atLive([], {})),
			expectView(role("heading", { name: "Acme is ready for its first data" })).toExist(),
			expectView(text("Connect Cloudflare")).toExist(),
			expectView(text("Your first span, log or metric")).toExist(),
		)
	})

	test("a connected provider is not data yet, and every picked platform not connected yet still waits", () => {
		scene(
			{ update, view },
			given(atLive([], { cloudflare: true })),
			expectView(role("heading", { name: "Acme is ready for its first data" })).toExist(),
			expectView(text("Connect Cloudflare")).not.toExist(),
			expectView(text("Connect AWS")).toExist(),
		)
	})

	test("once a signal arrives the org is live and the wait for a first signal is gone", () => {
		scene(
			{ update, view },
			given(atLive(["traces"], {})),
			expectView(role("heading", { name: "Acme is live" })).toExist(),
			expectView(text("Your first span, log or metric")).not.toExist(),
		)
	})
})
