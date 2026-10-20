import { Effect, Option, Schema } from "effect"
import { Command } from "foldkit"
import { getServicesFacets } from "@maple/web-data/warehouse/services"
import { currentWindow, TimeWindow } from "../../data/time-range"
import { toWarehouseFailure } from "../../data/warehouse-error"
import { MapleAuthApi, readSessionToken } from "../../platform/auth-api"
import { Message, RequestMode } from "./model"

/** The lab boots without the app shell, so it resolves its own org from the stored session. */
export const CheckProbeSession = Command.define("CheckProbeSession", {
	messages: [Message.SucceededCheckProbeSession, Message.FailedCheckProbeSession],
	execute: Effect.gen(function* () {
		const maybeToken = yield* readSessionToken
		if (Option.isNone(maybeToken)) return Message.FailedCheckProbeSession({ session: "SignedOut" })
		const auth = yield* MapleAuthApi
		const tenant = yield* auth.session(maybeToken.value)
		return Message.SucceededCheckProbeSession({ orgId: tenant.orgId })
	}).pipe(
		Effect.catchTag("@maple/web/SessionCheckError", (error) =>
			Effect.succeed(
				Message.FailedCheckProbeSession({
					session: error.reason === "Rejected" ? "SignedOut" : "Unreachable",
				}),
			),
		),
	),
})

/** `/services`' default window ("12h"), snapped on entry, re-resolved unsnapped on refresh. */
export const ResolveWindow = Command.define("ResolveWindow", {
	args: { mode: RequestMode },
	messages: [Message.CompletedResolveWindow],
	execute: ({ mode }) =>
		Effect.map(currentWindow({ preset: "12h", snap: mode === "Load" }), (window) =>
			Message.CompletedResolveWindow({ window, mode }),
		),
})

/**
 * Carries its request key back so `update` drops a superseded answer. Not interruptible: the query
 * already rides its batch and the warehouse runs it anyway, so cancelling would save nothing.
 */
export const FetchServicesFacets = Command.define("FetchServicesFacets", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchServicesFacets],
	execute: ({ key, window }) =>
		getServicesFacets({ data: window }).pipe(
			Effect.map((response) => response.data),
			Effect.mapError(toWarehouseFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchServicesFacets({ key, result })),
		),
})
