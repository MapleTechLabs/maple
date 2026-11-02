import { formatWarehouseDateTime, snapRangeForCache } from "@maple/query-engine"
import { InfraPresenceRequest } from "@maple/domain/http"
import { Clock, Effect, Option, Record, Schema } from "effect"
import { Command } from "foldkit"
import { lastHourWindow } from "../data/infra-surfaces"
import { MapleInternalApiClient } from "../platform/api-clients"
import { loadServicesFacets } from "../data/services-facets-probe"
import { loadSources, sourcesListKey } from "../page/sources/kit/data"
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

/**
 * `useInfraSurfaces`: the last hour's presence probe and every integration status, in one request.
 * A provider whose lookup failed counts as not connected.
 */
export const LoadInfraSurfaces = Command.define("LoadInfraSurfaces", {
	args: { orgId: Schema.String },
	messages: [Message.SucceededLoadInfraSurfaces, Message.FailedLoadInfraSurfaces],
	execute: ({ orgId }) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const window = lastHourWindow(now)
			const response = yield* (yield* MapleInternalApiClient).integrations.infraSurfaces({
				payload: new InfraPresenceRequest({ startTime: window.startTime, endTime: window.endTime }),
			})
			return Message.SucceededLoadInfraSurfaces({
				orgId,
				maybeSurfaces: Option.fromNullOr(response.surfaces),
				integrations: Record.map(response.integrations, (isConnected) => isConnected === true),
			})
		}).pipe(failed(Message.FailedLoadInfraSurfaces({ orgId }))),
})

/** The org's sources for the top bar's source link; a refresh re-reads past the cache. */
export const LoadSources = Command.define("LoadSources", {
	args: { orgId: Schema.String, isRefresh: Schema.Boolean },
	messages: [Message.SucceededLoadSources, Message.FailedLoadSources],
	execute: ({ orgId, isRefresh }) =>
		loadSources(sourcesListKey(orgId), isRefresh).pipe(
			Effect.map((sources) => Message.SucceededLoadSources({ orgId, sources })),
			failed(Message.FailedLoadSources({ orgId })),
		),
})

// DASHBOARDS AND NAMESPACES

const orgArgs = { orgId: Schema.String }

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
			const namespaces = response.data.namespaces
				.map((facet) => facet.name)
				.filter((name) => name !== "")
			return Message.SucceededLoadNamespaces({ orgId, namespaces })
		}).pipe(failed(Message.FailedLoadNamespaces({ orgId }))),
})
