import { formatWarehouseDateTime, snapRangeForCache } from "@maple/query-engine"
import { Clock, Effect, Schema } from "effect"
import { ShellDefinition } from "./definition"
import { lastHourWindow, loadInfraPresence } from "../data/infra-surfaces"
import { IntegrationStatuses } from "../data/integration-statuses"
import { MapleApiV2Client } from "../platform/api-clients"
import { loadServicesFacets } from "../data/services-facets-probe"
import { SessionTenant } from "../data/session-tenant"
import { Message } from "./message"

/**
 * Everything the shell loads at boot, over the S1 API clients. The data layer (S6) is designed in
 * parallel, so the loaders stay here, one Command per request, each reporting one Message.
 */

/** Every failure collapses to a fallback: the nav shows what it would without the answer. */
const failed =
	<A>(message: A) =>
	<B, E, R>(effect: Effect.Effect<B, E, R>): Effect.Effect<A | B, never, R> =>
		Effect.orElseSucceed(effect, () => message)

/** `GET /api/auth/session` through the app client: `GlobalChatSheet`'s org lookup on every page. */
export const LoadTenant = ShellDefinition.makeCommand("LoadTenant", {
	messages: [Message.SucceededLoadTenant, Message.FailedLoadTenant],
	handler: function* () {
		return () =>
			Effect.gen(function* () {
				const tenant = yield* (yield* SessionTenant).get
				return Message.SucceededLoadTenant({ orgId: tenant.orgId })
			}).pipe(failed(Message.FailedLoadTenant()))
	},
})

/** `infraPresenceResultAtom`: which OTel infrastructure surfaces reported in the last hour. */
export const LoadInfraPresence = ShellDefinition.makeCommand("LoadInfraPresence", {
	args: { orgId: Schema.String },
	messages: [Message.SucceededLoadInfraPresence, Message.FailedLoadInfraPresence],
	handler: function* () {
		return ({ orgId }) =>
			Effect.gen(function* () {
				const surfaces = yield* loadInfraPresence(
					orgId,
					lastHourWindow(yield* Clock.currentTimeMillis),
				)
				return Message.SucceededLoadInfraPresence({ orgId, surfaces })
			}).pipe(failed(Message.FailedLoadInfraPresence({ orgId })))
	},
})

// INTEGRATIONS

const integrationMessages = [Message.SucceededLoadIntegration, Message.FailedLoadIntegration] as const
const orgArgs = { orgId: Schema.String }

/** The four integration statuses `useInfraSurfaces` mounts in the sidebar (connected or not). */
export const LoadCloudflareStatus = ShellDefinition.makeCommand("LoadCloudflareStatus", {
	args: orgArgs,
	messages: integrationMessages,
	handler: function* () {
		return ({ orgId }) =>
			Effect.gen(function* () {
				const status = yield* (yield* IntegrationStatuses).cloudflare({ orgId })
				return Message.SucceededLoadIntegration({
					orgId,
					integration: "cloudflare",
					isConnected: status.connected,
				})
			}).pipe(failed(Message.FailedLoadIntegration({ orgId, integration: "cloudflare" })))
	},
})

export const LoadRailwayStatus = ShellDefinition.makeCommand("LoadRailwayStatus", {
	args: orgArgs,
	messages: integrationMessages,
	handler: function* () {
		return ({ orgId }) =>
			Effect.gen(function* () {
				const status = yield* (yield* IntegrationStatuses).railway({ orgId })
				return Message.SucceededLoadIntegration({
					orgId,
					integration: "railway",
					isConnected: status.connected,
				})
			}).pipe(failed(Message.FailedLoadIntegration({ orgId, integration: "railway" })))
	},
})

export const LoadPlanetscaleStatus = ShellDefinition.makeCommand("LoadPlanetscaleStatus", {
	args: orgArgs,
	messages: integrationMessages,
	handler: function* () {
		return ({ orgId }) =>
			Effect.gen(function* () {
				const status = yield* (yield* IntegrationStatuses).planetscale({ orgId })
				return Message.SucceededLoadIntegration({
					orgId,
					integration: "planetscale",
					isConnected: status.connected,
				})
			}).pipe(failed(Message.FailedLoadIntegration({ orgId, integration: "planetscale" })))
	},
})

/** Google Cloud counts only with metrics on: the page reads metrics, not logs. */
export const LoadGcpStatus = ShellDefinition.makeCommand("LoadGcpStatus", {
	args: orgArgs,
	messages: integrationMessages,
	handler: function* () {
		return ({ orgId }) =>
			Effect.gen(function* () {
				const status = yield* (yield* IntegrationStatuses).gcp({ orgId })
				const isConnected = status.connectors.some((connector) => connector.metrics_enabled)
				return Message.SucceededLoadIntegration({ orgId, integration: "gcp", isConnected })
			}).pipe(failed(Message.FailedLoadIntegration({ orgId, integration: "gcp" })))
	},
})

/** Supabase counts once an organization is connected (its projects are listed even before metrics). */
export const LoadSupabaseStatus = ShellDefinition.makeCommand("LoadSupabaseStatus", {
	args: orgArgs,
	messages: integrationMessages,
	handler: function* () {
		return ({ orgId }) =>
			Effect.gen(function* () {
				const status = yield* (yield* IntegrationStatuses).supabase({ orgId })
				return Message.SucceededLoadIntegration({
					orgId,
					integration: "supabase",
					isConnected: status.connected,
				})
			}).pipe(failed(Message.FailedLoadIntegration({ orgId, integration: "supabase" })))
	},
})

// DASHBOARDS AND NAMESPACES

/**
 * `NamespaceScopeList`: the same snapped 24 h services facets probe the overview runs, read through
 * the shared probe under the shell's org, so an answer the Overview page already has is reused.
 */
export const LoadNamespaces = ShellDefinition.makeCommand("LoadNamespaces", {
	args: orgArgs,
	messages: [Message.SucceededLoadNamespaces, Message.FailedLoadNamespaces],
	handler: function* () {
		return ({ orgId }) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const range = snapRangeForCache({
					startTime: formatWarehouseDateTime(now - 24 * 60 * 60 * 1000),
					endTime: formatWarehouseDateTime(now),
				})
				const response = yield* loadServicesFacets(range, { orgId })
				const namespaces = response.data.namespaces
					.map((facet) => facet.name)
					.filter((name) => name !== "")
				return Message.SucceededLoadNamespaces({ orgId, namespaces })
			}).pipe(failed(Message.FailedLoadNamespaces({ orgId })))
	},
})

/** AWS counts once an account is connected, like every provider: a stream built outside Maple leaves `metric_stream` null. */
export const LoadAwsStatus = ShellDefinition.makeCommand("LoadAwsStatus", {
	args: orgArgs,
	messages: integrationMessages,
	handler: function* () {
		return ({ orgId }) =>
			Effect.gen(function* () {
				const status = yield* (yield* MapleApiV2Client).awsIntegration.status()
				const isConnected = status.connections.length > 0
				return Message.SucceededLoadIntegration({ orgId, integration: "aws", isConnected })
			}).pipe(failed(Message.FailedLoadIntegration({ orgId, integration: "aws" })))
	},
})
