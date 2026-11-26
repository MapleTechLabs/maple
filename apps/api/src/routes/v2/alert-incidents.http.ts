import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import type {
	AlertIncidentAckSource,
	AlertIncidentDocument,
	AlertIncidentEscalationDocument,
	AlertIncidentEventDocument,
	AlertIncidentId,
	OrgId,
} from "@maple/domain/http"
import { CurrentTenant, isAlertNotificationEventType } from "@maple/domain/http"
import type { V2AlertIncident, V2AlertIncidentEscalation, V2AlertIncidentEvent } from "@maple/domain/http/v2"
import { MapleApiV2, paginateOffsetQuery, timestampOrNull } from "@maple/domain/http/v2"
import { Duration, Effect, Option, Array as Arr } from "effect"
import { AlertReadModelsService } from "@maple/backend/services/alerts/AlertReadModelsService"
import { AlertIncidentResolver } from "@maple/backend/services/alerts/AlertIncidentResolver"
import {
	AlertIncidentAckService,
	type AlertIncidentActor,
} from "@maple/backend/services/alerts/AlertIncidentAckService"
import {
	AlertIncidentPagesService,
	mergePagesIntoEvents,
	type AlertIncidentNextStepPeople,
} from "@maple/backend/services/alerts/AlertIncidentPagesService"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
import { CurrentAuditActor, MOBILE_CLIENT_HEADER } from "@maple/backend/services/auth/audit-actor"

/**
 * An ack pauses the run on the scheduler's next tick; until then the wire already reads it paused,
 * so a caller never sees a page coming that will not.
 */
const toV2Escalation = (
	doc: AlertIncidentEscalationDocument,
	isAcknowledged: boolean,
	nextStepPeople: AlertIncidentNextStepPeople["people"],
): V2AlertIncidentEscalation => {
	const isPausing = isAcknowledged && doc.status === "active"
	return {
		chain_id: doc.chainId,
		chain_name: doc.chainName,
		status: isPausing ? "acknowledged" : doc.status,
		// The scheduler leaves an exhausted run past its last step; the wire never reads past the end.
		step: Math.min(doc.stepIndex + 1, doc.stepCount),
		step_count: doc.stepCount,
		pass: Math.min(doc.passIndex + 1, doc.repeatCount + 1),
		pass_count: doc.repeatCount + 1,
		steps_sent: doc.stepsSent,
		next_step_at: isPausing ? null : doc.nextStepAt,
		next_step_people:
			isPausing || doc.nextStepAt === null
				? []
				: Arr.map(nextStepPeople, (person) => ({ user_id: person.userId, name: person.name })),
	}
}

/**
 * iOS builds from before the app could acknowledge decode the acknowledgement source as a closed
 * enum, and one value they do not know fails their whole incident list. They are the callers on
 * Apple's networking stack that do not name themselves, and they read `mobile` as `api`.
 */
type AckSourceOnWire = (source: AlertIncidentAckSource | null) => AlertIncidentAckSource | null

const ackSourceOnWire = Effect.map(HttpServerRequest.HttpServerRequest, (request): AckSourceOnWire => {
	const isOlderIosBuild =
		request.headers[MOBILE_CLIENT_HEADER] === undefined &&
		/CFNetwork\//u.test(request.headers["user-agent"] ?? "")
	return (source) => (isOlderIosBuild && source === "mobile" ? "api" : source)
})

const toV2Incident = (
	doc: AlertIncidentDocument,
	escalation: AlertIncidentEscalationDocument | undefined,
	nextStepPeople: AlertIncidentNextStepPeople["people"],
	onWire: AckSourceOnWire,
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
	first_acknowledged_at: doc.firstAcknowledgedAt,
	acknowledged_by:
		doc.acknowledgedAt === null
			? null
			: { user_id: doc.acknowledgedByUserId, name: doc.acknowledgedByName },
	acknowledged_via: onWire(doc.acknowledgedVia),
	error_issue_id: doc.errorIssueId,
	escalation:
		escalation === undefined
			? null
			: toV2Escalation(escalation, doc.acknowledgedAt !== null, nextStepPeople),
	...(doc.anomalyIncidentId === undefined ? undefined : { anomaly_incident_id: doc.anomalyIncidentId }),
	...(doc.groupLabel === undefined ? undefined : { group_label: doc.groupLabel }),
	...(doc.labels === undefined ? undefined : { labels: doc.labels }),
	silence_id: doc.silenceId,
	silenced_at: timestampOrNull(doc.silencedAt),
})

const toV2Event = (doc: AlertIncidentEventDocument, onWire: AckSourceOnWire): V2AlertIncidentEvent => ({
	id: doc.id,
	object: "alert_incident_event",
	incident_id: doc.incidentId,
	type: doc.type,
	actor:
		doc.actorUserId === null && doc.actorName === null
			? null
			: { user_id: doc.actorUserId, name: doc.actorName },
	source: onWire(doc.source),
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
	...(doc.detail === undefined ? undefined : { detail: doc.detail }),
	created_at: doc.createdAt,
})

export const HttpV2AlertIncidentsLive = HttpApiBuilder.group(MapleApiV2, "alertIncidents", (handlers) =>
	Effect.gen(function* () {
		const readModels = yield* AlertReadModelsService
		const acks = yield* AlertIncidentAckService
		const resolver = yield* AlertIncidentResolver
		const pagesService = yield* AlertIncidentPagesService
		const members = yield* OrgMembersService

		// One escalation read for a whole page of incidents, never one per incident. Who is paged next
		// is read only for the runs still waiting on a step: unacknowledged open incidents with a chain.
		const incidentsOnWire = (orgId: OrgId, docs: ReadonlyArray<AlertIncidentDocument>) =>
			Effect.gen(function* () {
				const onWire = yield* ackSourceOnWire
				const escalations = yield* readModels.listIncidentEscalations(
					orgId,
					Arr.map(docs, (doc): AlertIncidentId => doc.id),
				)
				const byIncident = new Map(Arr.map(escalations, (row) => [row.incidentId, row]))
				const waiting = Arr.flatMap(docs, (doc): ReadonlyArray<AlertIncidentId> =>
					doc.status === "open" &&
					doc.acknowledgedAt === null &&
					byIncident.get(doc.id)?.nextStepAt != null
						? [doc.id]
						: [],
				)
				const people = yield* pagesService.listNextStepPeople(orgId, waiting)
				const peopleByIncident = new Map(Arr.map(people, (row) => [row.incidentId, row.people]))
				return (doc: AlertIncidentDocument) =>
					toV2Incident(doc, byIncident.get(doc.id), peopleByIncident.get(doc.id) ?? [], onWire)
			})
		const withEscalations = (orgId: OrgId, docs: ReadonlyArray<AlertIncidentDocument>) =>
			Effect.map(incidentsOnWire(orgId, docs), (toWire) => Arr.map(docs, toWire))
		const withEscalation = (orgId: OrgId, doc: AlertIncidentDocument) =>
			Effect.map(incidentsOnWire(orgId, [doc]), (toWire) => toWire(doc))

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
				source:
					credential?.client === "mobile"
						? "mobile"
						: credential?.source === "dashboard"
							? "web"
							: "api",
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
								...(query.paged === "me" ? { pagedUserId: tenant.userId } : undefined),
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
			.handle("resolve", ({ params }) =>
				Effect.gen(function* () {
					const { orgId, actor } = yield* callerActor
					const incident = yield* resolver.resolve(orgId, params.id, actor)
					return yield* withEscalation(orgId, incident)
				}).pipe(Effect.withSpan("HttpV2AlertIncidents.resolve")),
			)
			.handle("listEvents", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const ackEvents = yield* acks.listEvents(tenant.orgId, params.id)
					const pages = yield* pagesService.listPages(tenant.orgId, [params.id])
					const events = mergePagesIntoEvents(ackEvents, pages)
					const onWire = yield* ackSourceOnWire
					return {
						object: "list" as const,
						data: Arr.map(events, (event) => toV2Event(event, onWire)),
					}
				}),
			)
	}),
)
