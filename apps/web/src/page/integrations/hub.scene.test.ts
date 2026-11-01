import { OrgId } from "@maple/domain"
import { LinearIntegrationStatus } from "@maple/domain/http"
import { V2ChatConnectorList } from "@maple/domain/http/v2"
import { Option, Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import { all, expect as expectView, expectAll, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../contract"
import { integrationOfSearch } from "./catalog"
import { cardStatusOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const steps = (model: Model, messages: ReadonlyArray<Message>) =>
	messages.reduce((current, message) => pageUpdate(current, message).model, model)

const entered = (search: Model["search"] = {}) => init({ search }, context).model

/** The Hazel chat connector, available and not yet installed. */
const withHazelConnector = (search: Model["search"]): Model => {
	const model = entered(search)
	const connectors = Schema.decodeUnknownSync(V2ChatConnectorList)({
		object: "chat_connector_list",
		data: [
			{
				id: "hazel",
				object: "chat_connector",
				name: "Hazel",
				available: true,
				supports_identity: true,
				workspaces: [],
			},
		],
	})
	return steps(model, [
		Message.CompletedLoadChat({
			key: model.statuses.chat.key ?? "",
			result: Result.succeed(connectors),
		}),
	])
}

const linear = (state: "absent" | "connected" | "revoked") =>
	Schema.decodeUnknownSync(LinearIntegrationStatus)({
		connected: state !== "absent",
		workspaceName: state === "absent" ? null : "Acme Eng",
		connectedByUserId: null,
		revoked: state === "revoked",
	})

const withLinear = (
	state: "absent" | "connected" | "revoked",
	search: Model["search"] = { integration: "linear" },
): Model => {
	const model = entered(search)
	return steps(model, [
		Message.CompletedLoadLinear({
			key: model.statuses.linear.key ?? "",
			result: Result.succeed(linear(state)),
		}),
	])
}

describe("integrations hub", () => {
	test("entry reads the clock, every status and the customer once", () => {
		const result = init({ search: {} }, context)
		const sent = names(result.commands)
		expect(sent).toEqual(
			expect.arrayContaining([
				"ReadIntegrationsClock",
				"LoadIntegrationsCloudflareStatus",
				"LoadIntegrationsRailwayStatus",
				"LoadIntegrationsPlanetscaleStatus",
				"LoadIntegrationsPlanetscaleDatabases",
				"LoadIntegrationsGcpStatus",
				"LoadIntegrationsAwsStatus",
				"LoadIntegrationsSupabaseStatus",
				"LoadIntegrationsLinearStatus",
				"LoadIntegrationsGithubStatus",
				"LoadIntegrationsChatConnectors",
				"LoadIntegrationsScrapeTargets",
				"LoadIntegrationsCustomer",
			]),
		)
		expect(new Set(sent).size).toBe(sent.length)
	})

	test("a status answer under a superseded key is dropped", () => {
		const model = entered()
		const late = pageUpdate(
			model,
			Message.CompletedLoadLinear({ key: "stale", result: Result.succeed(linear("connected")) }),
		)
		expect(late.model.statuses.linear).toEqual(model.statuses.linear)
	})

	test("a write's re-read supersedes the read in flight, so the older answer cannot land last", () => {
		const model = entered()
		const preWriteKey = model.statuses.linear.key ?? ""
		const retried = pageUpdate(model, Message.ClickedRetryStatus({ name: "linear" }))
		expect(names(retried.commands)).toEqual(["LoadIntegrationsLinearStatus"])
		const fresh = pageUpdate(
			retried.model,
			Message.CompletedLoadLinear({
				key: retried.model.statuses.linear.key ?? "",
				result: Result.succeed(linear("absent")),
			}),
		).model
		const late = pageUpdate(
			fresh,
			Message.CompletedLoadLinear({ key: preWriteKey, result: Result.succeed(linear("connected")) }),
		).model
		expect(
			Option.map(AsyncData.getData(late.statuses.linear.data), (status) => status.connected),
		).toEqual(Option.some(false))
	})

	test("a connected status lists the integration under Connected; selecting it navigates", () => {
		scene(
			{ update: pageUpdate, view },
			given(withLinear("connected", {})),
			expectView(text("Connected")).toExist(),
			expectView(text("Acme Eng")).toExist(),
		)
		expect(
			pageUpdate(withLinear("connected", {}), Message.ClickedIntegration({ integration: "linear" }))
				.outMessage,
		).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/integrations?integration=linear", isReplace: false }),
		)
	})

	test("the back button returns to the hub", () => {
		const model = withLinear("connected")
		expect(pageUpdate(model, Message.ClickedIntegration({ integration: null })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/integrations", isReplace: false }),
		)
	})

	test("a chat callback strips its params with a replace; in-app it toasts first", () => {
		const entry = init(
			{ search: { integration: "chat-slack", chat: "connected", chat_workspace: "Acme" } },
			context,
		)
		expect(entry.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/integrations?integration=chat-slack",
				isReplace: true,
			}),
		)
		const inApp = routeChanged(
			entered(),
			{
				search: { integration: "chat-slack", chat: "connected", chat_workspace: "Acme" },
			},
			context,
		)
		expect(inApp.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "success", title: "Connected Acme", description: "" }),
		)
		expect(pageUpdate(inApp.model, Message.CompletedChatToast()).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/integrations?integration=chat-slack",
				isReplace: true,
			}),
		)
		const failed = routeChanged(
			entered(),
			{ search: { chat: "error", chat_reason: "conflict" } },
			context,
		)
		expect(failed.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "error",
				title: "That workspace is already linked to a different Maple organization.",
				description: "",
			}),
		)
	})

	test("every chat connector has a tile for every org, Discord included", () => {
		const model = entered()
		const discord = Schema.decodeUnknownSync(V2ChatConnectorList)({
			object: "chat_connector_list",
			data: [
				{
					id: "discord",
					object: "chat_connector",
					name: "Discord",
					available: true,
					supports_identity: true,
					workspaces: [],
				},
			],
		})
		const loaded = pageUpdate(
			model,
			Message.CompletedLoadChat({
				key: model.statuses.chat.key ?? "",
				result: Result.succeed(discord),
			}),
		).model
		scene({ update: pageUpdate, view }, given(loaded), expectView(text("Discord")).toExist())
	})

	test("a Discord link opens its card rather than falling back to the hub", () => {
		expect(integrationOfSearch("chat-discord")).toBe("chat-discord")
		expect(integrationOfSearch("chat-nope")).toBeNull()
	})

	test("the hub lists Hazel once, as its chat connector", () => {
		scene(
			{ update: pageUpdate, view },
			given(withHazelConnector({})),
			expectAll(all.role("button", { name: /Hazel/ })).toHaveCount(1),
			expectView(text(/Add the Maple bot to a Hazel workspace/)).toExist(),
		)
		expect(
			pageUpdate(entered(), Message.ClickedIntegration({ integration: "chat-hazel" })).outMessage,
		).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/integrations?integration=chat-hazel",
				isReplace: false,
			}),
		)
	})
})

describe("linear card", () => {
	test("not connected shows the connect card; connect starts a Linear attempt", () => {
		const model = withLinear("absent")
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(
				text("Linear destinations will appear here after connecting your workspace."),
			).toExist(),
		)
		const started = pageUpdate(model, Message.ClickedConnect())
		expect(started.model.connect.active).toEqual({ provider: "linear", attempt: 1 })
		const answered = pageUpdate(started.model, Message.SucceededStartConnect({ attempt: 1 }))
		expect(names(answered.commands)).toEqual(["LoadIntegrationsLinearStatus"])
	})

	test("connected shows the workspace; a revoked grant asks for a reconnect", () => {
		scene(
			{ update: pageUpdate, view },
			given(withLinear("connected")),
			expectView(text("Acme Eng")).toExist(),
			expectView(text("Connected")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(withLinear("revoked")),
			expectView(text("Revoked")).toExist(),
			expectView(role("button", { name: "Reconnect" })).toExist(),
		)
	})

	test("a member cannot start a Linear connect from the header or the card", () => {
		const member = steps(withLinear("absent"), [Message.CompletedLoadSession({ isAdmin: false })])
		scene(
			{ update: pageUpdate, view },
			given(member),
			expectView(role("button", { name: "Connect Linear" })).toBeDisabled(),
		)
		expect(pageUpdate(member, Message.ClickedConnect()).model.connect.active).toBeNull()
	})

	test("a connected workspace without a name reads Connected", () => {
		const model = entered({ integration: "linear" })
		const unnamed = steps(model, [
			Message.CompletedLoadLinear({
				key: model.statuses.linear.key ?? "",
				result: Result.succeed(
					Schema.decodeUnknownSync(LinearIntegrationStatus)({
						connected: true,
						workspaceName: "",
						connectedByUserId: null,
						revoked: false,
					}),
				),
			}),
		])
		expect(cardStatusOf(unnamed.statuses, "linear", 0)?.label).toBe("Connected")
	})

	test("disconnect stays open while pending, then closes, toasts and re-reads the Linear status", () => {
		const opened = pageUpdate(withLinear("connected"), Message.ClickedDisconnect()).model
		const confirmed = pageUpdate(opened, Message.ConfirmedDisconnect())
		expect(names(confirmed.commands)).toContain("DisconnectIntegration")
		expect(confirmed.model.disconnect.dialog.isOpen).toBe(true)
		expect(confirmed.model.disconnect.isPending).toBe(true)
		const done = pageUpdate(
			confirmed.model,
			Message.CompletedDisconnect({ integration: "linear", failure: null }),
		)
		expect(done.model.disconnect.dialog.isOpen).toBe(false)
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "success", title: "Linear disconnected", description: "" }),
		)
		expect(names(done.commands)).toContain("LoadIntegrationsLinearStatus")
	})
})
