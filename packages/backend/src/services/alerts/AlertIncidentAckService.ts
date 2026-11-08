/**
 * Acknowledging an open alert incident ("someone is on it"). The incident row carries the
 * current acknowledgement, which the scheduler reads to hold reminders; `alert_incident_events`
 * carries the history, which the timeline shows and on-call escalation reads.
 */
import {
	AlertDeliveryEventId,
	AlertIncidentAckSource,
	AlertIncidentEventDocument,
	AlertIncidentEventId,
	AlertIncidentEventType,
	AlertIncidentNotFoundError,
	AlertIncidentResolvedError,
	type AlertIncidentDocument,
	type AlertIncidentId,
	type AlertPersistenceError,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	AlertDeliveryEvents,
	AlertDestinations,
	AlertIncidentEvents,
	AlertIncidents,
	type AlertIncidentRow,
} from "@maple/db/tables"
import { makeAlertDeliveryKey } from "@maple/alerting-core"
import type { MapleDb } from "@maple/db/client"
import { Context, Effect, Layer, Option, Schema, Array as Arr } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { makePersistenceError } from "./alert-persistence"
import { AlertRuntime } from "./AlertRuntime"
import { rowToIncidentDocument } from "./AlertReadModelsService"

/** Who acknowledged, and from where. A click from an unlinked chat account has a name and no user. */
export interface AlertIncidentActor {
	readonly userId: UserId | null
	readonly name: string | null
	readonly source: AlertIncidentAckSource
}

export interface AlertIncidentAckResult {
	readonly incident: AlertIncidentDocument
	/** False when the incident was already in the requested state: nothing was written. */
	readonly changed: boolean
}

type AckError = AlertIncidentNotFoundError | AlertIncidentResolvedError | AlertPersistenceError

export interface AlertIncidentAckServiceApi {
	readonly acknowledge: (
		orgId: OrgId,
		incidentId: AlertIncidentId,
		actor: AlertIncidentActor,
	) => Effect.Effect<AlertIncidentAckResult, AckError>
	readonly unacknowledge: (
		orgId: OrgId,
		incidentId: AlertIncidentId,
		actor: AlertIncidentActor,
	) => Effect.Effect<AlertIncidentAckResult, AckError>
	/** The incident's activity, oldest first. */
	readonly listEvents: (
		orgId: OrgId,
		incidentId: AlertIncidentId,
	) => Effect.Effect<
		ReadonlyArray<AlertIncidentEventDocument>,
		AlertIncidentNotFoundError | AlertPersistenceError
	>
}

const decodeEventId = Schema.decodeUnknownSync(AlertIncidentEventId)
const decodeDeliveryId = Schema.decodeUnknownSync(AlertDeliveryEventId)
const decodeEventType = Schema.decodeUnknownOption(AlertIncidentEventType)
const decodeSource = Schema.decodeUnknownOption(AlertIncidentAckSource)
const decodeIso = Schema.decodeUnknownSync(AlertIncidentEventDocument.fields.createdAt)

export class AlertIncidentAckService extends Context.Service<
	AlertIncidentAckService,
	AlertIncidentAckServiceApi
>()("@maple/backend/services/alerts/AlertIncidentAckService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const dbExecute = makeDbExecute(database, "AlertIncidentAckService", makePersistenceError)

		const findIncident = (orgId: OrgId, incidentId: AlertIncidentId) =>
			dbExecute((db) =>
				db.run(
					PG.from(AlertIncidents)
						.select()
						.where(($) => [$.orgId.eq(orgId), $.id.eq(incidentId)])
						.limit(1),
				),
			).pipe(
				Effect.flatMap((rows) =>
					Effect.fromOption(Arr.head(rows)).pipe(
						Effect.mapError(
							() =>
								new AlertIncidentNotFoundError({
									message: `No such alert incident: '${incidentId}'`,
									incidentId,
								}),
						),
					),
				),
			)

		/**
		 * Queue a PagerDuty `acknowledge` for each enabled PagerDuty destination this incident already
		 * paged, so it never reaches a pager that was not notified or lands before the page itself.
		 * Written in the ack's transaction; the alerting dispatcher sends it.
		 */
		const queuePagerDutyAcknowledge = (
			db: MapleDb,
			incident: AlertIncidentRow,
			now: number,
			makeUuid: () => string,
		) =>
			Effect.gen(function* () {
				const paged = yield* db.run(
					PG.from(AlertDeliveryEvents)
						.select("destinationId")
						.where(($) => [
							$.orgId.eq(incident.orgId),
							$.incidentId.eq(incident.id),
							$.status.eq("success"),
							$.eventType.in_("trigger", "renotify"),
						]),
				)
				const candidateIds = Arr.dedupe(Arr.map(paged, (row) => row.destinationId))
				if (candidateIds.length === 0) return 0
				const destinations = yield* db.run(
					PG.from(AlertDestinations)
						.select("id")
						.where(($) => [
							$.orgId.eq(incident.orgId),
							$.id.in_(...candidateIds),
							$.type.eq("pagerduty"),
							$.enabled.eq(true),
						]),
				)
				yield* Effect.forEach(
					destinations,
					(destination) =>
						db.run(
							PG.insertInto(AlertDeliveryEvents)
								.values({
									id: decodeDeliveryId(makeUuid()),
									orgId: incident.orgId,
									incidentId: incident.id,
									ruleId: incident.ruleId,
									destinationId: destination.id,
									deliveryKey: makeAlertDeliveryKey(
										incident.id,
										destination.id,
										"acknowledge",
										now,
									),
									eventType: "acknowledge",
									attemptNumber: 1,
									status: "queued",
									scheduledAt: now,
									claimedAt: null,
									claimExpiresAt: null,
									claimedBy: null,
									attemptedAt: null,
									providerMessage: null,
									providerReference: null,
									responseCode: null,
									errorMessage: null,
									payloadJson: {
										eventType: "acknowledge",
										incidentId: incident.id,
										incidentStatus: incident.status,
										dedupeKey: incident.dedupeKey,
										peakSeverity: incident.peakSeverity,
										rule: {
											id: incident.ruleId,
											name: incident.ruleName,
											severity: incident.severity,
											groupKey: incident.groupKey,
											signalType: incident.signalType,
										},
									},
									createdAt: now,
									updatedAt: now,
								})
								.onConflictDoNothing(),
						),
					{ discard: true },
				)
				return destinations.length
			})

		/**
		 * One guarded UPDATE per change, so two people clicking at once write one event: the loser
		 * matches no row and reads back the state the winner left.
		 */
		const setAcknowledged = (acknowledged: boolean) =>
			Effect.fn(
				acknowledged
					? "AlertIncidentAckService.acknowledge"
					: "AlertIncidentAckService.unacknowledge",
			)(function* (orgId: OrgId, incidentId: AlertIncidentId, actor: AlertIncidentActor) {
				yield* Effect.annotateCurrentSpan({
					orgId,
					"maple.alert.incident_id": incidentId,
					"maple.alert.ack_source": actor.source,
				})
				const runtime = yield* AlertRuntime
				const now = yield* runtime.now
				const eventId = decodeEventId(runtime.makeUuid())
				const updated = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							const rows = yield* db.run(
								PG.update(AlertIncidents)
									.set(
										acknowledged
											? {
													acknowledgedAt: now,
													acknowledgedByUserId: actor.userId,
													acknowledgedByName: actor.name,
													acknowledgedVia: actor.source,
													updatedAt: now,
												}
											: {
													acknowledgedAt: null,
													acknowledgedByUserId: null,
													acknowledgedByName: null,
													acknowledgedVia: null,
													updatedAt: now,
												},
									)
									.where(($) => [
										$.orgId.eq(orgId),
										$.id.eq(incidentId),
										$.status.eq("open"),
										acknowledged
											? $.acknowledgedAt.isNull()
											: $.acknowledgedAt.isNotNull(),
									])
									.returning(),
							)
							const changedRow = Arr.head(rows)
							if (acknowledged && Option.isSome(changedRow)) {
								const queued = yield* queuePagerDutyAcknowledge(
									db,
									changedRow.value,
									now,
									() => runtime.makeUuid(),
								)
								yield* Effect.annotateCurrentSpan("maple.alert.pagerduty_acks_queued", queued)
							}
							if (rows.length > 0) {
								yield* db.run(
									PG.insertInto(AlertIncidentEvents).values({
										id: eventId,
										orgId,
										incidentId,
										type: acknowledged ? "acknowledged" : "unacknowledged",
										actorUserId: actor.userId,
										actorName: actor.name,
										source: actor.source,
										createdAt: now,
									}),
								)
							}
							return rows
						}),
					),
				)
				const row = Arr.head(updated)
				if (Option.isSome(row)) {
					yield* Effect.annotateCurrentSpan("maple.alert.ack_changed", true)
					return { incident: rowToIncidentDocument(row.value), changed: true }
				}
				const current = yield* findIncident(orgId, incidentId)
				if (current.status !== "open") {
					return yield* new AlertIncidentResolvedError({
						message: `This alert incident is resolved; only an open incident can be ${acknowledged ? "acknowledged" : "unacknowledged"}.`,
						incidentId,
					})
				}
				yield* Effect.annotateCurrentSpan("maple.alert.ack_changed", false)
				return { incident: rowToIncidentDocument(current), changed: false }
			})

		const listEvents = Effect.fn("AlertIncidentAckService.listEvents")(function* (
			orgId: OrgId,
			incidentId: AlertIncidentId,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.alert.incident_id": incidentId })
			yield* findIncident(orgId, incidentId)
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.from(AlertIncidentEvents)
						.select()
						.where(($) => [$.orgId.eq(orgId), $.incidentId.eq(incidentId)])
						// The newest 500, put back in order below.
						.orderBy(["createdAt", "desc"], ["id", "desc"])
						.limit(500),
				),
			)
			// A type this build does not know (a newer writer) is skipped rather than failing the page.
			return Arr.getSomes(
				Arr.map(Arr.reverse(rows), (row) =>
					Option.map(
						decodeEventType(row.type),
						(type) =>
							new AlertIncidentEventDocument({
								id: row.id,
								incidentId: row.incidentId,
								type,
								actorUserId: row.actorUserId,
								actorName: row.actorName,
								source:
									row.source === null ? null : Option.getOrNull(decodeSource(row.source)),
								createdAt: decodeIso(new Date(row.createdAt).toISOString()),
							}),
					),
				),
			)
		})

		return {
			acknowledge: setAcknowledged(true),
			unacknowledge: setAcknowledged(false),
			listEvents,
		} satisfies AlertIncidentAckServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
