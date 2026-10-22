import type { Html, HtmlBuilder } from "foldkit/html"
import { click, Command, expect as expectView, given, label, role, scene, text, type } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as OtpField from "../../ui/otp-field"
import { DecideCliDevice, init, InspectCliDevice, Message, type Model, State, update } from "./cli-login"
import { view as cliLoginView } from "./cli-login-view"

const view = (model: Model, h: HtmlBuilder<Message>): Html => cliLoginView(h, model, h.empty)

const info = {
	userCode: "WDJB-MJHT",
	deviceName: "Maple CLI on ada-macbook-pro",
	expiresAtLabel: "12:10:00 PM",
}

const codeField = label("One-time code")

describe("CLI login", () => {
	test("typing the eight characters inspects the code, then approving reports success", () => {
		scene(
			{ update, view },
			given(init(undefined).model),
			type(codeField, "wdjbmjht"),
			Command.expectHas(InspectCliDevice({ userCode: "WDJB-MJHT" })),
			Command.resolve(OtpField.FocusSlot, OtpField.Message.CompletedFocusSlot()),
			expectView(role("status")).toHaveText("Checking authorization…"),
			Command.resolve(
				InspectCliDevice,
				Message.SucceededInspectCliDevice({ userCode: "WDJB-MJHT", info, status: "pending" }),
			),
			expectView(text("Maple CLI on ada-macbook-pro")).toExist(),
			click(role("button", { name: "Approve" })),
			Command.expectExact(DecideCliDevice({ userCode: "WDJB-MJHT", action: "approve" })),
			Command.resolve(DecideCliDevice, Message.SucceededDecideCliDevice({ action: "approve" })),
			expectView(text("CLI access approved")).toExist(),
		)
	})

	test("an unknown code shows the API's message and marks the field invalid", () => {
		const failed = update(
			{ ...init(undefined).model, state: State.Loading(), pendingCode: "ZZZZ-ZZZZ" },
			Message.FailedInspectCliDevice({
				userCode: "ZZZZ-ZZZZ",
				message: "This CLI login code is invalid or expired.",
			}),
		).model
		scene(
			{ update, view },
			given(failed),
			expectView(role("alert")).toHaveText("This CLI login code is invalid or expired."),
			expectView(role("group")).toHaveAttr("aria-invalid", "true"),
		)
		expect(failed.pendingCode).toBeNull()
	})

	test("a code from the URL is inspected on entry, normalised", () => {
		const entered = init("wdjb-mjht")
		expect(entered.model.state).toEqual(State.Loading())
		expect(entered.commands?.map((command) => [command.name, command.args])).toEqual([
			["InspectCliDevice", { userCode: "WDJB-MJHT" }],
		])
	})

	test("a short code from the URL fails without a request", () => {
		const entered = init("WDJB")
		expect(entered.model.state).toEqual(
			State.Failed({ message: "Enter the eight-character code shown in your terminal." }),
		)
		expect(entered.commands ?? []).toEqual([])
	})

	test("an answer for another code is dropped", () => {
		const loading = init("WDJB-MJHT").model
		const stale = update(
			loading,
			Message.SucceededInspectCliDevice({ userCode: "AAAA-BBBB", info, status: "pending" }),
		)
		expect(stale.model).toEqual(loading)
	})

	test("a decision is only taken from the ready card", () => {
		const loading = init("WDJB-MJHT").model
		const clicked = update(loading, Message.ClickedDecision({ action: "deny" }))
		expect(clicked.model).toEqual(loading)
		expect(clicked.commands ?? []).toEqual([])
	})

	test("a code that was already approved shows the approved outcome", () => {
		const loading = init("WDJB-MJHT").model
		const next = update(
			loading,
			Message.SucceededInspectCliDevice({ userCode: "WDJB-MJHT", info, status: "complete" }),
		)
		expect(next.model.state).toEqual(State.Approved())
	})
})
