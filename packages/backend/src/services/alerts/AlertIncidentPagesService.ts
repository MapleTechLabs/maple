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
import { AlertMemberNotifications } from "@maple/db/tables"
import { Context, Effect, Layer, Order, Schema, Array as Arr } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
import { makePersistenceError } from "./alert-persistence"

export interface AlertIncidentPageEntry {
	readonly id: string
	readonly incidentId: AlertIncidentId
	readonly page: AlertIncidentPage
	readonly createdAt: number
}

/** Pages per incident the timeline shows; a chain pages at most a few people a step. */
const MAX_PAGES_PER_READ = 500

export interface AlertIncidentPagesServiceApi {
	/** People escalation steps paged for these incidents, oldest first; one read for all of them. */
	readonly listPages: (
		orgId: OrgId,
		incidentIds: ReadonlyArray<AlertIncidentId>,
	) => Effect.Effect<ReadonlyArray<AlertIncidentPageEntry>, AlertPersistenceError>
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

		return { listPages } satisfies AlertIncidentPagesServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(OrgMembersService.layer))
}
