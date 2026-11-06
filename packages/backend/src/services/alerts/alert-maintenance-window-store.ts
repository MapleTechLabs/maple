import {
	AlertMaintenanceWindowDocument,
	AlertSilenceMatchers,
	fromStoredMaintenanceSchedule,
	maintenanceOccurrences,
	maintenanceWindowCoversSeries,
	StoredAlertMaintenanceSchedule,
	type OrgId,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AlertMaintenanceWindows, AlertSilences, type AlertMaintenanceWindowRow } from "@maple/db/tables"
import type { MapleDb, MapleDbError } from "@maple/db/client"
import { Array as Arr, Effect, Option, Schema } from "effect"
import type { BaselineExclusion } from "./anomaly/detection"

const decodeMatchers = Schema.decodeUnknownOption(AlertSilenceMatchers)
const decodeSchedule = Schema.decodeUnknownOption(StoredAlertMaintenanceSchedule)
const decodeDocument = Schema.decodeUnknownOption(AlertMaintenanceWindowDocument)

const iso = (ms: number) => new Date(ms).toISOString()
const NEXT_OCCURRENCE_LOOKAHEAD_MS = 8 * 24 * 60 * 60_000

/** A window row with its JSON left undecoded, so an old or newer shape cannot fail the read. */
export type StoredMaintenanceWindowRow = Omit<AlertMaintenanceWindowRow, "matchersJson" | "scheduleJson"> & {
	readonly matchersJson: unknown
	readonly scheduleJson: unknown
}

export interface DecodedMaintenanceWindow {
	readonly row: StoredMaintenanceWindowRow
	readonly matchers: AlertSilenceMatchers
	readonly schedule: StoredAlertMaintenanceSchedule
}

export const selectMaintenanceWindows = () =>
	PG.from(AlertMaintenanceWindows).select(($) => ({
		...$,
		matchersJson: PG.undecoded($.matchersJson),
		scheduleJson: PG.undecoded($.scheduleJson),
	}))

/** A row the current schemas cannot read is skipped by every reader rather than misapplied. */
export const decodeMaintenanceWindow = (
	row: StoredMaintenanceWindowRow,
): Option.Option<DecodedMaintenanceWindow> =>
	Option.all({
		matchers: decodeMatchers(row.matchersJson),
		schedule: decodeSchedule(row.scheduleJson),
	}).pipe(Option.map(({ matchers, schedule }) => ({ row, matchers, schedule })))

const nextOccurrence = (window: DecodedMaintenanceWindow, nowMs: number) => {
	if (!window.row.enabled) return null
	const toMs =
		window.schedule._tag === "once"
			? Math.max(window.schedule.endsAt, nowMs) + 1
			: nowMs + NEXT_OCCURRENCE_LOOKAHEAD_MS
	return Option.match(Arr.head(maintenanceOccurrences(window.schedule, nowMs, toMs)), {
		onNone: () => null,
		onSome: (occurrence) => ({ startsAt: iso(occurrence.startsAtMs), endsAt: iso(occurrence.endsAtMs) }),
	})
}

export const maintenanceWindowToDocument = (
	window: DecodedMaintenanceWindow,
	nowMs: number,
): Option.Option<AlertMaintenanceWindowDocument> =>
	decodeDocument({
		id: window.row.id,
		name: window.row.name,
		reason: window.row.reason,
		matchers: window.matchers,
		schedule: fromStoredMaintenanceSchedule(window.schedule),
		excludeFromBaselines: window.row.excludeFromBaselines,
		enabled: window.row.enabled,
		nextOccurrence: nextOccurrence(window, nowMs),
		createdBy: window.row.createdBy,
		updatedBy: window.row.updatedBy,
		createdAt: iso(window.row.createdAt),
		updatedAt: iso(window.row.updatedAt),
	})

/**
 * Baseline exclusions from the maintenance occurrences that actually ran in [fromMs, nowMs):
 * window-owned silences that started, opted out of baselines when written. Reading the
 * silences rather than the windows keeps history fixed when a window is edited or deleted.
 */
export const selectBaselineExclusions = (
	db: MapleDb,
	orgId: OrgId,
	fromMs: number,
	nowMs: number,
): Effect.Effect<ReadonlyArray<BaselineExclusion>, MapleDbError> =>
	db
		.run(
			PG.from(AlertSilences)
				.select(($) => ({
					startsAt: $.startsAt,
					endsAt: $.endsAt,
					matchersJson: PG.undecoded($.matchersJson),
				}))
				.where(($) => [
					$.orgId.eq(orgId),
					$.endsAt.gt(fromMs),
					$.startsAt.lt(nowMs),
					$.maintenanceWindowId.isNotNull(),
					$.excludeFromBaselines.eq(true),
				]),
		)
		.pipe(
			Effect.map((rows) =>
				Arr.flatMap(rows, (row) =>
					Option.match(decodeMatchers(row.matchersJson), {
						onNone: () => [],
						onSome: (matchers) =>
							(matchers.services?.length ?? 0) + (matchers.environments?.length ?? 0) === 0
								? []
								: [
										{
											covers: (serviceName: string, environment: string) =>
												maintenanceWindowCoversSeries(
													matchers,
													serviceName,
													environment,
												),
											ranges: [
												{
													startsAtMs: row.startsAt,
													endsAtMs: Math.min(row.endsAt, nowMs),
												},
											],
										},
									],
					}),
				),
			),
		)
