/**
 * Who escalation paged for an alert incident. Kept apart from acknowledging so that writing an
 * ack never needs the member directory, which is what puts display names on these entries.
 */
import {
	AlertIncidentEventDocument,
	AlertIncidentEventId,
	type AlertIncidentId,
	type AlertIncidentPage,
	type AlertPersistenceError,
	type OrgId,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import type { UserId } from "@maple/primitives"
import { AlertEscalationRuns, AlertMemberNotifications } from "@maple/db/tables"
import { Clock, Context, Duration, Effect, Layer, Order, Schema, Array as Arr } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
import { makePersistenceError } from "./alert-persistence"
import { loadStepPeople } from "./alert-escalation-runs"

export interface AlertIncidentPageEntry {
	readonly id: string
	readonly incidentId: AlertIncidentId
	readonly page: AlertIncidentPage
	readonly createdAt: number
}

/** Who an incident's next escalation step would page. */
export interface AlertIncidentNextStepPeople {
	readonly incidentId: AlertIncidentId
	readonly people: ReadonlyArray<{ readonly userId: UserId; readonly name: string | null }>
}

/** Pages per incident the timeline shows; a chain pages at most a few people a step. */
const MAX_PAGES_PER_READ = 500
/** A read waits this long on the member directory for names, then answers without them. */
const DIRECTORY_TIMEOUT = Duration.seconds(3)
/** Steps resolved at once: a page of incidents rarely has more than a few runs waiting. */
const NEXT_STEP_CONCURRENCY = 4

export interface AlertIncidentPagesServiceApi {
	/** People escalation steps paged for these incidents, oldest first; one read for all of them. */
	readonly listPages: (
		orgId: OrgId,
		incidentIds: ReadonlyArray<AlertIncidentId>,
	) => Effect.Effect<ReadonlyArray<AlertIncidentPageEntry>, AlertPersistenceError>
	/**
	 * Who each incident's next escalation step would page if it ran now. Only incidents whose latest
	 * run is waiting on a step are returned; an acknowledged, ended or chainless one is absent.
	 */
	readonly listNextStepPeople: (
		orgId: OrgId,
		incidentIds: ReadonlyArray<AlertIncidentId>,
	) => Effect.Effect<ReadonlyArray<AlertIncidentNextStepPeople>, AlertPersistenceError>
}

const decodeEventId = Schema.decodeUnknownSync(AlertIncidentEventId)
const decodeIso = Schema.decodeUnknownSync(AlertIncidentEventDocument.fields.createdAt)

/** Page entries as `paged` timeline events, merged with ack activity in time order. */
export const mergePagesIntoEvents = (
	acks: ReadonlyArray<AlertIncidentEventDocument>,
	pages: ReadonlyArray<AlertIncidentPageEntry>,
): ReadonlyArray<AlertIncidentEventDocument> => {
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
}

export class AlertIncidentPagesService extends Context.Service<
	AlertIncidentPagesService,
	AlertIncidentPagesServiceApi
>()("@maple/backend/services/alerts/AlertIncidentPagesService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const orgMembers = yield* OrgMembersService
		const dbExecute = makeDbExecute(database, "AlertIncidentPagesService", makePersistenceError)

		const listPages = Effect.fn("AlertIncidentPagesService.listPages")(function* (
			orgId: OrgId,
			incidentIds: ReadonlyArray<AlertIncidentId>,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.alert.incident_count": incidentIds.length })
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
						// Newest first, so the cap only ever drops the oldest pages; put back in order below.
						.orderBy(["createdAt", "desc"], ["id", "desc"])
						.limit(MAX_PAGES_PER_READ),
				),
			)
			if (rows.length === 0) return []
			// Display names only, never the address; a directory that cannot be read leaves them null.
			const members = yield* orgMembers.listMembers(orgId).pipe(Effect.orElseSucceed(() => []))
			const names = new Map(Arr.map(members, (member) => [member.userId, member.name] as const))
			return Arr.map(Arr.reverse(rows), (row): AlertIncidentPageEntry => ({
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

		const listNextStepPeople = Effect.fn("AlertIncidentPagesService.listNextStepPeople")(function* (
			orgId: OrgId,
			incidentIds: ReadonlyArray<AlertIncidentId>,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.alert.incident_count": incidentIds.length })
			if (incidentIds.length === 0) return []
			const runs = yield* dbExecute((db) =>
				db.run(
					PG.from(AlertEscalationRuns)
						.select(($) => ({
							incidentId: $.incidentId,
							status: $.status,
							stepIndex: $.stepIndex,
							stepsJson: $.stepsJson,
							nextStepAt: $.nextStepAt,
						}))
						// The latest run per incident, as the escalation read picks it.
						.distinctOn("incidentId")
						.where(($) => [$.orgId.eq(orgId), $.incidentId.in_(...incidentIds)])
						.orderBy(($) => [
							[$.incidentId, "asc"],
							[$.createdAt, "desc"],
							[$.id, "desc"],
						]),
				),
			)
			const waiting = Arr.flatMap(runs, (run) => {
				const step = run.stepsJson[run.stepIndex]
				return run.status === "active" && run.nextStepAt !== null && step !== undefined
					? [{ incidentId: run.incidentId, step }]
					: []
			})
			yield* Effect.annotateCurrentSpan("maple.alert.waiting_runs", waiting.length)
			if (waiting.length === 0) return []
			// Names and who has left, best effort: a slow or absent directory names nobody and keeps everyone.
			const members = yield* orgMembers.listMembers(orgId).pipe(
				Effect.timeout(DIRECTORY_TIMEOUT),
				Effect.orElseSucceed(() => []),
			)
			const names = new Map(Arr.map(members, (member) => [member.userId, member.name] as const))
			const present = members.length === 0 ? null : new Set(names.keys())
			const nowMs = yield* Clock.currentTimeMillis
			return yield* dbExecute((db) =>
				Effect.forEach(
					waiting,
					({ incidentId, step }) =>
						Effect.map(
							loadStepPeople(db, orgId, step, nowMs, present),
							({ directUserIds, shifts }): AlertIncidentNextStepPeople => ({
								incidentId,
								people: Arr.map(
									Arr.dedupe([
										...Arr.filter(
											directUserIds,
											(userId) => present?.has(userId) ?? true,
										),
										...Arr.flatMap(shifts, (shift) =>
											shift.userId === null ? [] : [shift.userId],
										),
									]),
									(userId) => ({ userId, name: names.get(userId) ?? null }),
								),
							}),
						),
					{ concurrency: NEXT_STEP_CONCURRENCY },
				),
			)
		})

		return { listPages, listNextStepPeople } satisfies AlertIncidentPagesServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(OrgMembersService.layer))
}
