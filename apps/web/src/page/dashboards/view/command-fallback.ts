import { DashboardId } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { documentOf } from "./command-history"
import { Message } from "./message"

const decodeDashboardId = Schema.decodeUnknownEffect(DashboardId)

const FALLBACK_TIMEOUT = "10 seconds"

/** Why the snapshot was read: the live board timed out, or the viewer asked again. */
export const FallbackReason = Schema.Literals(["live_sync_timeout", "retry"])

/** The board over plain HTTP while the shape stream is down (`useDashboardsFallback` for one board). */
export const FetchDashboardFallback = Command.define("FetchDashboardFallback", {
	args: { dashboardId: Schema.String, reason: FallbackReason },
	messages: [Message.CompletedFetchDashboardFallback],
	execute: ({ dashboardId, reason }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const id = yield* decodeDashboardId(dashboardId)
			const dashboard = yield* client.dashboards.retrieve({ params: { id } })
			return yield* documentOf(dashboard)
		}).pipe(
			// A hung read gives up too, so the board lands on its error state.
			Effect.timeout(FALLBACK_TIMEOUT),
			Effect.withSpan("dashboard.board.fetchFallback", {
				attributes: { "maple.dashboard.fallback_reason": reason },
			}),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchDashboardFallback({ dashboardId, result })),
		),
})
