import { InfraPresenceRequest } from "@maple/domain/http"
import { formatWarehouseDateTime, snapRangeForCache } from "@maple/query-engine"
import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { IntegrationStatuses } from "../data/integration-statuses"
import { loadServicesFacets } from "../data/services-facets-probe"
import { SessionTenant } from "../data/session-tenant"
import { MapleInternalApiClient } from "../platform/api-clients"
import { Message } from "./message"

/**
 * Everything the shell loads at boot, over the S1 API clients. The data layer (S6) is designed in
 * parallel, so the loaders stay here, one Command per legacy request, each reporting one Message.
 */

/** `useInfraSurfaces`: the last hour, snapped to 5 minutes so the key holds still. */
const PRESENCE_WINDOW_MS = 60 * 60 * 1000
const PRESENCE_BUCKET_MS = 5 * 60 * 1000

/** Every failure collapses like legacy's `orElse`: the nav shows what it would without the answer. */
const failed =
	<A>(message: A) =>
	<B, E, R>(effect: Effect.Effect<B, E, R>): Effect.Effect<A | B, never, R> =>
		Effect.orElseSucceed(effect, () => message)

/** `GET /api/auth/session` through the app client: `GlobalChatSheet`'s org lookup on every page. */
export const LoadTenant = Command.define("LoadTenant", {
	messages: [Message.SucceededLoadTenant, Message.FailedLoadTenant],
	execute: Effect.gen(function* () {
		const tenant = yield* (yield* SessionTenant).get
		return Message.SucceededLoadTenant({ orgId: tenant.orgId })
	}).pipe(failed(Message.FailedLoadTenant())),
})


/** `infraPresenceResultAtom`: which OTel infrastructure surfaces reported in the last hour. */
export const LoadInfraPresence = Command.define("LoadInfraPresence", {
	args: { orgId: Schema.String },
	messages: [Message.SucceededLoadInfraPresence, Message.FailedLoadInfraPresence],
	execute: ({ orgId }) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const end = Math.floor(now / PRESENCE_BUCKET_MS) * PRESENCE_BUCKET_MS
			const client = yield* MapleInternalApiClient
			const response = yield* client.queryEngine.infraPresence({
				payload: new InfraPresenceRequest({
					startTime: formatWarehouseDateTime(end - PRESENCE_WINDOW_MS),
					endTime: formatWarehouseDateTime(end),
				}),
			})
			return Message.SucceededLoadInfraPresence({ orgId, surfaces: response.surfaces })
		}).pipe(failed(Message.FailedLoadInfraPresence({ orgId }))),
})
// INTEGRATIONS

const integrationMessages = [Message.SucceededLoadIntegration, Message.FailedLoadIntegration] as const
const orgArgs = { orgId: Schema.String }

/** The four integration statuses `useInfraSurfaces` mounts in the sidebar (connected or not). */
export const LoadCloudflareStatus = Command.define("LoadCloudflareStatus", {
	args: orgArgs,
	messages: integrationMessages,
	execute: ({ orgId }) =>
		Effect.gen(function* () {
			const status = yield* (yield* IntegrationStatuses).cloudflare({ orgId })
			return Message.SucceededLoadIntegration({ orgId, integration: "cloudflare", isConnected: status.connected })
		}).pipe(failed(Message.FailedLoadIntegration({ orgId, integration: "cloudflare" }))),
})

export const LoadRailwayStatus = Command.define("LoadRailwayStatus", {
	args: orgArgs,
	messages: integrationMessages,
	execute: ({ orgId }) =>
		Effect.gen(function* () {
			const status = yield* (yield* IntegrationStatuses).railway({ orgId })
			return Message.SucceededLoadIntegration({ orgId, integration: "railway", isConnected: status.connected })
		}).pipe(failed(Message.FailedLoadIntegration({ orgId, integration: "railway" }))),
})

export const LoadPlanetscaleStatus = Command.define("LoadPlanetscaleStatus", {
	args: orgArgs,
	messages: integrationMessages,
	execute: ({ orgId }) =>
		Effect.gen(function* () {
			const status = yield* (yield* IntegrationStatuses).planetscale({ orgId })
			return Message.SucceededLoadIntegration({ orgId, integration: "planetscale", isConnected: status.connected })
		}).pipe(failed(Message.FailedLoadIntegration({ orgId, integration: "planetscale" }))),
})

/** Google Cloud counts only with metrics on: the page reads metrics, not logs. */
export const LoadGcpStatus = Command.define("LoadGcpStatus", {
	args: orgArgs,
	messages: integrationMessages,
	execute: ({ orgId }) =>
		Effect.gen(function* () {
			const status = yield* (yield* IntegrationStatuses).gcp({ orgId })
			const isConnected = status.connectors.some((connector) => connector.metrics_enabled)
			return Message.SucceededLoadIntegration({ orgId, integration: "gcp", isConnected })
		}).pipe(failed(Message.FailedLoadIntegration({ orgId, integration: "gcp" }))),
})

// DASHBOARDS AND NAMESPACES

/**
 * `NamespaceScopeList`: the same snapped 24 h services facets probe the overview runs, read through
 * the shared probe under the shell's org, so an answer the Overview page already has is reused.
 */
export const LoadNamespaces = Command.define("LoadNamespaces", {
	args: orgArgs,
	messages: [Message.SucceededLoadNamespaces, Message.FailedLoadNamespaces],
	execute: ({ orgId }) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const range = snapRangeForCache({
				startTime: formatWarehouseDateTime(now - 24 * 60 * 60 * 1000),
				endTime: formatWarehouseDateTime(now),
			})
			const response = yield* loadServicesFacets(range, { orgId })
			const namespaces = response.data.namespaces.map((facet) => facet.name).filter((name) => name !== "")
			return Message.SucceededLoadNamespaces({ orgId, namespaces })
		}).pipe(failed(Message.FailedLoadNamespaces({ orgId }))),
})
