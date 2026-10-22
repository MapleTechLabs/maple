import { AnomalyIncidentId, ErrorIssueId } from "@maple/domain/http"
import { V2InvestigationCreateParams } from "@maple/domain/http/v2"
import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { Message } from "./message"

const v2 = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.mapError(toLoadFailure), Effect.result)

export const ReadAnomalyClock = Command.define("ReadAnomalyClock", {
	messages: [Message.ReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadClock({ nowMs })),
})

export const FetchIncident = Command.define("FetchAnomalyIncident", {
	args: { key: Schema.String, id: AnomalyIncidentId },
	messages: [Message.CompletedFetchIncident],
	execute: ({ key, id }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const result = yield* v2(client.anomalies.getIncident({ params: { id } }))
			return Message.CompletedFetchIncident({ key, result })
		}),
})

export const FetchTimeseries = Command.define("FetchAnomalyTimeseries", {
	args: { key: Schema.String, id: AnomalyIncidentId },
	messages: [Message.CompletedFetchTimeseries],
	execute: ({ key, id }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const result = yield* v2(client.anomalies.getIncidentTimeseries({ params: { id }, query: {} }))
			return Message.CompletedFetchTimeseries({ key, result })
		}),
})

export const FetchLinkedIssue = Command.define("FetchAnomalyLinkedIssue", {
	args: { key: Schema.String, id: ErrorIssueId },
	messages: [Message.CompletedFetchLinkedIssue],
	execute: ({ key, id }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const result = yield* v2(client.errorIssues.retrieve({ params: { id }, query: {} }))
			return Message.CompletedFetchLinkedIssue({ key, result })
		}),
})

export const FetchLinkIssues = Command.define("FetchAnomalyLinkIssues", {
	args: { key: Schema.String, serviceName: Schema.NullOr(Schema.String) },
	messages: [Message.CompletedFetchLinkIssues],
	execute: ({ key, serviceName }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const query = serviceName === null ? { limit: 100 } : { service_name: serviceName, limit: 100 }
			const result = yield* v2(Effect.map(client.errorIssues.list({ query }), (page) => page.data))
			return Message.CompletedFetchLinkIssues({ key, result })
		}),
})

export const CreateInvestigation = Command.define("CreateAnomalyInvestigation", {
	args: { payload: V2InvestigationCreateParams },
	messages: [Message.CompletedInvestigate],
	execute: ({ payload }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const result = yield* v2(
				Effect.map(client.investigations.create({ payload }), (investigation) =>
					String(investigation.id),
				),
			)
			return Message.CompletedInvestigate({ result })
		}),
})

export const ResolveIncident = Command.define("ResolveAnomalyIncident", {
	args: { id: AnomalyIncidentId },
	messages: [Message.CompletedResolve],
	execute: ({ id }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const result = yield* v2(client.anomalies.resolveIncident({ params: { id } }))
			return Message.CompletedResolve({ result })
		}),
})

export const SetIncidentIssue = Command.define("SetAnomalyIncidentIssue", {
	args: { id: AnomalyIncidentId, issueId: Schema.NullOr(ErrorIssueId) },
	messages: [Message.CompletedSetIssue],
	execute: ({ id, issueId }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const result = yield* v2(
				client.anomalies.setIncidentIssue({ params: { id }, payload: { issue_id: issueId } }),
			)
			return Message.CompletedSetIssue({ issueId, result })
		}),
})
