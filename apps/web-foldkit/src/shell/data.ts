import { formatWarehouseDateTime, snapRangeForCache } from "@maple/query-engine"
import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { lastHourWindow, loadInfraPresence } from "../data/infra-surfaces"
import { IntegrationStatuses } from "../data/integration-statuses"
import { loadServicesFacets } from "../data/services-facets-probe"
import { SessionTenant } from "../data/session-tenant"
import { Message } from "./message"

/**
 * Everything the shell loads at boot, over the S1 API clients. The data layer (S6) is designed in
 * parallel, so the loaders stay here, one Command per legacy request, each reporting one Message.
 */

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
			const surfaces = yield* loadInfraPresence(orgId, lastHourWindow(yield* Clock.currentTimeMillis))
			return Message.SucceededLoadInfraPresence({ surfaces })
		}).pipe(failed(Message.FailedLoadInfraPresence())),
})

// INTEGRATIONS

const integrationMessages = [Message.SucceededLoadIntegration, Message.FailedLoadIntegration] as const

/** The four integration statuses `useInfraSurfaces` mounts in the sidebar (connected or not). */
export const LoadCloudflareStatus = Command.define("LoadCloudflareStatus", {
	messages: integrationMessages,
	execute: Effect.gen(function* () {
		const status = yield* (yield* IntegrationStatuses).cloudflare()
		return Message.SucceededLoadIntegration({ integration: "cloudflare", isConnected: status.connected })
	}).pipe(failed(Message.FailedLoadIntegration({ integration: "cloudflare" }))),
})

export const LoadRailwayStatus = Command.define("LoadRailwayStatus", {
	messages: integrationMessages,
	execute: Effect.gen(function* () {
		const status = yield* (yield* IntegrationStatuses).railway()
		return Message.SucceededLoadIntegration({ integration: "railway", isConnected: status.connected })
	}).pipe(failed(Message.FailedLoadIntegration({ integration: "railway" }))),
})

export const LoadPlanetscaleStatus = Command.define("LoadPlanetscaleStatus", {
	messages: integrationMessages,
	execute: Effect.gen(function* () {
		const status = yield* (yield* IntegrationStatuses).planetscale()
		return Message.SucceededLoadIntegration({ integration: "planetscale", isConnected: status.connected })
	}).pipe(failed(Message.FailedLoadIntegration({ integration: "planetscale" }))),
})

/** Google Cloud counts only with metrics on: the page reads metrics, not logs. */
export const LoadGcpStatus = Command.define("LoadGcpStatus", {
	messages: integrationMessages,
	execute: Effect.gen(function* () {
		const status = yield* (yield* IntegrationStatuses).gcp()
		const isConnected = status.connectors.some((connector) => connector.metrics_enabled)
		return Message.SucceededLoadIntegration({ integration: "gcp", isConnected })
	}).pipe(failed(Message.FailedLoadIntegration({ integration: "gcp" }))),
})

// DASHBOARDS AND NAMESPACES

/**
 * `NamespaceScopeList`: the same snapped 24 h services facets probe the overview runs, read through
 * the shared probe so an answer the Overview page already has is not requested again.
 */
export const LoadNamespaces = Command.define("LoadNamespaces", {
	messages: [Message.SucceededLoadNamespaces, Message.FailedLoadNamespaces],
	execute: Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis
		const range = snapRangeForCache({
			startTime: formatWarehouseDateTime(now - 24 * 60 * 60 * 1000),
			endTime: formatWarehouseDateTime(now),
		})
		const response = yield* loadServicesFacets(range)
		const namespaces = response.data.namespaces.map((facet) => facet.name).filter((name) => name !== "")
		return Message.SucceededLoadNamespaces({ namespaces })
	}).pipe(failed(Message.FailedLoadNamespaces())),
})
