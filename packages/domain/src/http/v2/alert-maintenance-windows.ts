import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import { AlertForbiddenError, AlertPersistenceError, AlertValidationError } from "../alerts"
import {
	AlertMaintenanceWindowName,
	AlertMaintenanceWindowNotFoundError,
	AlertMaintenanceWindowReason,
	MaintenanceDurationMinutes,
	MaintenanceStartTime,
	MaintenanceTimeZone,
	MaintenanceWeekday,
} from "../alert-maintenance-windows"
import { AuthorizationV2 } from "./auth"
import { wireExample, ListOf, ListQuery, Timestamp } from "./envelopes"
import { V2ParameterInvalid } from "./errors"
import { publicErrors } from "./public-error"
import { AlertMaintenanceWindowPublicId } from "./resource-ids"
import { V2AlertSilenceMatchers } from "./alert-silences"

export const V2MaintenanceScheduleOnce = Schema.Struct({
	type: Schema.Literal("once"),
	starts_at: Timestamp.annotate({ description: "When the window opens." }),
	ends_at: Timestamp.annotate({
		description: "When the window closes. At most 30 days after `starts_at`.",
	}),
}).annotate({
	identifier: "AlertMaintenanceScheduleOnce",
	title: "One-off maintenance schedule",
	description: "A single window between two instants.",
})

export const V2MaintenanceScheduleWeekly = Schema.Struct({
	type: Schema.Literal("weekly"),
	time_zone: MaintenanceTimeZone.annotate({
		description: "IANA time zone the start time is read in, e.g. `Europe/Berlin`.",
		examples: ["Europe/Berlin"],
	}),
	days: Schema.Array(MaintenanceWeekday)
		.check(Schema.isMinLength(1), Schema.isUnique())
		.annotate({ description: "Weekdays the window opens on.", examples: [["sat", "sun"]] }),
	start_time: MaintenanceStartTime.annotate({
		description:
			"Local start time as `HH:MM`. A start in a daylight-saving gap opens at the zone's next valid time.",
		examples: ["02:00"],
	}),
	duration_minutes: MaintenanceDurationMinutes.annotate({
		description: "How long each occurrence lasts, 5 minutes to 7 days.",
		examples: [120],
	}),
}).annotate({
	identifier: "AlertMaintenanceScheduleWeekly",
	title: "Weekly maintenance schedule",
	description: "A window that opens on the given weekdays at a local time in a time zone.",
})

export const V2MaintenanceSchedule = Schema.Union([
	V2MaintenanceScheduleOnce,
	V2MaintenanceScheduleWeekly,
]).annotate({
	identifier: "AlertMaintenanceSchedule",
	title: "Maintenance schedule",
	description: "`once` for a single window, `weekly` for a recurring one.",
})
export type V2MaintenanceSchedule = Schema.Schema.Type<typeof V2MaintenanceSchedule>

const maintenanceWindowExample = {
	id: "mw_9Hq3cW1rN2kLmP7vX4yZtB",
	object: "alert_maintenance_window",
	name: "Weekend database maintenance",
	reason: "Vacuum and index rebuilds",
	matchers: { services: ["checkout"] },
	schedule: {
		type: "weekly",
		time_zone: "Europe/Berlin",
		days: ["sat"],
		start_time: "02:00",
		duration_minutes: 120,
	},
	exclude_from_baselines: true,
	enabled: true,
	next_occurrence: { starts_at: "2026-07-18T00:00:00.000Z", ends_at: "2026-07-18T02:00:00.000Z" },
	created_by: "user_2abc",
	created_at: "2026-07-15T09:00:00.000Z",
	updated_at: "2026-07-15T09:00:00.000Z",
} as const

export const V2AlertMaintenanceWindow = Schema.Struct({
	id: AlertMaintenanceWindowPublicId,
	object: Schema.Literal("alert_maintenance_window").annotate({
		description: 'The object type, always `"alert_maintenance_window"`.',
		examples: ["alert_maintenance_window"],
	}),
	name: Schema.String.annotate({ examples: ["Weekend database maintenance"] }),
	reason: Schema.NullOr(Schema.String).annotate({ description: "Why the window exists." }),
	matchers: V2AlertSilenceMatchers,
	schedule: V2MaintenanceSchedule,
	exclude_from_baselines: Schema.Boolean.annotate({
		description:
			"Whether hours under this window are left out of anomaly baselines. Applies only when the window names a service or environment.",
	}),
	enabled: Schema.Boolean.annotate({ description: "A disabled window writes no silences." }),
	next_occurrence: Schema.NullOr(
		Schema.Struct({ starts_at: Timestamp, ends_at: Timestamp }).annotate({
			identifier: "AlertMaintenanceOccurrence",
			title: "Maintenance occurrence",
		}),
	).annotate({ description: "The occurrence running now, else the next one; null when none is left." }),
	created_by: Schema.String.annotate({ description: "The user (`user_…`) who created the window." }),
	created_at: Timestamp,
	updated_at: Timestamp,
}).annotate({
	identifier: "AlertMaintenanceWindow",
	title: "Alert Maintenance Window",
	description:
		"A one-off or weekly window during which matching alert rules are silenced. Each occurrence is written ahead as an alert silence carrying `maintenance_window_id`, so rules keep evaluating and only notifications are held back.",
	examples: [wireExample(maintenanceWindowExample)],
})
export type V2AlertMaintenanceWindow = Schema.Schema.Type<typeof V2AlertMaintenanceWindow>

export const V2AlertMaintenanceWindowCreateParams = Schema.Struct({
	name: AlertMaintenanceWindowName.annotate({ examples: ["Weekend database maintenance"] }),
	reason: Schema.optionalKey(Schema.NullOr(AlertMaintenanceWindowReason)),
	matchers: V2AlertSilenceMatchers,
	schedule: V2MaintenanceSchedule,
	exclude_from_baselines: Schema.optionalKey(
		Schema.Boolean.annotate({ description: "Defaults to `true`." }),
	),
	enabled: Schema.optionalKey(Schema.Boolean.annotate({ description: "Defaults to `true`." })),
}).annotate({
	identifier: "AlertMaintenanceWindowCreateParams",
	title: "Create maintenance window",
	description: "At least one matcher value is required.",
})
export type V2AlertMaintenanceWindowCreateParams = Schema.Schema.Type<
	typeof V2AlertMaintenanceWindowCreateParams
>

export const V2AlertMaintenanceWindowUpdateParams = Schema.Struct({
	name: Schema.optionalKey(AlertMaintenanceWindowName),
	reason: Schema.optionalKey(Schema.NullOr(AlertMaintenanceWindowReason)),
	matchers: Schema.optionalKey(V2AlertSilenceMatchers),
	schedule: Schema.optionalKey(V2MaintenanceSchedule),
	exclude_from_baselines: Schema.optionalKey(Schema.Boolean),
	enabled: Schema.optionalKey(Schema.Boolean),
}).annotate({
	identifier: "AlertMaintenanceWindowUpdateParams",
	title: "Update maintenance window",
	description:
		"Omitted fields are left unchanged. Occurrences ahead are rewritten; one in progress keeps running with the new matchers.",
})
export type V2AlertMaintenanceWindowUpdateParams = Schema.Schema.Type<
	typeof V2AlertMaintenanceWindowUpdateParams
>

export const V2AlertMaintenanceWindowDeleteResponse = Schema.Struct({
	id: AlertMaintenanceWindowPublicId,
	object: Schema.Literal("alert_maintenance_window"),
	deleted: Schema.Literal(true),
}).annotate({
	identifier: "AlertMaintenanceWindowDeleteResponse",
	title: "Maintenance window delete response",
	description: "Confirmation that a maintenance window was deleted.",
	examples: [
		wireExample({ id: "mw_9Hq3cW1rN2kLmP7vX4yZtB", object: "alert_maintenance_window", deleted: true }),
	],
})
export type V2AlertMaintenanceWindowDeleteResponse = Schema.Schema.Type<
	typeof V2AlertMaintenanceWindowDeleteResponse
>

const AlertMaintenanceWindowList = ListOf(V2AlertMaintenanceWindow).annotate({
	identifier: "AlertMaintenanceWindowList",
	title: "Maintenance window list",
	description: "A cursor-paginated page of maintenance windows, newest first.",
})

const [alertForbidden, alertValidation, alertPersistence, maintenanceWindowNotFound] = publicErrors(
	AlertForbiddenError,
	AlertValidationError,
	AlertPersistenceError,
	AlertMaintenanceWindowNotFoundError,
)

export class V2AlertMaintenanceWindowsApiGroup extends HttpApiGroup.make("alertMaintenanceWindows")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: ListQuery,
			success: AlertMaintenanceWindowList,
			error: [V2ParameterInvalid.schema, alertPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listAlertMaintenanceWindows",
				summary: "List maintenance windows",
				description:
					"Returns your organization's maintenance windows, newest first. Requires the `alerts:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: { id: AlertMaintenanceWindowPublicId },
			success: V2AlertMaintenanceWindow,
			error: [maintenanceWindowNotFound, alertPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getAlertMaintenanceWindow",
				summary: "Retrieve a maintenance window",
				description:
					"Returns a single maintenance window by its `mw_…` ID. Requires the `alerts:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: V2AlertMaintenanceWindowCreateParams,
			success: V2AlertMaintenanceWindow,
			error: [V2ParameterInvalid.schema, alertForbidden, alertValidation, alertPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "createAlertMaintenanceWindow",
				summary: "Create a maintenance window",
				description:
					"Creates a one-off or weekly maintenance window. Its occurrences in the next 48 hours are written as silences right away. Requires a role that can manage alerts and the `alerts:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.patch("update", "/:id", {
			params: { id: AlertMaintenanceWindowPublicId },
			payload: V2AlertMaintenanceWindowUpdateParams,
			success: V2AlertMaintenanceWindow,
			error: [
				V2ParameterInvalid.schema,
				alertForbidden,
				alertValidation,
				alertPersistence,
				maintenanceWindowNotFound,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "updateAlertMaintenanceWindow",
				summary: "Update a maintenance window",
				description:
					"Changes a maintenance window. `enabled: false` ends an occurrence in progress now. Requires the `alerts:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/:id", {
			params: { id: AlertMaintenanceWindowPublicId },
			success: V2AlertMaintenanceWindowDeleteResponse,
			error: [alertForbidden, alertPersistence, maintenanceWindowNotFound],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "deleteAlertMaintenanceWindow",
				summary: "Delete a maintenance window",
				description:
					"Deletes a maintenance window, ends an occurrence in progress now and drops the ones ahead. Past occurrences stay as ended silences. Requires the `alerts:write` scope.",
			}),
		),
	)
	.prefix("/v2/alerts/maintenance_windows")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Alert Maintenance Windows",
			description:
				"Planned, recurring quiet periods for alerting. Each occurrence silences matching rules and can keep its hours out of anomaly baselines.",
		}),
	) {}
