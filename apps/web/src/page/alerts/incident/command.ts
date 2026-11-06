import { AlertIncidentId, AlertRuleId, AnomalyIncidentId, IsoDateTimeString } from "@maple/domain/http"
import { V2AlertRulePreviewParams, V2InvestigationCreateParams } from "@maple/domain/http/v2"
import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { listDeliveries, listIncidentActivity, setIncidentAcknowledged } from "../shared/commands"
import { listSlos } from "../shared/slo-commands"
import { listMonitors } from "../shared/uptime-commands"
import { listActiveSilences } from "../shared/silences"
import { readGrants } from "../../../data/session-tenant"
import { fetchCheckSummary } from "../shared/check-summary"
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

export const FetchIncidentChecks = Command.define("FetchAlertIncidentChecks", {
	args: { key: Schema.String, ruleId: AlertRuleId, since: IsoDateTimeString, until: IsoDateTimeString },
	messages: [Message.CompletedFetchChecks],
	execute: ({ key, ruleId, since, until }) =>
		fetchCheckSummary(ruleId, since, until).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchChecks({ key, result })),
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

export const FetchIncidentActivity = Command.define("FetchAlertIncidentActivity", {
	args: { key: Schema.String, incidentId: AlertIncidentId },
	messages: [Message.CompletedFetchActivity],
	execute: ({ key, incidentId }) =>
		listIncidentActivity(incidentId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchActivity({ key, result })),
		),
})

export const SetIncidentAcknowledged = Command.define("SetAlertIncidentAcknowledged", {
	args: { incidentId: AlertIncidentId, acknowledged: Schema.Boolean },
	messages: [Message.CompletedSetAcknowledged],
	execute: ({ incidentId, acknowledged }) =>
		setIncidentAcknowledged(incidentId, acknowledged).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedSetAcknowledged({ acknowledged, result })),
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

/** An SLO incident's SLOs, to find the one whose burn-rate rule opened it. */
export const FetchIncidentSlos = Command.define("FetchAlertIncidentSlos", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchSlos],
	execute: ({ key }) =>
		listSlos.pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSlos({ key, result })),
		),
})

/** An uptime incident's monitors, to find the one whose rule opened it. */
export const FetchIncidentMonitors = Command.define("FetchAlertIncidentMonitors", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchMonitors],
	execute: ({ key }) =>
		listMonitors.pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchMonitors({ key, result })),
		),
})

/** An anomaly rule's incident: the anomaly the detector opened, its evidence. */
export const FetchIncidentAnomaly = Command.define("FetchAlertIncidentAnomaly", {
	args: { key: Schema.String, id: AnomalyIncidentId },
	messages: [Message.CompletedFetchAnomaly],
	execute: ({ key, id }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const result = yield* client.anomalies
				.getIncident({ params: { id } })
				.pipe(Effect.mapError(toLoadFailure), Effect.result)
			return Message.CompletedFetchAnomaly({ key, result })
		}),
})

/** The anomaly's signal around it, with its baseline and threshold. */
export const FetchIncidentAnomalyTimeseries = Command.define("FetchAlertIncidentAnomalyTimeseries", {
	args: { key: Schema.String, id: AnomalyIncidentId },
	messages: [Message.CompletedFetchAnomalyTimeseries],
	execute: ({ key, id }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const result = yield* client.anomalies
				.getIncidentTimeseries({ params: { id }, query: {} })
				.pipe(Effect.mapError(toLoadFailure), Effect.result)
			return Message.CompletedFetchAnomalyTimeseries({ key, result })
		}),
})

export const FetchIncidentSilences = Command.define("FetchAlertIncidentSilences", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchSilences],
	execute: ({ key }) =>
		listActiveSilences.pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSilences({ key, result })),
		),
})

export const FetchIncidentSession = Command.define("FetchAlertIncidentSession", {
	messages: [Message.CompletedFetchSession],
	execute: Effect.map(readGrants, (grants) => Message.CompletedFetchSession({ grants })),
})
