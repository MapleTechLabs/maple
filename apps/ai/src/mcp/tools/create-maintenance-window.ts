import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Clock, DateTime, Effect, Schema } from "effect"
import { AlertMaintenanceWindowCreateRequest } from "@maple/domain/http"
import { MaintenanceWindowMutationOutput } from "@maple/domain/mcp-outputs"
import { AlertMaintenanceWindowsService } from "@maple/backend/services/alerts/AlertMaintenanceWindowsService"
import { parseWarehouseDateTime } from "@maple/query-engine"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import {
	createWindowErrors,
	MAINTENANCE_WEEKDAYS,
	maintenanceWindowFields,
	toMaintenanceWindowRow,
} from "../lib/maintenance-windows"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const decodeCreateRequest = Schema.decodeUnknownEffect(AlertMaintenanceWindowCreateRequest)
const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms))
/** Checked before any date maths, so an absurd duration cannot overflow the end time. */
const MAX_ONCE_DURATION_MINUTES = 30 * 24 * 60

/** Only the matcher lists that hold a value, so an empty list never reaches the service. */
const nonEmpty = <K extends string>(key: K, values: ReadonlyArray<string> | undefined) =>
	values === undefined || values.length === 0 ? undefined : { [key]: values }

const invalid = (message: string, parameter?: string) =>
	new McpInvalidInputError({ message, ...(parameter === undefined ? undefined : { parameter }) })

interface ScheduleParams {
	readonly schedule_type: "once" | "weekly"
	readonly starts_at?: string | undefined
	readonly ends_at?: string | undefined
	readonly time_zone?: string | undefined
	readonly days?: ReadonlyArray<string> | undefined
	readonly start_time?: string | undefined
	readonly duration_minutes?: number | undefined
}

/** The schedule the parameters describe, before the domain schema validates it. */
const scheduleFrom = Effect.fnUntraced(function* (params: ScheduleParams) {
	if (params.schedule_type === "weekly") {
		if (params.days === undefined || params.days.length === 0)
			return yield* invalid('A weekly window needs days, e.g. ["sat", "sun"].', "days")
		if (params.start_time === undefined)
			return yield* invalid("A weekly window needs start_time as HH:MM.", "start_time")
		if (params.duration_minutes === undefined)
			return yield* invalid("A weekly window needs duration_minutes.", "duration_minutes")
		return {
			_tag: "weekly",
			timeZone: params.time_zone ?? "UTC",
			days: params.days,
			startTime: params.start_time,
			durationMinutes: params.duration_minutes,
		}
	}
	if ((params.duration_minutes === undefined) === (params.ends_at === undefined)) {
		return yield* invalid(
			"A one-off window needs exactly one of ends_at and duration_minutes.",
			"duration_minutes",
		)
	}
	if (
		params.duration_minutes !== undefined &&
		(params.duration_minutes <= 0 || params.duration_minutes > MAX_ONCE_DURATION_MINUTES)
	) {
		return yield* invalid(
			"duration_minutes must be positive and at most 30 days (43200 minutes).",
			"duration_minutes",
		)
	}
	const nowMs = yield* Clock.currentTimeMillis
	const startsAtMs = params.starts_at === undefined ? nowMs : parseWarehouseDateTime(params.starts_at)
	const endsAtMs =
		params.ends_at === undefined
			? startsAtMs + (params.duration_minutes ?? 0) * 60_000
			: parseWarehouseDateTime(params.ends_at)
	return { _tag: "once", startsAt: isoAt(startsAtMs), endsAt: isoAt(endsAtMs) }
})

export function registerCreateMaintenanceWindowTool(server: McpToolRegistrar) {
	server.define({
		name: "create_maintenance_window",
		title: "Create Maintenance Window",
		description:
			"Schedule a maintenance window: alert notifications for matching rules are held back during each occurrence (incidents still open and resolve). " +
			"schedule_type=once takes starts_at (default now) and ends_at or duration_minutes (max 30 days); " +
			"schedule_type=weekly takes days, start_time (HH:MM, local to time_zone) and duration_minutes (5 to 10080). " +
			"Matchers AND together, values inside one OR; pass at least one. With services or environments, the window's hours are also left out of anomaly baselines unless exclude_from_baselines=false.",
		parameters: Schema.Struct({
			name: P.text("Short name, shown on the window and on the silences it writes"),
			reason: P.optionalText("Why the window exists"),
			schedule_type: P.oneOf(["once", "weekly"], "A single window, or one that repeats every week"),
			starts_at: P.optionalTimestamp("When a one-off window opens (default: now)"),
			ends_at: P.optionalTimestamp("When a one-off window closes"),
			time_zone: P.optionalText(
				"IANA time zone a weekly start_time is read in, e.g. Europe/Berlin (default UTC)",
			),
			days: P.optionalOneOfList(MAINTENANCE_WEEKDAYS, "Weekdays a weekly window opens on"),
			start_time: P.optionalText("Local start of a weekly window, HH:MM (24-hour)"),
			duration_minutes: P.optionalNumber("How long each occurrence lasts, in minutes"),
			rule_ids: P.optionalResourceIdList(
				"alertRule",
				"Silence these alert rules (ids from list_alert_rules)",
			),
			tags: P.optionalList("Silence rules carrying any of these tags"),
			services: P.optionalList("Silence rules and incident groups covered by these services"),
			environments: P.optionalList("Silence rules and incident groups covered by these environments"),
			exclude_from_baselines: P.optionalFlag(
				"Leave the window's hours out of anomaly baselines (default true; needs services or environments)",
			),
		}),
		aliases: { service_names: "services" },
		output: MaintenanceWindowMutationOutput,
		hints: { readOnly: false, destructive: false, idempotent: false },
		phrases: ["Scheduling a maintenance window", "Creating a maintenance window"],
		handler: Effect.fn("McpTool.createMaintenanceWindow")(function* (params) {
			const ruleIds = yield* Effect.forEach(
				params.rule_ids ?? [],
				P.decodeResourceId("alertRule", "rule_ids"),
			)
			const matchers = {
				...nonEmpty("ruleIds", ruleIds),
				...nonEmpty("tags", params.tags),
				...nonEmpty("services", params.services),
				...nonEmpty("environments", params.environments),
			}
			if (Object.keys(matchers).length === 0) {
				return yield* invalid(
					"A maintenance window needs at least one matcher: rule_ids, tags, services or environments. Use list_alert_rules to find them.",
					"services",
				)
			}

			const schedule = yield* scheduleFrom(params)

			const request = yield* decodeCreateRequest({
				name: params.name,
				...(params.reason === undefined ? undefined : { reason: params.reason }),
				matchers,
				schedule,
				...(params.exclude_from_baselines === undefined
					? undefined
					: { excludeFromBaselines: params.exclude_from_baselines }),
			}).pipe(Effect.mapError((error) => invalid(`Invalid maintenance window: ${error.message}`)))

			const tenant = yield* CurrentMcpTenant
			const windows = yield* AlertMaintenanceWindowsService
			const window = yield* windows
				.create(tenant.orgId, tenant.userId, tenant.roles, request)
				.pipe(Effect.catchTags(createWindowErrors))

			return { window: toMaintenanceWindowRow(window) }
		}),
		render: (output) => ({
			title: "Maintenance Window Created",
			blocks: [maintenanceWindowFields(output.window)],
			next: [
				doc.next("list_maintenance_windows", {}, "every maintenance window"),
				doc.next("list_alert_silences", {}, "the silences its occurrences become"),
			],
		}),
	})
}
