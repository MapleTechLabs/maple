import { McpInvalidInputError, type McpToolFamilyBuilder } from "./types"
import { DateTime, Effect, Schema } from "effect"
import {
	type AlertMaintenanceWindowDocument,
	AlertMaintenanceWindowUpdateRequest,
	MAINTENANCE_WEEKDAYS,
} from "@maple/domain/http"
import { AlertMaintenanceWindowsService } from "@maple/backend/services/alerts/AlertMaintenanceWindowsService"
import { parseWarehouseDateTime } from "@maple/query-engine"
import { CurrentMcpTenant } from "../tenant"
import {
	createWindowErrors,
	deleteWindowErrors,
	maintenanceWindowFields,
	toMaintenanceWindowRow,
} from "../lib/maintenance-windows"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const decodeUpdateRequest = Schema.decodeUnknownEffect(AlertMaintenanceWindowUpdateRequest)
const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms))

const invalid = (message: string, parameter: string) => new McpInvalidInputError({ message, parameter })

interface ScheduleChange {
	readonly starts_at?: string | undefined
	readonly ends_at?: string | undefined
	readonly time_zone?: string | undefined
	readonly days?: ReadonlyArray<string> | undefined
	readonly start_time_of_day?: string | undefined
	readonly duration_minutes?: number | undefined
}

/** The window's schedule with the given fields changed; undefined when none was given. */
const scheduleWith = Effect.fnUntraced(function* (
	current: AlertMaintenanceWindowDocument["schedule"],
	change: ScheduleChange,
) {
	if (current._tag === "weekly") {
		if (change.starts_at !== undefined || change.ends_at !== undefined) {
			return yield* invalid(
				"This window repeats weekly: change days, start_time_of_day, time_zone or duration_minutes. A one-off window is a new window.",
				change.starts_at === undefined ? "ends_at" : "starts_at",
			)
		}
		if (
			change.days === undefined &&
			change.start_time_of_day === undefined &&
			change.time_zone === undefined &&
			change.duration_minutes === undefined
		) {
			return undefined
		}
		return {
			_tag: "weekly",
			timeZone: change.time_zone ?? current.timeZone,
			days: change.days ?? current.days,
			startTime: change.start_time_of_day ?? current.startTime,
			durationMinutes: change.duration_minutes ?? current.durationMinutes,
		}
	}
	if (
		change.days !== undefined ||
		change.start_time_of_day !== undefined ||
		change.time_zone !== undefined
	) {
		return yield* invalid(
			"This is a one-off window: change starts_at, ends_at or duration_minutes. A weekly window is a new window.",
			change.days === undefined ? "start_time_of_day" : "days",
		)
	}
	if (change.ends_at !== undefined && change.duration_minutes !== undefined) {
		return yield* invalid("Pass ends_at or duration_minutes, not both.", "duration_minutes")
	}
	if (
		change.starts_at === undefined &&
		change.ends_at === undefined &&
		change.duration_minutes === undefined
	) {
		return undefined
	}
	const startsAtMs =
		change.starts_at === undefined
			? parseWarehouseDateTime(current.startsAt)
			: parseWarehouseDateTime(change.starts_at)
	// Moving the start keeps the window's length unless an end is given too.
	const lengthMs = parseWarehouseDateTime(current.endsAt) - parseWarehouseDateTime(current.startsAt)
	const endsAtMs =
		change.ends_at !== undefined
			? parseWarehouseDateTime(change.ends_at)
			: startsAtMs +
				(change.duration_minutes === undefined ? lengthMs : change.duration_minutes * 60_000)
	return { _tag: "once", startsAt: isoAt(startsAtMs), endsAt: isoAt(endsAtMs) }
})

export const updateMaintenanceWindowAction = (family: McpToolFamilyBuilder<"manage_maintenance_window">) =>
	family.action("update", {
		description:
			"Change a maintenance window in place: its name, reason, schedule or what it matches, or turn it off (enabled=false) without deleting it. Fields left out keep their value. " +
			"A weekly window takes days, start_time_of_day, time_zone and duration_minutes; a one-off window takes starts_at and ends_at or duration_minutes. " +
			"A matcher list you pass replaces that matcher; an empty list removes it. Ids from list_maintenance_windows.",
		parameters: Schema.Struct({
			maintenance_window_id: P.resourceId("alertMaintenanceWindow", "Maintenance window to change"),
			name: P.optionalText("A new name"),
			reason: P.optionalText("A new reason"),
			enabled: P.optionalFlag("false stops the window opening without deleting it; true resumes"),
			starts_at: P.optionalTimestamp("One-off window: a new opening time"),
			ends_at: P.optionalTimestamp("One-off window: a new closing time"),
			time_zone: P.optionalText("Weekly window: a new IANA time zone, e.g. Europe/Berlin"),
			days: P.optionalOneOfList(MAINTENANCE_WEEKDAYS, "Weekly window: the weekdays it opens on"),
			start_time_of_day: P.optionalText("Weekly window: a new local start, HH:MM (24-hour)"),
			duration_minutes: P.optionalNumber("How long each occurrence lasts, in minutes"),
			rule_ids: P.optionalResourceIdList("alertRule", "Replace the alert rules it silences"),
			tags: P.optionalList("Replace the rule tags it silences"),
			services: P.optionalList("Replace the services it silences"),
			environments: P.optionalList("Replace the environments it silences"),
			exclude_from_baselines: P.optionalFlag("Leave the window's hours out of anomaly baselines"),
		}),
		aliases: { service_names: "services", start_time: "start_time_of_day" },
		hints: { readOnly: false, destructive: false, idempotent: true },
		permission: "alerts:manage",
		handler: Effect.fn("McpTool.updateMaintenanceWindow")(function* (params) {
			const windowId = yield* P.decodeResourceId(
				"alertMaintenanceWindow",
				"maintenance_window_id",
			)(params.maintenance_window_id)
			const tenant = yield* CurrentMcpTenant
			const windows = yield* AlertMaintenanceWindowsService
			const ruleIds =
				params.rule_ids === undefined
					? undefined
					: yield* Effect.forEach(params.rule_ids, P.decodeResourceId("alertRule", "rule_ids"))
			const matchersGiven =
				ruleIds !== undefined ||
				params.tags !== undefined ||
				params.services !== undefined ||
				params.environments !== undefined

			// Built from the window the write lands on: the service replaces schedule and matchers
			// whole, so merging into an earlier read would undo an edit saved in between.
			const changeFor = Effect.fnUntraced(function* (current: AlertMaintenanceWindowDocument) {
				const schedule = yield* scheduleWith(current.schedule, params)
				const merged = {
					ruleIds: ruleIds ?? current.matchers.ruleIds ?? [],
					tags: params.tags ?? current.matchers.tags ?? [],
					services: params.services ?? current.matchers.services ?? [],
					environments: params.environments ?? current.matchers.environments ?? [],
				}
				const matchers = {
					...(merged.ruleIds.length === 0 ? undefined : { ruleIds: merged.ruleIds }),
					...(merged.tags.length === 0 ? undefined : { tags: merged.tags }),
					...(merged.services.length === 0 ? undefined : { services: merged.services }),
					...(merged.environments.length === 0 ? undefined : { environments: merged.environments }),
				}
				if (matchersGiven && Object.keys(matchers).length === 0) {
					return yield* invalid(
						"A maintenance window needs at least one matcher: rule_ids, tags, services or environments. To stop it, pass enabled=false or delete it.",
						"services",
					)
				}

				const change = {
					...(params.name === undefined ? undefined : { name: params.name }),
					...(params.reason === undefined ? undefined : { reason: params.reason }),
					...(params.enabled === undefined ? undefined : { enabled: params.enabled }),
					...(schedule === undefined ? undefined : { schedule }),
					...(matchersGiven ? { matchers } : undefined),
					...(params.exclude_from_baselines === undefined
						? undefined
						: { excludeFromBaselines: params.exclude_from_baselines }),
				}
				if (Object.keys(change).length === 0) {
					return yield* invalid(
						"Nothing to change: pass at least one field besides maintenance_window_id.",
						"name",
					)
				}
				return yield* decodeUpdateRequest(change).pipe(
					Effect.mapError(
						(error) =>
							new McpInvalidInputError({
								message: `Invalid maintenance window: ${error.message}`,
							}),
					),
				)
			})
			const window = yield* windows
				.revise(tenant.orgId, tenant.userId, tenant.permissions, windowId, changeFor)
				.pipe(Effect.catchTags({ ...createWindowErrors, ...deleteWindowErrors }))
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"maple.alert.maintenance_window_id": window.id,
			})
			return { window: toMaintenanceWindowRow(window) }
		}),
		render: (output) => ({
			title: "Maintenance Window Updated",
			notices: output.window.enabled
				? []
				: [
						"The window is off: it opens no occurrences and silences nothing until manage_maintenance_window action=update enabled=true.",
					],
			blocks: [maintenanceWindowFields(output.window)],
			next: [
				doc.next("list_maintenance_windows", {}, "every maintenance window"),
				doc.next("list_alert_silences", {}, "the silences its occurrences become"),
			],
		}),
	})
