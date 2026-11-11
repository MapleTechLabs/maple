import { randomUUID } from "node:crypto"
import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb } from "@maple/db/client"
import { StatusPageIncidents, StatusPageIncidentUpdates } from "@maple/db/tables"
import {
	type OrgId,
	type StatusPageId,
	type StatusPageIncidentId,
	StatusPageIncidentUpdateId,
} from "@maple/primitives"
import { Effect, Array as Arr } from "effect"
import { bumpPage } from "./outbox"

// Scheduled maintenance follows its window on its own: at the start it moves to in progress, at
// the end to completed, each with an automatic update visitors and feed readers see.

/** Maintenance one sweep advances at most; the rest wait for the next minute. */
export const MAINTENANCE_SWEEP_BATCH = 100

export const MAINTENANCE_STARTED_BODY = "The scheduled maintenance has started."
export const MAINTENANCE_COMPLETED_BODY = "The scheduled maintenance is complete."

const announce = (
	db: MapleDb,
	orgId: OrgId,
	incident: { readonly id: StatusPageIncidentId; readonly pageId: StatusPageId },
	status: "in_progress" | "completed",
	at: number,
) =>
	db
		.run(
			PG.insertInto(StatusPageIncidentUpdates).values({
				id: StatusPageIncidentUpdateId.make(randomUUID()),
				orgId,
				incidentId: incident.id,
				status,
				body: status === "in_progress" ? MAINTENANCE_STARTED_BODY : MAINTENANCE_COMPLETED_BODY,
				source: "auto",
				createdBy: null,
				overlayEntryId: null,
				createdAt: at,
			}),
		)
		.pipe(Effect.andThen(bumpPage(db, orgId, incident.pageId)))

/**
 * Starts scheduled maintenance whose window began and completes open maintenance whose window
 * ended; one that missed its whole window gets both updates. Each in its own transaction, the
 * writes guarded on status so a concurrent sweep or a manual post wins. Returns how many moved.
 */
export const advanceMaintenance = Effect.fnUntraced(function* (db: MapleDb, at: number) {
	const due = yield* db.run(
		PG.from(StatusPageIncidents)
			.select(($) => ({ id: $.id, orgId: $.orgId, scheduledStart: $.scheduledStart }))
			.where(($) => [
				$.kind.eq("maintenance"),
				$.resolvedAt.isNull(),
				PG.or(
					PG.and($.status.eq("scheduled"), $.scheduledStart.lte(at)),
					PG.and($.status.eq("in_progress"), $.scheduledEnd.lte(at)),
				),
			])
			.orderBy(["scheduledStart", "asc"], ["id", "asc"])
			.limit(MAINTENANCE_SWEEP_BATCH),
	)
	const counts = yield* Effect.forEach(due, (row) =>
		db.transaction(
			Effect.gen(function* () {
				const started = yield* db.run(
					PG.update(StatusPageIncidents)
						.set({ status: "in_progress", updatedAt: at })
						.where(($) => [
							$.orgId.eq(row.orgId),
							$.id.eq(row.id),
							$.status.eq("scheduled"),
							$.scheduledStart.lte(at),
						])
						.returning(($) => ({ id: $.id, pageId: $.pageId })),
				)
				// A millisecond early, so a window missed whole lists its start before its completion.
				yield* Effect.forEach(started, (incident) =>
					announce(db, row.orgId, incident, "in_progress", at - 1),
				)
				const completed = yield* db.run(
					PG.update(StatusPageIncidents)
						.set({ status: "completed", resolvedAt: at, updatedAt: at })
						.where(($) => [
							$.orgId.eq(row.orgId),
							$.id.eq(row.id),
							$.status.eq("in_progress"),
							$.scheduledEnd.lte(at),
						])
						.returning(($) => ({ id: $.id, pageId: $.pageId })),
				)
				yield* Effect.forEach(completed, (incident) =>
					announce(db, row.orgId, incident, "completed", at),
				)
				return started.length + completed.length > 0 ? 1 : 0
			}),
		),
	)
	return Arr.reduce(counts, 0, (sum, n) => sum + n)
})
