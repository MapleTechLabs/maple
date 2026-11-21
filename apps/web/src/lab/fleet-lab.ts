import { FleetIntegrationStatus } from "@maple/domain/http"
import { Schema, Array as Arr } from "effect"
import { AsyncData, Submodel, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as Field from "@maple/views/ui/field"
import { initFleetForm } from "../page/integrations/fleet/fleet"
import { fleetCard } from "../page/integrations/fleet/view-fleet"
import { Message as IntegrationsMessage } from "../page/integrations/message"
import { Model as IntegrationsModel } from "../page/integrations/model"
import * as Integrations from "../page/integrations/update"
import { dashboardPage } from "../page/kit/dashboard-page"
import type { Resources } from "../platform/resources"
import { LAB_CONTEXT } from "./gcp-host"

// `/lab/fleet`: the Fleet card in each state, over fixtures.

const NOW = Date.UTC(2026, 10, 20, 12)

const status = (overrides: Partial<typeof FleetIntegrationStatus.Encoded> = {}) =>
	Schema.decodeSync(FleetIntegrationStatus)({
		connected: true,
		baseUrl: "https://fleet.acme.dev",
		organizationName: "Acme",
		apiUserName: "Maple",
		apiUserRole: "observer",
		serverVersion: "4.62.1",
		licenseTier: "premium",
		connectedByUserId: null,
		connectedAt: NOW - 3 * 86_400_000,
		authFailed: false,
		lastSyncedAt: NOW - 4 * 60_000,
		lastError: null,
		...overrides,
	})

const DISCONNECTED = status({
	connected: false,
	baseUrl: null,
	organizationName: null,
	apiUserName: null,
	apiUserRole: null,
	serverVersion: null,
	licenseTier: null,
	connectedAt: null,
	lastSyncedAt: null,
})

/** The page's Model on the Fleet card with `loaded` as its status, never requested. */
const hubWith = (
	loaded: FleetIntegrationStatus,
	options: Readonly<{ form?: IntegrationsModel["fleetCard"]["form"]; canManage?: boolean }> = {},
): IntegrationsModel => {
	const hub = Integrations.init({ search: { integration: "fleet" } }, LAB_CONTEXT).model
	return {
		...hub,
		nowMs: NOW,
		grants: options.canManage === false ? [] : ["integrations:manage"],
		statuses: { ...hub.statuses, fleet: { key: null, data: AsyncData.Success({ data: loaded }) } },
		fleetCard: {
			...hub.fleetCard,
			form:
				options.form ??
				(loaded.authFailed && loaded.baseUrl !== null
					? initFleetForm(loaded.baseUrl)
					: hub.fleetCard.form),
		},
	}
}

const scenarios = (): ReadonlyArray<{ title: string; hub: IntegrationsModel }> => [
	{ title: "Not connected", hub: hubWith(DISCONNECTED) },
	{
		title: "Connect error",
		hub: hubWith(DISCONNECTED, {
			form: {
				url: Field.init("https://fleet.acme.dev"),
				token: Field.init("fleet_token_0001"),
				isSubmitting: false,
				error: "This token's user has no global role in Fleet. Give the API-only user the Observer role.",
			},
		}),
	},
	{ title: "Connected", hub: hubWith(status()) },
	{ title: "Connected with an admin token", hub: hubWith(status({ apiUserRole: "admin" })) },
	{
		title: "Token rejected",
		hub: hubWith(status({ authFailed: true, lastError: "Fleet answered 401: Authentication required." })),
	},
	{ title: "Connected, read-only member", hub: hubWith(status(), { canManage: false }) },
	{ title: "Not connected, read-only member", hub: hubWith(DISCONNECTED, { canManage: false }) },
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
			[h.h2([h.Class("text-xs text-muted-foreground")], [inputs.title]), fleetCard(h, hub, "UTC")],
		),
)

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	dashboardPage(h, {}, [
		h.div(
			[h.Class("mx-auto flex w-full max-w-3xl flex-col gap-8 p-4")],
			Arr.map(model.hubs, (hub, index) =>
				h.submodel({
					slotId: `fleet-lab-${index}`,
					model: hub,
					view: cardView,
					viewInputs: { title: model.titles[index] ?? "" },
					toParentMessage: (message) => Message.GotHubMessage({ message }),
				}),
			),
		),
	])
