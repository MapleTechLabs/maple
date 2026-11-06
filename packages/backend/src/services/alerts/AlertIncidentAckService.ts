/**
 * Acknowledging an open alert incident ("someone is on it"). The incident row carries the
 * current acknowledgement, which the scheduler reads to hold reminders; `alert_incident_events`
 * carries the history, which the timeline shows and on-call escalation reads.
 */
import {
	AlertIncidentAckSource,
	AlertIncidentEventDocument,
	AlertIncidentEventId,
	AlertIncidentEventType,
	AlertIncidentNotFoundError,
	AlertIncidentResolvedError,
	type AlertIncidentDocument,
	type AlertIncidentPage,
	type AlertIncidentId,
	type AlertPersistenceError,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AlertIncidentEvents, AlertIncidents, AlertMemberNotifications } from "@maple/db/tables"
import { Context, Effect, Layer, Option, Order, Schema, Array as Arr } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
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

export interface AlertIncidentPageEntry {
	readonly id: string
	readonly incidentId: AlertIncidentId
	readonly page: AlertIncidentPage
	readonly createdAt: number
}

/** Pages per incident the timeline shows; a chain pages at most a few people a step. */
const MAX_PAGES_PER_READ = 500

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
	/** People escalation steps paged for these incidents, oldest first; one read for all of them. */
	readonly listPages: (
		orgId: OrgId,
		incidentIds: ReadonlyArray<AlertIncidentId>,
	) => Effect.Effect<ReadonlyArray<AlertIncidentPageEntry>, AlertPersistenceError>
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
const decodeEventType = Schema.decodeUnknownOption(AlertIncidentEventType)
const decodeSource = Schema.decodeUnknownOption(AlertIncidentAckSource)
const decodeIso = Schema.decodeUnknownSync(AlertIncidentEventDocument.fields.createdAt)

export class AlertIncidentAckService extends Context.Service<
	AlertIncidentAckService,
	AlertIncidentAckServiceApi
>()("@maple/backend/services/alerts/AlertIncidentAckService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const orgMembers = yield* OrgMembersService
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

		const listPages = Effect.fn("AlertIncidentAckService.listPages")(function* (
			orgId: OrgId,
			incidentIds: ReadonlyArray<AlertIncidentId>,
		) {
			if (incidentIds.length === 0) return []
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.from(AlertMemberNotifications)
						.select(
							"id",
							"incidentId",
							"userId",
							"channel",
							"status",
							"errorMessage",
							"createdAt",
						)
						.where(($) => [$.orgId.eq(orgId), $.incidentId.in_(...incidentIds)])
						.orderBy(["createdAt", "asc"], ["id", "asc"])
						.limit(MAX_PAGES_PER_READ),
				),
			)
			if (rows.length === 0) return []
			// Display names only, never the address; a directory that cannot be read leaves them null.
			const members = yield* orgMembers.listMembers(orgId).pipe(Effect.orElseSucceed(() => []))
			const names = new Map(Arr.map(members, (member) => [member.userId, member.name] as const))
			return Arr.map(rows, (row): AlertIncidentPageEntry => ({
				id: row.id,
				incidentId: row.incidentId,
				createdAt: row.createdAt,
				page: {
					userId: row.userId,
					name: names.get(row.userId) ?? null,
					channel: row.channel,
					status: row.status,
					errorMessage: row.errorMessage,
				},
			}))
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
			const pages = yield* listPages(orgId, [incidentId])
			// A type this build does not know (a newer writer) is skipped rather than failing the page.
			const acks = Arr.getSomes(
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
			const paged = Arr.map(
				pages,
				(entry) =>
					new AlertIncidentEventDocument({
						id: decodeEventId(entry.id),
						incidentId: entry.incidentId,
						type: "paged",
						actorUserId: null,
						actorName: null,
						source: null,
						page: entry.page,
						createdAt: decodeIso(new Date(entry.createdAt).toISOString()),
					}),
			)
			// Stable: an ack and a page in the same millisecond keep the ack first.
			return Arr.sort(
				[...acks, ...paged],
				Order.mapInput(Order.String, (event: AlertIncidentEventDocument) => event.createdAt),
			)
		})

		return {
			acknowledge: setAcknowledged(true),
			unacknowledge: setAcknowledged(false),
			listPages,
			listEvents,
		} satisfies AlertIncidentAckServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(OrgMembersService.layer))
}
