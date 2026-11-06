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
import { AlertMaintenanceWindows, type AlertMaintenanceWindowRow } from "@maple/db/tables"
import type { MapleDb } from "@maple/db/client"
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

/** Windows that can affect a baseline: enabled, opted in, and naming a service or environment. */
export const selectBaselineMaintenanceWindows = (db: MapleDb, orgId: OrgId) =>
	db
		.run(
			selectMaintenanceWindows().where(($) => [
				$.orgId.eq(orgId),
				$.enabled.eq(true),
				$.excludeFromBaselines.eq(true),
			]),
		)
		.pipe(Effect.map((rows) => Arr.getSomes(Arr.map(rows, decodeMaintenanceWindow))))

/** The baseline ranges each window excludes over [fromMs, toMs), as plain data for the detector. */
export const maintenanceBaselineExclusions = (
	windows: ReadonlyArray<DecodedMaintenanceWindow>,
	fromMs: number,
	toMs: number,
): ReadonlyArray<BaselineExclusion> =>
	Arr.flatMap(windows, (window) => {
		if ((window.matchers.services?.length ?? 0) + (window.matchers.environments?.length ?? 0) === 0)
			return []
		const ranges = maintenanceOccurrences(window.schedule, fromMs, toMs)
		if (ranges.length === 0) return []
		return [
			{
				covers: (serviceName: string, environment: string) =>
					maintenanceWindowCoversSeries(window.matchers, serviceName, environment),
				ranges,
			},
		]
	})
