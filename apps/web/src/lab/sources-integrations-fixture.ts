import { CloudflareIntegrationStatus } from "@maple/domain/http"
import { V2PlanetScaleIntegration, V2PlanetScaleOrganizationList } from "@maple/domain/http/v2"
import { Result, Schema, Array as Arr } from "effect"
import type { PageContext } from "../page/contract"
import { Message as IntegrationsMessage } from "../page/integrations/message"
import type { Model as IntegrationsModel } from "../page/integrations/model"
import { init as integrationsInit, update as integrationsUpdate } from "../page/integrations/update"
import { PlanetscaleMessage } from "../page/infra-integrations/planetscale/integration/planetscale"
import { Message as NewMessage } from "../page/sources/new/message"
import type { Model as NewModel } from "../page/sources/new/model"
import { init as newInit, update as newUpdate } from "../page/sources/new/update"
import { AppRoute } from "../route"
import type * as Policy from "@maple/domain/policy"

// `/lab/sources?page=cloudflare|planetscale` (the connect flow one step after Connect) and
// `cloudflare-card|planetscale-card` (the connected integration's card), over fixture statuses.

export const INTEGRATION_PAGES = ["cloudflare", "planetscale", "cloudflare-card", "planetscale-card"] as const
export type IntegrationLabPage = (typeof INTEGRATION_PAGES)[number]

const NOW = Date.UTC(2026, 10, 6, 12)

const zone = (id: string, name: string) => ({
	id,
	name,
	enabled: true,
	watched: true,
	lastSyncedAt: NOW - 60_000,
	lastError: null,
	watermarkAt: NOW - 120_000,
	backfillAt: null,
})

const ZONES = [zone("z1", "maple.dev"), zone("z2", "api.maple.dev"), zone("z3", "status.maple.dev")]

/** DNS and Durable Objects switched off; everything else on. */
const CLOUDFLARE = Schema.decodeSync(CloudflareIntegrationStatus)({
	connected: true,
	accountId: "acc_1",
	accountName: "Maki Account",
	connectedByUserId: null,
	scope: "analytics.read",
	analyticsCapable: true,
	connectedAt: NOW - 86_400_000,
	accounts: [
		{
			accountId: "acc_1",
			accountName: "Maki Account",
			connectedByUserId: null,
			scope: "analytics.read",
			analyticsCapable: true,
			revoked: false,
			zones: ZONES,
			workers: null,
			watchNewZones: true,
		},
	],
	zones: ZONES,
	workers: null,
	features: {
		httpTrafficEnabled: true,
		firewallEnabled: true,
		dnsEnabled: false,
		workersEnabled: true,
		queuesEnabled: true,
		durableObjectsEnabled: false,
	},
})

/** Metrics on, events off (so Maple removed its webhooks). */
const PLANETSCALE = Schema.decodeSync(V2PlanetScaleIntegration)({
	object: "planetscale_integration",
	connected: true,
	pending_org_selection: false,
	organization: "acme",
	connected_by_user_id: null,
	detected_permissions: { readDatabases: true },
	metrics_auth: "api",
	api_metrics: { last_polled_at: "2026-11-06T11:58:00.000Z", last_error: null },
	scrape_target: null,
	webhooks: { state: "active", registered_databases: 3, databases: 3, last_error: null },
	metrics_enabled: true,
	events_enabled: false,
	last_inventory_at: "2026-11-06T11:00:00.000Z",
	last_inventory_error: null,
	revoked_at: null,
	expires_at: null,
})

const ORGANIZATIONS = Schema.decodeSync(V2PlanetScaleOrganizationList)({
	object: "planetscale_integration.organization_list",
	organizations: [{ id: "org_1", name: "acme" }],
})

const isCloudflare = (page: IntegrationLabPage) => page === "cloudflare" || page === "cloudflare-card"

/** The statuses as the hub reads them, then PlanetScale's organization list. */
const loaded = (model: IntegrationsModel, page: IntegrationLabPage): ReadonlyArray<IntegrationsMessage> => [
	IntegrationsMessage.CompletedReadClock({ nowMs: NOW }),
	isCloudflare(page)
		? IntegrationsMessage.CompletedLoadCloudflare({
				key: model.statuses.cloudflare.key ?? "",
				result: Result.succeed(CLOUDFLARE),
			})
		: IntegrationsMessage.CompletedLoadPlanetscale({
				key: model.statuses.planetscale.key ?? "",
				result: Result.succeed(PLANETSCALE),
			}),
]

const organizationsLoaded = (model: IntegrationsModel): IntegrationsMessage =>
	IntegrationsMessage.GotPlanetscaleMessage({
		message: PlanetscaleMessage.CompletedFetchOrganizations({
			key: model.planetscaleCard.organizations.key ?? "",
			result: Result.succeed(ORGANIZATIONS),
		}),
	})

/** The connected card on the integration's page. */
export const integrationCardModel = (page: IntegrationLabPage, context: PageContext): IntegrationsModel => {
	const step = (model: IntegrationsModel, message: IntegrationsMessage) =>
		integrationsUpdate(model, message, context).model
	const entered = integrationsInit(
		{ search: { integration: isCloudflare(page) ? "cloudflare" : "planetscale" } },
		context,
	).model
	const withStatus = Arr.reduce(loaded(entered, page), entered, step)
	return isCloudflare(page) ? withStatus : step(withStatus, organizationsLoaded(withStatus))
}

/** The connect flow, one Continue past Connect. */
export const integrationFlowModel = (
	page: IntegrationLabPage,
	context: PageContext,
	grants: ReadonlyArray<Policy.Permission>,
): NewModel => {
	const step = (model: NewModel, message: NewMessage) => newUpdate(model, message, context).model
	const inner = (model: NewModel, message: IntegrationsMessage) =>
		step(model, NewMessage.GotIntegrationsMessage({ message }))
	const entered = newInit(
		AppRoute.SourcesNew({ search: { integration: isCloudflare(page) ? "cloudflare" : "planetscale" } }),
		context,
	).model
	const granted = step(entered, NewMessage.CompletedReadGrants({ grants }))
	const withStatus = Arr.reduce(loaded(granted.integrations, page), granted, inner)
	const ready = isCloudflare(page)
		? withStatus
		: inner(withStatus, organizationsLoaded(withStatus.integrations))
	return Arr.reduce([NewMessage.ClickedContinue(), NewMessage.CompletedScrollToTop()], ready, step)
}
