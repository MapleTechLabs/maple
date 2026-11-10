import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { LinearIntegrationStatus } from "@maple/domain/http"
import {
	encodePublicId,
	PublicIdPrefixes,
	V2ChatConnectorList,
	V2DataSource,
	V2ScrapeTarget,
} from "@maple/domain/http/v2"
import { Option, Result, Schema, Array as Arr } from "effect"
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
import { toLoadFailure } from "@maple/views/data/load-failure"

const MEMBER = Policy.grantsOf(["org:member"])

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const steps = (model: Model, messages: ReadonlyArray<Message>) =>
	Arr.reduce(messages, model, (current, message) => pageUpdate(current, message).model)

const entered = (search: Model["search"] = {}) => init({ search }, context).model

/** The Hazel chat connector, available and not yet installed. */
const withHazelConnector = (search: Model["search"]): Model => {
	const model = entered(search)
	const connectors = Schema.decodeSync(V2ChatConnectorList)({
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
	Schema.decodeSync(LinearIntegrationStatus)({
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
		const discord = Schema.decodeSync(V2ChatConnectorList)({
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
		const member = steps(withLinear("absent"), [
			Message.CompletedLoadSession({ grants: MEMBER, hasDataSources: true }),
		])
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
					Schema.decodeSync(LinearIntegrationStatus)({
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

describe("telemetry and data sources", () => {
	const SOURCE_UUID = "6f1c2a4e-8d3b-4c7a-9e21-3b5d7f9a1c2e"
	const dataSource = (status: "ok" | "error") =>
		Schema.decodeSync(V2DataSource)({
			id: encodePublicId(PublicIdPrefixes.dataSource, SOURCE_UUID),
			object: "data_source",
			name: "shop-prod",
			kind: "clickhouse",
			query_language: "sql:clickhouse",
			description: "Storefront",
			environment: "production",
			tags: [],
			agent_access: true,
			agent_pii: false,
			connection: {
				type: "clickhouse",
				url: "https://ch.example.com:8443",
				user: "reader",
				database: "shop",
			},
			has_secret: true,
			secret_hint: null,
			status,
			last_checked_at: "2026-11-08T12:00:00.000Z",
			last_error: status === "error" ? "connection refused" : null,
			catalog_refreshed_at: null,
			catalog_error: null,
			catalog_entry_count: 14,
			created_at: "2026-11-08T12:00:00.000Z",
			updated_at: "2026-11-08T12:00:00.000Z",
		})
	const prometheusTarget = Schema.decodeSync(V2ScrapeTarget)({
		id: "scrp_YoxMqYdzUJ1tH4BqCWxPH3",
		object: "scrape_target",
		name: "redis.internal:9121",
		service_name: null,
		url: "https://redis.internal:9121/metrics",
		target_type: "prometheus",
		organization: null,
		include_branches: [],
		exclude_branches: [],
		scrape_interval_seconds: 15,
		labels_json: null,
		auth_type: "none",
		has_credentials: false,
		managed_by: null,
		enabled: true,
		last_scrape_at: null,
		last_scrape_error: null,
		created_at: "2026-10-01T11:00:00.000Z",
		updated_at: "2026-10-01T11:00:00.000Z",
	})

	/** The hub with the data sources flag on, one Prometheus target, Linear and a ClickHouse source. */
	const hub = (status: "ok" | "error" = "ok"): Model => {
		const model = withLinear("connected", {})
		const flagged = pageUpdate(
			model,
			Message.CompletedLoadSession({ grants: Policy.allPermissions, hasDataSources: true }),
		).model
		return steps(flagged, [
			Message.CompletedLoadScrapeTargets({
				key: flagged.statuses.scrapeTargets.key ?? "",
				result: Result.succeed([prometheusTarget]),
			}),
			Message.CompletedLoadDataSources({
				key: flagged.statuses.dataSources.key ?? "",
				result: Result.succeed([dataSource(status)]),
			}),
		])
	}

	test("the data sources read waits on the flag", () => {
		expect(names(init({ search: {} }, context).commands)).toContain("LoadIntegrationsDataSources")
		const off = pageUpdate(
			entered(),
			Message.CompletedLoadSession({ grants: Policy.allPermissions, hasDataSources: false }),
		)
		expect(names(off.commands)).not.toContain("LoadIntegrationsDataSources")
	})

	test("telemetry integrations, data sources and destinations share the Connected list", () => {
		scene(
			{ update: pageUpdate, view },
			given(hub()),
			expectView(text("Prometheus")).toExist(),
			expectView(text("shop-prod")).toExist(),
			expectView(text("ClickHouse · Production")).toExist(),
			expectView(text("14 tables")).toExist(),
			expectView(text("Acme Eng")).toExist(),
			expectView(text("Query in place")).toExist(),
			expectView(text("Infrastructure")).toExist(),
		)
	})

	test("a capability filter narrows the list and the shelves", () => {
		scene(
			{ update: pageUpdate, view },
			given(pageUpdate(hub(), Message.SelectedFilter({ filter: "query" })).model),
			expectView(text("shop-prod")).toExist(),
			expectView(text("Acme Eng")).not.toExist(),
			expectView(text("Infrastructure")).not.toExist(),
			expectView(text("Query in place")).toExist(),
		)
	})

	test("a failing data source counts as needing attention", () => {
		scene(
			{ update: pageUpdate, view },
			given(pageUpdate(hub("error"), Message.SelectedFilter({ filter: "attention" })).model),
			expectView(text("Needs attention")).toExist(),
			expectView(text("Connection error")).toExist(),
			expectView(text("Acme Eng")).not.toExist(),
		)
	})

	test("a filter whose chip is gone falls back to everything", () => {
		scene(
			{ update: pageUpdate, view },
			given(pageUpdate(hub("ok"), Message.SelectedFilter({ filter: "attention" })).model),
			expectView(text("shop-prod")).toExist(),
			expectView(text("Acme Eng")).toExist(),
			expectView(text("Infrastructure")).toExist(),
		)
	})

	test("members get no connect cards for data sources, which only admins can save", () => {
		const member = pageUpdate(
			hub(),
			Message.CompletedLoadSession({ grants: MEMBER, hasDataSources: true }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(member),
			expectView(text("shop-prod")).toExist(),
			expectView(text("Query in place")).not.toExist(),
		)
	})

	test("a failed data sources read says so instead of listing nothing", () => {
		const model = pageUpdate(
			entered(),
			Message.CompletedLoadSession({ grants: Policy.allPermissions, hasDataSources: true }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(
				pageUpdate(
					model,
					Message.CompletedLoadDataSources({
						key: model.statuses.dataSources.key ?? "",
						result: Result.fail(toLoadFailure("boom")),
					}),
				).model,
			),
			expectView(text("Couldn't check integration status")).toExist(),
		)
	})

	test("a data source row opens its page and a kind card its connect form in Settings", () => {
		expect(
			pageUpdate(hub(), Message.ClickedDataSource({ source: SOURCE_UUID, connect: null })).outMessage,
		).toEqual(
			PageOutMessage.RequestedNavigation({
				url: `/settings?tab=data-sources&source=${SOURCE_UUID}`,
				isReplace: false,
			}),
		)
		expect(
			pageUpdate(hub(), Message.ClickedDataSource({ source: null, connect: "clerk" })).outMessage,
		).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/settings?tab=data-sources&connect=clerk",
				isReplace: false,
			}),
		)
	})
})
