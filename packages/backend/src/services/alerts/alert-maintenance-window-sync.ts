import {
	AlertSilenceId as AlertSilenceIdSchema,
	MAINTENANCE_MATERIALIZE_HORIZON_MS,
	maintenanceOccurrences,
	maintenanceSilenceReason,
	type AlertMaintenanceWindowId,
	type AlertSilenceId,
	type MaintenanceOccurrence,
	type OrgId,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AlertMaintenanceWindows, AlertSilences } from "@maple/db/tables"
import type { MapleDb, MapleDbError } from "@maple/db/client"
import { Array as Arr, Effect, Schema } from "effect"
import type { DecodedMaintenanceWindow } from "./alert-maintenance-window-store"

const decodeSilenceIdSync = Schema.decodeUnknownSync(AlertSilenceIdSchema)

export const silenceFields = (window: DecodedMaintenanceWindow, nowMs: number) => ({
	reason: maintenanceSilenceReason(window.row.name, window.row.reason),
	matchersJson: window.matchers,
	excludeFromBaselines: window.row.excludeFromBaselines,
	updatedAt: nowMs,
	updatedBy: window.row.updatedBy,
})

/** Ends a running occurrence now (its owed page then goes out) and drops the ones ahead. */
export const retireSilences = (
	db: MapleDb,
	orgId: OrgId,
	windowId: AlertMaintenanceWindowId,
	nowMs: number,
	updatedBy: string,
) =>
	Effect.gen(function* () {
		yield* db.run(
			PG.deleteFrom(AlertSilences).where(($) => [
				$.orgId.eq(orgId),
				$.maintenanceWindowId.eq(windowId),
				$.startsAt.gt(nowMs),
			]),
		)
		yield* db.run(
			PG.update(AlertSilences)
				.set({ endsAt: nowMs, updatedAt: nowMs, updatedBy })
				.where(($) => [
					$.orgId.eq(orgId),
					$.maintenanceWindowId.eq(windowId),
					$.startsAt.lte(nowMs),
					$.endsAt.gt(nowMs),
				]),
		)
	})

const insertOccurrence = (
	db: MapleDb,
	makeUuid: () => string,
	window: DecodedMaintenanceWindow,
	occurrence: MaintenanceOccurrence,
	nowMs: number,
) => {
	const fields = silenceFields(window, nowMs)
	const insert = PG.insertInto(AlertSilences).values({
		id: decodeSilenceIdSync(makeUuid()),
		orgId: window.row.orgId,
		maintenanceWindowId: window.row.id,
		startsAt: occurrence.startsAtMs,
		endsAt: occurrence.endsAtMs,
		createdAt: nowMs,
		createdBy: window.row.updatedBy,
		...fields,
	})
	// One ahead takes the window's current shape; a started one is only written when missing.
	return db.run(
		occurrence.startsAtMs <= nowMs
			? insert.onConflictDoNothing({
					target: ["maintenanceWindowId", "startsAt"],
					targetWhere: ($) => $.maintenanceWindowId.isNotNull(),
				})
			: insert.onConflictDoUpdate({
					target: ["maintenanceWindowId", "startsAt"],
					targetWhere: ($) => $.maintenanceWindowId.isNotNull(),
					set: { endsAt: occurrence.endsAtMs, ...fields },
					where: ($) => $.startsAt.gt(nowMs),
				}),
	)
}

/**
 * Brings the window's silences in line with its occurrences in [now, now + 48h), inside
 * the caller's transaction. Writes only while the window row is still enabled at the
 * revision read, so a pass holding a stale read cannot undo an edit. Each occurrence pairs
 * with the row of its own start. `refresh` (after an edit) gives running rows the new
 * shape and reopens an occurrence whose row ended early (a disable, then re-enable).
 */
export const syncWindow = (
	db: MapleDb,
	makeUuid: () => string,
	window: DecodedMaintenanceWindow,
	nowMs: number,
	refresh: boolean,
): Effect.Effect<number, MapleDbError> =>
	Effect.gen(function* () {
		const { orgId, id } = window.row
		const current = yield* db.run(
			PG.from(AlertMaintenanceWindows)
				.select("id")
				.where(($) => [
					$.orgId.eq(orgId),
					$.id.eq(id),
					$.enabled.eq(true),
					$.revision.eq(window.row.revision),
				])
				.limit(1)
				.forUpdate(),
		)
		if (current.length === 0) return 0

		const occurrences = maintenanceOccurrences(
			window.schedule,
			nowMs,
			nowMs + MAINTENANCE_MATERIALIZE_HORIZON_MS,
		)
		const startedStarts = Arr.map(
			Arr.filter(occurrences, (occurrence) => occurrence.startsAtMs <= nowMs),
			(occurrence) => occurrence.startsAtMs,
		)
		const rows = yield* db.run(
			PG.from(AlertSilences)
				.select("id", "startsAt", "endsAt")
				.where(($) => [
					$.orgId.eq(orgId),
					$.maintenanceWindowId.eq(id),
					startedStarts.length === 0
						? $.endsAt.gt(nowMs)
						: PG.or($.endsAt.gt(nowMs), $.startsAt.in_(...startedStarts)),
				]),
		)
		const byStart = new Map(Arr.map(rows, (row) => [row.startsAt, row] as const))
		const starts = new Set(Arr.map(occurrences, (occurrence) => occurrence.startsAtMs))
		const fields = silenceFields(window, nowMs)
		const setRow = (
			rowId: AlertSilenceId,
			set: Partial<ReturnType<typeof silenceFields>> & { readonly endsAt: number },
		) =>
			db
				.run(
					PG.update(AlertSilences)
						.set({ updatedAt: nowMs, ...set })
						.where(($) => [$.orgId.eq(orgId), $.id.eq(rowId)]),
				)
				.pipe(Effect.as(1))

		// A running row the schedule no longer has ends now; a future one it no longer has goes.
		const orphans = Arr.filter(rows, (row) => !starts.has(row.startsAt))
		const ended = yield* Effect.forEach(
			Arr.filter(orphans, (row) => row.startsAt <= nowMs && row.endsAt > nowMs),
			(row) => setRow(row.id, { endsAt: nowMs }),
		)
		const stale = Arr.map(
			Arr.filter(orphans, (row) => row.startsAt > nowMs),
			(row) => row.id,
		)
		if (stale.length > 0)
			yield* db.run(PG.deleteFrom(AlertSilences).where(($) => [$.orgId.eq(orgId), $.id.in_(...stale)]))

		const writes = yield* Effect.forEach(occurrences, (occurrence) => {
			const row = byStart.get(occurrence.startsAtMs)
			if (occurrence.startsAtMs > nowMs || row === undefined)
				return insertOccurrence(db, makeUuid, window, occurrence, nowMs).pipe(Effect.as(1))
			if (refresh) return setRow(row.id, { ...fields, endsAt: occurrence.endsAtMs })
			// Without an edit, an ended row stays ended and a running one keeps its occurrence's end.
			return row.endsAt <= nowMs || row.endsAt === occurrence.endsAtMs
				? Effect.succeed(0)
				: setRow(row.id, { endsAt: occurrence.endsAtMs })
		})
		return ended.length + stale.length + Arr.reduce(writes, 0, (sum, count) => sum + count)
	})
