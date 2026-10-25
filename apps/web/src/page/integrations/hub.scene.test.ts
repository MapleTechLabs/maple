import { OrgId } from "@maple/domain"
import { HazelIntegrationStatus } from "@maple/domain/http"
import { V2ChatConnectorList } from "@maple/domain/http/v2"
import { Option, Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../data/load-failure"
import { PageOutMessage, type PageContext } from "../contract"
import { integrationOfSearch } from "./catalog"
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

const hazel = (connected: boolean) =>
	Schema.decodeUnknownSync(HazelIntegrationStatus)({
		connected,
		externalUserId: null,
		externalUserEmail: connected ? "ada@acme.test" : null,
		connectedByUserId: null,
		scope: connected ? "openid" : null,
	})

const entered = (search: Model["search"] = {}) => init({ search }, context).model

const withHazel = (connected: boolean, search: Model["search"] = {}): Model => {
	const model = entered(search)
	return steps(model, [
		Message.CompletedLoadHazel({
			key: model.statuses.hazel.key ?? "",
			result: Result.succeed(hazel(connected)),
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
				"LoadIntegrationsHazelStatus",
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
			Message.CompletedLoadHazel({ key: "stale", result: Result.succeed(hazel(true)) }),
		)
		expect(late.model.statuses.hazel).toEqual(model.statuses.hazel)
	})

	test("a write's re-read supersedes the read in flight, so the older answer cannot land last", () => {
		const model = entered()
		const preWriteKey = model.statuses.hazel.key ?? ""
		const retried = pageUpdate(model, Message.ClickedRetryStatus({ name: "hazel" }))
		expect(names(retried.commands)).toEqual(["LoadIntegrationsHazelStatus"])
		const fresh = pageUpdate(
			retried.model,
			Message.CompletedLoadHazel({
				key: retried.model.statuses.hazel.key ?? "",
				result: Result.succeed(hazel(false)),
			}),
		).model
		const late = pageUpdate(
			fresh,
			Message.CompletedLoadHazel({ key: preWriteKey, result: Result.succeed(hazel(true)) }),
		).model
		expect(Option.map(AsyncData.getData(late.statuses.hazel.data), (status) => status.connected)).toEqual(
			Option.some(false),
		)
	})

	test("a connected status lists the integration under Connected; selecting it navigates", () => {
		scene(
			{ update: pageUpdate, view },
			given(withHazel(true)),
			expectView(text("Connected")).toExist(),
			expectView(text("ada@acme.test")).toExist(),
		)
		expect(
			pageUpdate(withHazel(true), Message.ClickedIntegration({ integration: "hazel" })).outMessage,
		).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/integrations?integration=hazel", isReplace: false }),
		)
	})

	test("the back button returns to the hub", () => {
		const model = withHazel(true, { integration: "hazel" })
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
})

describe("hazel card", () => {
	test("not connected shows the connect card; connect starts one attempt at a time", () => {
		const model = withHazel(false, { integration: "hazel" })
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(
				text("Alert destinations will appear here after connecting your workspace."),
			).toExist(),
		)
		const started = pageUpdate(model, Message.ClickedConnect())
		expect(started.model.connect.active).toEqual({ provider: "hazel", attempt: 1 })
		expect(pageUpdate(started.model, Message.ClickedConnect()).model.connect.attempts).toBe(1)
		const answered = pageUpdate(started.model, Message.SucceededStartConnect({ attempt: 1 }))
		expect(answered.model.connect.isStarting).toBe(false)
		expect(names(answered.commands)).toEqual(["LoadIntegrationsHazelStatus"])
		const closed = pageUpdate(answered.model, Message.ClosedConnectPopup({ attempt: 1 }))
		expect(closed.model.connect.active).toBeNull()
	})

	test("a failed start toasts the provider's title and ends the attempt", () => {
		const started = pageUpdate(withHazel(false, { integration: "hazel" }), Message.ClickedConnect()).model
		const failed = pageUpdate(
			started,
			Message.FailedStartConnect({
				attempt: 1,
				title: "Failed to start Hazel connect flow",
				description: "nope",
			}),
		)
		expect(failed.model.connect.active).toBeNull()
		expect(failed.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "error",
				title: "Failed to start Hazel connect flow",
				description: "nope",
			}),
		)
	})

	test("disconnect confirms first, sends once, toasts and re-reads the status", () => {
		const model = withHazel(true, { integration: "hazel" })
		const opened = pageUpdate(model, Message.ClickedDisconnect()).model
		expect(opened.disconnect.dialog.isOpen).toBe(true)
		const confirmed = pageUpdate(opened, Message.ConfirmedDisconnect())
		expect(names(confirmed.commands)).toContain("DisconnectIntegration")
		expect(names(pageUpdate(confirmed.model, Message.ConfirmedDisconnect()).commands)).toEqual([])
		const done = pageUpdate(
			confirmed.model,
			Message.CompletedDisconnect({ integration: "hazel", failure: null }),
		)
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "success", title: "Hazel disconnected", description: "" }),
		)
		expect(names(done.commands)).toEqual(["LoadIntegrationsHazelStatus"])
	})

	test("a failed status read offers a retry", () => {
		const model = entered({ integration: "hazel" })
		const failed = steps(model, [
			Message.CompletedLoadHazel({
				key: model.statuses.hazel.key ?? "",
				result: Result.fail(toLoadFailure("boom")),
			}),
		])
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("Couldn't load the Hazel integration")).toExist(),
			expectView(role("button", { name: /Retry|Try again/ })).toExist(),
		)
	})
})
