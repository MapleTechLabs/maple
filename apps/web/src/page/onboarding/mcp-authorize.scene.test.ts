import type { Html, HtmlBuilder } from "foldkit/html"
import { click, Command, expect as expectView, given, role, scene, text } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import {
	DecideMcpAuthorization,
	init,
	Message,
	type Model,
	ReturnToClient,
	State,
	update,
} from "./mcp-authorize"
import { view as mcpView } from "./mcp-authorize-view"
import * as Unsubscribe from "./unsubscribe"

const view = (model: Model, h: HtmlBuilder<Message>): Html => mcpView(h, model, h.empty)

const info = { clientName: "Claude", returnsTo: "claude.ai", expiresAtLabel: "12:10:00 PM" }

const ready = (): Model =>
	update(init("mcpreq_1").model, Message.SucceededInspectMcpAuthorization({ info, isPending: true })).model

describe("MCP authorize", () => {
	test("a link without a request id fails at once", () => {
		const entered = init(undefined)
		expect(entered.model.state).toEqual(
			State.Failed({ message: "This authorization link is incomplete." }),
		)
		expect(entered.commands ?? []).toEqual([])
	})

	test("a request that is no longer pending reads as already used", () => {
		const next = update(
			init("mcpreq_1").model,
			Message.SucceededInspectMcpAuthorization({ info, isPending: false }),
		)
		expect(next.model.state).toEqual(
			State.Failed({ message: "This authorization request has already been used." }),
		)
	})

	test("approving returns to the client's redirect URI", () => {
		scene(
			{ update, view },
			given(ready()),
			expectView(text("claude.ai")).toExist(),
			click(role("button", { name: "Approve" })),
			Command.expectExact(DecideMcpAuthorization({ requestId: "mcpreq_1", action: "approve" })),
			expectView(role("status")).toHaveText("Returning to your MCP client…"),
			Command.resolve(
				DecideMcpAuthorization,
				Message.SucceededDecideMcpAuthorization({ redirectUri: "https://claude.ai/cb?code=1" }),
			),
			Command.expectExact(ReturnToClient({ href: "https://claude.ai/cb?code=1" })),
			Command.resolve(ReturnToClient, Message.CompletedReturnToClient()),
		)
	})

	test("a refused decision shows the API's message", () => {
		scene(
			{ update, view },
			given(ready()),
			click(role("button", { name: "Deny" })),
			Command.resolve(
				DecideMcpAuthorization,
				Message.FailedDecideMcpAuthorization({ message: "Already used" }),
			),
			expectView(role("alert")).toHaveText("Already used"),
		)
	})

	test("a second click while redirecting sends nothing", () => {
		const redirecting = update(ready(), Message.ClickedDecision({ action: "approve" })).model
		const again = update(redirecting, Message.ClickedDecision({ action: "deny" }))
		expect(again.model).toEqual(redirecting)
		expect(again.commands ?? []).toEqual([])
	})
})

const unsubscribeView = (model: Unsubscribe.Model, h: HtmlBuilder<Unsubscribe.Message>): Html =>
	Unsubscribe.view(h, model)

describe("unsubscribe", () => {
	test("confirming unsubscribes, then links to the notification settings", () => {
		scene(
			{ update: Unsubscribe.update, view: unsubscribeView },
			given(Unsubscribe.init("digest.token")),
			expectView(text("the weekly digest")).toExist(),
			click(role("button", { name: "Unsubscribe" })),
			Command.expectExact(Unsubscribe.Unsubscribe({ token: "digest.token" })),
			expectView(role("button", { name: /Unsubscribe/ })).toHaveAttr("data-loading", ""),
			Command.resolve(Unsubscribe.Unsubscribe, Unsubscribe.Message.SucceededUnsubscribe()),
			expectView(role("link", { name: "Notification settings" })).toHaveAttr(
				"href",
				"/account?tab=email-preferences",
			),
		)
	})

	test("a rejected token explains the link is invalid", () => {
		scene(
			{ update: Unsubscribe.update, view: unsubscribeView },
			given(Unsubscribe.init("web-analytics.token")),
			click(role("button", { name: "Unsubscribe" })),
			Command.resolve(
				Unsubscribe.Unsubscribe,
				Unsubscribe.Message.FailedUnsubscribe({ isInvalidToken: true }),
			),
			expectView(
				text("This unsubscribe link is invalid. Use the link from the email itself."),
			).toExist(),
		)
	})

	test("a missing token renders the invalid link screen and never posts", () => {
		const model = Unsubscribe.init(undefined)
		expect(Unsubscribe.update(model, Unsubscribe.Message.ClickedUnsubscribe()).commands ?? []).toEqual([])
		scene(
			{ update: Unsubscribe.update, view: unsubscribeView },
			given(model),
			expectView(text("Invalid unsubscribe link")).toExist(),
		)
	})
})
