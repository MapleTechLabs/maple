import { HttpApiBuilder } from "effect/http-api"
import {
	AlertMaintenanceSchedule,
	AlertMaintenanceWindowCreateRequest,
	AlertMaintenanceWindowUpdateRequest,
	CurrentTenant,
	type AlertMaintenanceWindowDocument,
} from "@maple/domain/http"
import type {
	V2AlertMaintenanceWindow,
	V2AlertMaintenanceWindowUpdateParams,
	V2AlertSilenceMatchers,
	V2MaintenanceSchedule,
} from "@maple/domain/http/v2"
import { MapleApiV2, paginateOffsetQuery, timestamp, V2ParameterInvalid } from "@maple/domain/http/v2"
import { Array as Arr, Effect, Schema } from "effect"
import { auditDiff } from "@/routes/v2/audit-changes"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { AlertMaintenanceWindowsService } from "@maple/backend/services/alerts/AlertMaintenanceWindowsService"
import { fromMatchers, hasMatcher, toMatchers } from "./alert-silences.http"

const decodeSchedule = Schema.decodeUnknownEffect(AlertMaintenanceSchedule)

const windowAuditDiff = auditDiff<
	keyof V2AlertMaintenanceWindowUpdateParams & keyof V2AlertMaintenanceWindow
>({
	fields: ["name", "reason", "matchers", "schedule", "exclude_from_baselines", "enabled"],
})

const requireMatcher = (matchers: V2AlertSilenceMatchers) =>
	hasMatcher(matchers)
		? Effect.void
		: Effect.fail(
				V2ParameterInvalid.make(
					"A maintenance window needs at least one rule, tag, service or environment.",
					{ param: "matchers" },
				),
			)

/** The wire schedule as the domain's, with the one-off window and time zone checks as a 400. */
const toSchedule = (schedule: V2MaintenanceSchedule) =>
	decodeSchedule(
		schedule.type === "once"
			? { _tag: "once", startsAt: schedule.starts_at, endsAt: schedule.ends_at }
			: {
					_tag: "weekly",
					timeZone: schedule.time_zone,
					days: schedule.days,
					startTime: schedule.start_time,
					durationMinutes: schedule.duration_minutes,
				},
	).pipe(
		Effect.mapError((error) =>
			V2ParameterInvalid.make(`Invalid schedule: ${error.message}`, { param: "schedule" }),
		),
	)

const fromSchedule = (schedule: AlertMaintenanceWindowDocument["schedule"]): V2MaintenanceSchedule =>
	schedule._tag === "once"
		? { type: "once", starts_at: timestamp(schedule.startsAt), ends_at: timestamp(schedule.endsAt) }
		: {
				type: "weekly",
				time_zone: schedule.timeZone,
				days: schedule.days,
				start_time: schedule.startTime,
				duration_minutes: schedule.durationMinutes,
			}

export const toV2MaintenanceWindow = (doc: AlertMaintenanceWindowDocument): V2AlertMaintenanceWindow => ({
	id: doc.id,
	object: "alert_maintenance_window",
	name: doc.name,
	reason: doc.reason,
	matchers: fromMatchers(doc.matchers),
	schedule: fromSchedule(doc.schedule),
	exclude_from_baselines: doc.excludeFromBaselines,
	enabled: doc.enabled,
	next_occurrence:
		doc.nextOccurrence === null
			? null
			: {
					starts_at: timestamp(doc.nextOccurrence.startsAt),
					ends_at: timestamp(doc.nextOccurrence.endsAt),
				},
	created_by: doc.createdBy,
	created_at: timestamp(doc.createdAt),
	updated_at: timestamp(doc.updatedAt),
})

export const HttpV2AlertMaintenanceWindowsLive = HttpApiBuilder.group(
	MapleApiV2,
	"alertMaintenanceWindows",
	(handlers) =>
		Effect.gen(function* () {
			const windows = yield* AlertMaintenanceWindowsService

			return handlers
				.handle("list", ({ query }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const page = yield* paginateOffsetQuery(query, ({ limit, offset }) =>
							windows
								.list(tenant.orgId, { limit, offset })
								.pipe(
									Effect.map((response) =>
										Arr.map(response.windows, toV2MaintenanceWindow),
									),
								),
						)
						return { object: "list" as const, ...page }
					}),
				)
				.handle("retrieve", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const window = yield* windows.get(tenant.orgId, params.id)
						return toV2MaintenanceWindow(window)
					}),
				)
				.handle("create", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireMatcher(payload.matchers)
						const schedule = yield* toSchedule(payload.schedule)
						const created = yield* windows.create(
							tenant.orgId,
							tenant.userId,
							tenant.roles,
							new AlertMaintenanceWindowCreateRequest({
								name: payload.name,
								...(payload.reason === undefined ? undefined : { reason: payload.reason }),
								matchers: toMatchers(payload.matchers),
								schedule,
								...(payload.exclude_from_baselines === undefined
									? undefined
									: { excludeFromBaselines: payload.exclude_from_baselines }),
								...(payload.enabled === undefined ? undefined : { enabled: payload.enabled }),
							}),
						)
						yield* recordHttpAudit("alert_maintenance_window.created", {
							resourceId: created.id,
							metadata: { name: created.name, schedule: created.schedule._tag },
						})
						return toV2MaintenanceWindow(created)
					}),
				)
				.handle("update", ({ params, payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						if (payload.matchers !== undefined) yield* requireMatcher(payload.matchers)
						const schedule =
							payload.schedule === undefined ? undefined : yield* toSchedule(payload.schedule)
						const current = yield* windows.get(tenant.orgId, params.id)
						const updated = yield* windows.update(
							tenant.orgId,
							tenant.userId,
							tenant.roles,
							params.id,
							new AlertMaintenanceWindowUpdateRequest({
								...(payload.name === undefined ? undefined : { name: payload.name }),
								...(payload.reason === undefined ? undefined : { reason: payload.reason }),
								...(payload.matchers === undefined
									? undefined
									: { matchers: toMatchers(payload.matchers) }),
								...(schedule === undefined ? undefined : { schedule }),
								...(payload.exclude_from_baselines === undefined
									? undefined
									: { excludeFromBaselines: payload.exclude_from_baselines }),
								...(payload.enabled === undefined ? undefined : { enabled: payload.enabled }),
							}),
						)
						yield* recordHttpAudit("alert_maintenance_window.updated", {
							resourceId: updated.id,
							changes: windowAuditDiff(
								payload,
								toV2MaintenanceWindow(current),
								toV2MaintenanceWindow(updated),
							),
							metadata: { name: updated.name },
						})
						return toV2MaintenanceWindow(updated)
					}),
				)
				.handle("delete", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const deleted = yield* windows.delete(
							tenant.orgId,
							tenant.userId,
							tenant.roles,
							params.id,
						)
						yield* recordHttpAudit("alert_maintenance_window.deleted", {
							resourceId: deleted.id,
							metadata: { name: deleted.name },
						})
						return {
							id: deleted.id,
							object: "alert_maintenance_window" as const,
							deleted: true as const,
						}
					}),
				)
		}),
)
