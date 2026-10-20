import { AlertIncidentId } from "@maple/domain/http"
import { V2AlertRulePreviewParams, V2InvestigationCreateParams } from "@maple/domain/http/v2"
import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { listDeliveries } from "../shared/commands"
import { fetchPreview } from "../shared/preview"
import { Message } from "./message"

export const ReadIncidentClock = Command.define("ReadAlertIncidentClock", {
	messages: [Message.ReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadClock({ nowMs })),
})

export const FetchIncidentPreview = Command.define("FetchAlertIncidentPreview", {
	args: { key: Schema.String, payload: V2AlertRulePreviewParams },
	messages: [Message.CompletedFetchPreview],
	execute: ({ key, payload }) =>
		fetchPreview(payload).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchPreview({ key, result })),
		),
})

export const FetchIncidentDeliveries = Command.define("FetchAlertIncidentDeliveries", {
	args: { key: Schema.String, incidentId: AlertIncidentId },
	messages: [Message.CompletedFetchDeliveries],
	execute: ({ key, incidentId }) =>
		listDeliveries(incidentId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchDeliveries({ key, result })),
		),
})

/** `investigations.list({ incident_kind: "alert", incident_id, limit: 1 })`: the incident's one. */
export const FetchIncidentInvestigation = Command.define("FetchAlertIncidentInvestigation", {
	args: { key: Schema.String, incidentId: AlertIncidentId },
	messages: [Message.CompletedFetchInvestigation],
	execute: ({ key, incidentId }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const page = yield* client.investigations.list({
				query: { incident_kind: "alert", incident_id: incidentId, limit: 1 },
			})
			return page.data[0] ?? null
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchInvestigation({ key, result })),
		),
})

export const CreateInvestigation = Command.define("CreateAlertInvestigation", {
	args: { payload: V2InvestigationCreateParams },
	messages: [Message.CompletedCreateInvestigation],
	execute: ({ payload }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const investigation = yield* client.investigations.create({ payload })
			return String(investigation.id)
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedCreateInvestigation({ result })),
		),
})
