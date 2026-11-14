import { SearchConsoleAvailableSitesResponse, SearchConsoleIntegrationStatus } from "@maple/domain/http"
import { Schema, Array as Arr } from "effect"
import { AsyncData, Submodel, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { Message as IntegrationsMessage } from "../page/integrations/message"
import { Model as IntegrationsModel } from "../page/integrations/model"
import * as Integrations from "../page/integrations/update"
import { searchConsoleCard } from "../page/integrations/view-search-console"
import { dashboardPage } from "../page/kit/dashboard-page"
import type { Resources } from "../platform/resources"
import { LAB_CONTEXT } from "./gcp-host"

// `/lab/search-console`: the Google Search Console card in each state, over fixtures.

const decodeStatus = Schema.decodeSync(SearchConsoleIntegrationStatus)

const status = (fields: Readonly<{ connected: boolean; revoked?: boolean; lastError?: string }>) =>
	decodeStatus({
		configured: true,
		connected: fields.connected,
		accountEmail: fields.connected ? "owner@acme.dev" : null,
		connectedByUserId: null,
		revoked: fields.revoked ?? false,
		sites: fields.connected
			? [
					{
						id: "0190f2b3-0000-7000-8000-000000000001",
						siteUrl: "sc-domain:acme.dev",
						permissionLevel: "siteOwner",
						enabled: true,
						watermarkDate: null,
						backfillDate: null,
						lastSyncedAt: null,
						lastError: fields.lastError ?? null,
					},
				]
			: [],
	})

const SITES = Schema.decodeSync(SearchConsoleAvailableSitesResponse)({
	sites: [
		{ siteUrl: "sc-domain:acme.dev", permissionLevel: "siteOwner", selectable: true, enabled: true },
		{
			siteUrl: "https://blog.acme.dev/",
			permissionLevel: "siteFullUser",
			selectable: true,
			enabled: false,
		},
		{
			siteUrl: "https://staging.acme.dev/",
			permissionLevel: "siteUnverifiedUser",
			selectable: false,
			enabled: false,
		},
	],
})

/** The page's Model on the Search Console card with `loaded` as its status, never requested. */
const hubWith = (
	loaded: SearchConsoleIntegrationStatus,
	options: Readonly<{ isRefreshing?: boolean; isConnecting?: boolean }> = {},
): IntegrationsModel => {
	const hub = Integrations.init({ search: { integration: "google-search-console" } }, LAB_CONTEXT).model
	return {
		...hub,
		grants: ["integrations:manage"],
		connect: options.isConnecting
			? { ...hub.connect, attempts: 1, active: { provider: "google-search-console", attempt: 1 } }
			: hub.connect,
		statuses: {
			...hub.statuses,
			searchConsole: {
				key: null,
				data: options.isRefreshing
					? AsyncData.Refreshing({ data: loaded })
					: AsyncData.Success({ data: loaded }),
			},
		},
		searchConsoleCard: {
			...hub.searchConsoleCard,
			sites: { key: null, data: AsyncData.Success({ data: SITES }) },
		},
	}
}

const scenarios = (): ReadonlyArray<{ title: string; hub: IntegrationsModel }> => [
	{ title: "Not connected", hub: hubWith(status({ connected: false })) },
	{ title: "Google's window is open", hub: hubWith(status({ connected: false }), { isConnecting: true }) },
	{
		title: "Window closed, status re-read in flight",
		hub: hubWith(status({ connected: false }), { isRefreshing: true }),
	},
	{ title: "Connected", hub: hubWith(status({ connected: true })) },
	{
		title: "Import failing",
		hub: hubWith(
			status({ connected: true, lastError: "Google answered 403: User does not have access." }),
		),
	},
	{ title: "Revoked", hub: hubWith(status({ connected: true, revoked: true })) },
]

export const Model = Schema.Struct({
	titles: Schema.Array(Schema.String),
	hubs: Schema.Array(IntegrationsModel),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({ GotHubMessage: { message: IntegrationsMessage } })
export type Message = typeof Message.Type

export type Return = Update.Return<Model, Message, Resources>

export const init = (): Return => {
	const all = scenarios()
	return {
		model: {
			titles: Arr.map(all, (scenario) => scenario.title),
			hubs: Arr.map(all, (scenario) => scenario.hub),
		},
	}
}

/** The cards are fixed pictures: clicks change nothing. */
export const update = (model: Model): Return => ({ model })

const cardView = Submodel.defineView<IntegrationsModel, IntegrationsMessage, Readonly<{ title: string }>>(
	(hub, inputs, h) =>
		h.section(
			[h.Class("flex flex-col gap-2")],
			[h.h2([h.Class("text-xs text-muted-foreground")], [inputs.title]), searchConsoleCard(h, hub)],
		),
)

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	dashboardPage(h, {}, [
		h.div(
			[h.Class("mx-auto flex w-full max-w-3xl flex-col gap-8 p-4")],
			Arr.map(model.hubs, (hub, index) =>
				h.submodel({
					slotId: `search-console-lab-${index}`,
					model: hub,
					view: cardView,
					viewInputs: { title: model.titles[index] ?? "" },
					toParentMessage: (message) => Message.GotHubMessage({ message }),
				}),
			),
		),
	])
