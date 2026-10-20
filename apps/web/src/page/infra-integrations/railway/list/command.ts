import { RailwayConnectRequest } from "@maple/domain/http"
import { displayError, isUnexpectedError } from "@maple/web-data/lib/error-messages"
import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { IntegrationStatuses } from "../../../../data/integration-statuses"
import { resolveWindow, TimeWindow } from "../../../../data/time-range"
import { MapleInternalApiClient } from "../../../../platform/api-clients"
import { loadRailwayServices, loadRailwayStatus } from "../data"
import { Message, RequestMode } from "./message"

export const ResolveWindow = Command.define("ResolveRailwayWindow", {
	args: {
		mode: RequestMode,
		startTime: Schema.optional(Schema.String),
		endTime: Schema.optional(Schema.String),
		preset: Schema.String,
		timeZone: Schema.String,
	},
	messages: [Message.CompletedResolveWindow],
	execute: ({ mode, startTime, endTime, preset, timeZone }) =>
		Effect.map(Clock.currentTimeMillis, (nowMs) =>
			Message.CompletedResolveWindow({
				window: resolveWindow({ startTime, endTime, preset, snap: mode === "Load", timeZone }, nowMs),
				nowMs,
				mode,
			}),
		),
})

/** `railwayStatusAtom`, shared with the sidebar through `IntegrationStatuses`. */
export const LoadStatus = Command.define("LoadRailwayStatus", {
	args: { key: Schema.String, refresh: Schema.Boolean },
	messages: [Message.CompletedLoadStatus],
	execute: ({ key, refresh }) =>
		Effect.map(loadRailwayStatus(refresh), (result) => Message.CompletedLoadStatus({ key, result })),
})

/** `railwayServicesResultAtom({ data: window })`. */
export const FetchServices = Command.define("FetchRailwayServices", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchServices],
	execute: ({ key, window }) =>
		Effect.map(loadRailwayServices(window), (result) => Message.CompletedFetchServices({ key, result })),
})

const RELOAD_SPIN = Duration.millis(600)

export const CompleteReloadSpin = Command.define("CompleteRailwayReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) => Effect.as(Effect.sleep(RELOAD_SPIN), Message.CompletedReloadSpin({ version })),
})

/** `integrations.railwayConnect`; a success revalidates the shared status (`reactivityKeys`). */
export const ConnectRailway = Command.define("ConnectRailway", {
	args: { token: Schema.String },
	messages: [Message.SucceededConnect, Message.FailedConnect],
	execute: ({ token }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			const status = yield* client.integrations.railwayConnect({
				payload: new RailwayConnectRequest({ token }),
			})
			const statuses = yield* IntegrationStatuses
			const refreshed = yield* Effect.orElseSucceed(statuses.railway({ refresh: true }), () => status)
			return Message.SucceededConnect({ status: refreshed })
		}).pipe(
			Effect.catch((error) => {
				const presentation = displayError(error)
				return Effect.succeed(
					Message.FailedConnect({
						error: isUnexpectedError(presentation)
							? "Failed to connect Railway."
							: presentation.message,
					}),
				)
			}),
		),
})
