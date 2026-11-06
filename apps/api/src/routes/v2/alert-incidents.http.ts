import { HttpApiBuilder } from "effect/http-api"
import type {
	AlertIncidentDocument,
	AlertIncidentEscalationDocument,
	AlertIncidentEventDocument,
	AlertIncidentId,
	OrgId,
} from "@maple/domain/http"
import { CurrentTenant, isAlertNotificationEventType } from "@maple/domain/http"
import type { V2AlertIncident, V2AlertIncidentEscalation, V2AlertIncidentEvent } from "@maple/domain/http/v2"
import { MapleApiV2, paginateOffsetQuery } from "@maple/domain/http/v2"
import { Duration, Effect, Option, Array as Arr } from "effect"
import { AlertReadModelsService } from "@maple/backend/services/alerts/AlertReadModelsService"
import {
	AlertIncidentAckService,
	type AlertIncidentActor,
} from "@maple/backend/services/alerts/AlertIncidentAckService"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
import { CurrentAuditActor } from "@maple/backend/services/auth/audit-actor"

const toV2Escalation = (doc: AlertIncidentEscalationDocument): V2AlertIncidentEscalation => ({
	chain_id: doc.chainId,
	chain_name: doc.chainName,
	status: doc.status,
	// The scheduler leaves an exhausted run past its last step; the wire never reads past the end.
	step: Math.min(doc.stepIndex + 1, doc.stepCount),
	step_count: doc.stepCount,
	pass: Math.min(doc.passIndex + 1, doc.repeatCount + 1),
	pass_count: doc.repeatCount + 1,
	steps_sent: doc.stepsSent,
	next_step_at: doc.nextStepAt,
})

const toV2Incident = (
	doc: AlertIncidentDocument,
	escalation: AlertIncidentEscalationDocument | undefined,
): V2AlertIncident => ({
	id: doc.id,
	object: "alert_incident",
	rule_id: doc.ruleId,
	rule_name: doc.ruleName,
	group_key: doc.groupKey,
	signal_type: doc.signalType,
	severity: doc.severity,
	peak_severity: doc.peakSeverity,
	status: doc.status,
	comparator: doc.comparator,
	threshold: doc.threshold,
	threshold_upper: doc.thresholdUpper,
	first_triggered_at: doc.firstTriggeredAt,
	last_triggered_at: doc.lastTriggeredAt,
	resolved_at: doc.resolvedAt,
	last_observed_value: doc.lastObservedValue,
	last_sample_count: doc.lastSampleCount,
	dedupe_key: doc.dedupeKey,
	// An acknowledgement never becomes the last delivered event; narrow it for the public enum.
	last_delivered_event_type:
		doc.lastDeliveredEventType !== null && isAlertNotificationEventType(doc.lastDeliveredEventType)
			? doc.lastDeliveredEventType
			: null,
	last_notified_at: doc.lastNotifiedAt,
	hold_reason: doc.holdReason,
	held_since: doc.heldSince,
	acknowledged_at: doc.acknowledgedAt,
	acknowledged_by:
		doc.acknowledgedAt === null
			? null
			: { user_id: doc.acknowledgedByUserId, name: doc.acknowledgedByName },
	acknowledged_via: doc.acknowledgedVia,
	error_issue_id: doc.errorIssueId,
	escalation: escalation === undefined ? null : toV2Escalation(escalation),
})

const toV2Event = (doc: AlertIncidentEventDocument): V2AlertIncidentEvent => ({
	id: doc.id,
	object: "alert_incident_event",
	incident_id: doc.incidentId,
	type: doc.type,
	actor:
		doc.actorUserId === null && doc.actorName === null
			? null
			: { user_id: doc.actorUserId, name: doc.actorName },
	source: doc.source,
	...(doc.page === undefined
		? undefined
		: {
				page: {
					user_id: doc.page.userId,
					name: doc.page.name,
					channel: doc.page.channel,
					status: doc.page.status,
					error_message: doc.page.errorMessage,
				},
			}),
	created_at: doc.createdAt,
})

export const HttpV2AlertIncidentsLive = HttpApiBuilder.group(MapleApiV2, "alertIncidents", (handlers) =>
	Effect.gen(function* () {
		const readModels = yield* AlertReadModelsService
		const acks = yield* AlertIncidentAckService
		const members = yield* OrgMembersService

		// One escalation read for a whole page of incidents, never one per incident.
		const withEscalations = (orgId: OrgId, docs: ReadonlyArray<AlertIncidentDocument>) =>
			readModels
				.listIncidentEscalations(
					orgId,
					Arr.map(docs, (doc): AlertIncidentId => doc.id),
				)
				.pipe(
					Effect.map((escalations) => {
						const byIncident = new Map(Arr.map(escalations, (row) => [row.incidentId, row]))
						return Arr.map(docs, (doc) => toV2Incident(doc, byIncident.get(doc.id)))
					}),
				)
		const withEscalation = (orgId: OrgId, doc: AlertIncidentDocument) =>
			Effect.map(readModels.listIncidentEscalations(orgId, [doc.id]), (rows) =>
				toV2Incident(doc, rows[0]),
			)

		// Who is acknowledging, with a name recorded alongside so every surface can show it without a
		// directory lookup. An API key is not a person: it is named by its label and has no user. A
		// session is named by the member directory, best effort: a slow one records no name.
		const callerActor = Effect.gen(function* () {
			const tenant = yield* CurrentTenant.Context
			const credential = yield* CurrentAuditActor
			const name =
				credential?.type === "api_key"
					? (credential.label ?? null)
					: Option.getOrNull(
							(yield* members
								.resolveMembers(tenant.orgId, [tenant.userId])
								.pipe(Effect.timeout(Duration.seconds(3)), Effect.option)).pipe(
								Option.flatMap(Arr.head),
								Option.map((member) => member.name ?? member.email),
							),
						)
			const actor: AlertIncidentActor = {
				userId: credential?.type === "api_key" ? null : tenant.userId,
				name,
				source: credential?.source === "dashboard" ? "web" : "api",
			}
			return { orgId: tenant.orgId, actor }
		})

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const page = yield* paginateOffsetQuery(query, ({ limit, offset }) =>
						readModels
							.listIncidents(tenant.orgId, {
								...(query.status !== undefined ? { status: query.status } : undefined),
								...(query.rule_id !== undefined ? { ruleId: query.rule_id } : undefined),
								...(query.acknowledged !== undefined
									? { acknowledged: query.acknowledged === "true" }
									: undefined),
								limit,
								offset,
							})
							.pipe(
								Effect.flatMap((response) =>
									withEscalations(tenant.orgId, response.incidents),
								),
							),
					)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const incident = yield* readModels.getIncident(tenant.orgId, params.id)
					return yield* withEscalation(tenant.orgId, incident)
				}),
			)
			.handle("acknowledge", ({ params }) =>
				Effect.gen(function* () {
					const { orgId, actor } = yield* callerActor
					const result = yield* acks.acknowledge(orgId, params.id, actor)
					return yield* withEscalation(orgId, result.incident)
				}).pipe(Effect.withSpan("HttpV2AlertIncidents.acknowledge")),
			)
			.handle("unacknowledge", ({ params }) =>
				Effect.gen(function* () {
					const { orgId, actor } = yield* callerActor
					const result = yield* acks.unacknowledge(orgId, params.id, actor)
					return yield* withEscalation(orgId, result.incident)
				}).pipe(Effect.withSpan("HttpV2AlertIncidents.unacknowledge")),
			)
			.handle("listEvents", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const events = yield* acks.listEvents(tenant.orgId, params.id)
					return { object: "list" as const, data: Arr.map(events, toV2Event) }
				}),
			)
	}),
)
