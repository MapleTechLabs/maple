import { HttpApiBuilder } from "effect/http-api"
import {
	AlertValidationError,
	CurrentTenant,
	OnCallOverrideCreateRequest,
	OnCallScheduleCreateRequest,
	OnCallScheduleUpdateRequest,
	type OnCallOverrideDocument,
	type OnCallScheduleDocument,
	type OnCallScheduleId,
	type OnCallShiftDocument,
} from "@maple/domain/http"
import type {
	V2OnCallOverride,
	V2OnCallOverrideDeleteResponse,
	V2OnCallSchedule,
	V2OnCallScheduleDeleteResponse,
	V2OnCallScheduleUpdateParams,
	V2OnCallShift,
} from "@maple/domain/http/v2"
import {
	fromV2OnCallLayer,
	MapleApiV2,
	paginateArray,
	timestamp,
	toV2OnCallLayer,
	v2TimestampMs,
} from "@maple/domain/http/v2"
import { Array as Arr, Clock, Effect, Schema } from "effect"
import { auditDiff } from "@/routes/v2/audit-changes"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { OnCallSchedulesService } from "@maple/backend/services/alerts/OnCallSchedulesService"

const DEFAULT_SHIFTS_RANGE_MS = 14 * 86_400_000

const scheduleAuditDiff = auditDiff<keyof V2OnCallScheduleUpdateParams & keyof V2OnCallSchedule>({
	fields: ["name", "description", "time_zone", "layers"],
})

export const toV2OnCallSchedule = (doc: OnCallScheduleDocument): V2OnCallSchedule => ({
	id: doc.id,
	object: "oncall_schedule",
	name: doc.name,
	description: doc.description,
	time_zone: doc.timeZone,
	layers: Arr.map(doc.layers, toV2OnCallLayer),
	on_call_now:
		doc.onCallNow === null
			? null
			: {
					user_id: doc.onCallNow.userId,
					starts_at: timestamp(doc.onCallNow.startsAt),
					ends_at: timestamp(doc.onCallNow.endsAt),
				},
	chain_ids: doc.chainIds,
	created_at: timestamp(doc.createdAt),
	updated_at: timestamp(doc.updatedAt),
})

const toV2Override = (doc: OnCallOverrideDocument): V2OnCallOverride => ({
	id: doc.id,
	object: "oncall_override",
	schedule_id: doc.scheduleId,
	user_id: doc.userId,
	starts_at: timestamp(doc.startsAt),
	ends_at: timestamp(doc.endsAt),
	created_by: doc.createdBy,
	created_at: timestamp(doc.createdAt),
})

const toV2Shift = (shift: OnCallShiftDocument): V2OnCallShift => ({
	user_id: shift.userId,
	starts_at: timestamp(shift.startsAt),
	ends_at: timestamp(shift.endsAt),
	source:
		shift.source.kind === "override"
			? { kind: "override", override_id: shift.source.overrideId }
			: { kind: "layer", layer_index: shift.source.layerIndex },
})

const scheduleObject = (id: OnCallScheduleId) => ({ schedule_id: id })

/**
 * The service request, decoded rather than constructed: a wire timestamp before 1970 is valid
 * ISO but not a stored epoch, and must be a 400, not a thrown constructor.
 */
const decodeRequest =
	<S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
	(input: unknown) =>
		Schema.decodeUnknownEffect(schema)(input).pipe(
			Effect.mapError(
				(error) => new AlertValidationError({ message: error.message, details: [error.message] }),
			),
		)

const decodeScheduleCreate = decodeRequest(OnCallScheduleCreateRequest)
const decodeScheduleUpdate = decodeRequest(OnCallScheduleUpdateRequest)
const decodeOverrideCreate = decodeRequest(OnCallOverrideCreateRequest)

export const HttpV2OnCallSchedulesLive = HttpApiBuilder.group(MapleApiV2, "oncallSchedules", (handlers) =>
	Effect.gen(function* () {
		const schedules = yield* OnCallSchedulesService

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					// The service returns the org's whole (capped) set, so pages are cut from it.
					const response = yield* schedules.list(tenant.orgId)
					const page = yield* paginateArray(Arr.map(response.schedules, toV2OnCallSchedule), query)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const schedule = yield* schedules.get(tenant.orgId, params.id)
					return toV2OnCallSchedule(schedule)
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const request = yield* decodeScheduleCreate({
						name: payload.name,
						...(payload.description === undefined
							? undefined
							: { description: payload.description }),
						timeZone: payload.time_zone,
						layers: Arr.map(payload.layers, fromV2OnCallLayer),
					})
					const created = yield* schedules.create(
						tenant.orgId,
						tenant.userId,
						tenant.roles,
						request,
					)
					yield* recordHttpAudit("oncall_schedule.created", {
						resourceId: created.id,
						metadata: { name: created.name, layers: created.layers.length },
					})
					return toV2OnCallSchedule(created)
				}),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const request = yield* decodeScheduleUpdate({
						...(payload.name === undefined ? undefined : { name: payload.name }),
						...(payload.description === undefined
							? undefined
							: { description: payload.description }),
						...(payload.time_zone === undefined ? undefined : { timeZone: payload.time_zone }),
						...(payload.layers === undefined
							? undefined
							: { layers: Arr.map(payload.layers, fromV2OnCallLayer) }),
					})
					const current = yield* schedules.get(tenant.orgId, params.id)
					const updated = yield* schedules.update(
						tenant.orgId,
						tenant.userId,
						tenant.roles,
						params.id,
						request,
					)
					yield* recordHttpAudit("oncall_schedule.updated", {
						resourceId: updated.id,
						changes: scheduleAuditDiff(
							payload,
							toV2OnCallSchedule(current),
							toV2OnCallSchedule(updated),
						),
						metadata: { name: updated.name },
					})
					return toV2OnCallSchedule(updated)
				}),
			)
			.handle("delete", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* schedules.delete(tenant.orgId, tenant.roles, params.id)
					yield* recordHttpAudit("oncall_schedule.deleted", { resourceId: params.id })
					const deleted: V2OnCallScheduleDeleteResponse = {
						id: params.id,
						object: "oncall_schedule",
						deleted: true,
					}
					return deleted
				}),
			)
			.handle("oncall", ({ params, query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const atMs =
						query.at === undefined ? yield* Clock.currentTimeMillis : v2TimestampMs(query.at)
					const result = yield* schedules.onCallAt(tenant.orgId, params.id, atMs)
					return {
						object: "oncall" as const,
						...scheduleObject(params.id),
						at: timestamp(result.at),
						shift: result.shift === null ? null : toV2Shift(result.shift),
					}
				}),
			)
			.handle("shifts", ({ params, query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const fromMs =
						query.from === undefined ? yield* Clock.currentTimeMillis : v2TimestampMs(query.from)
					const toMsValue =
						query.to === undefined ? fromMs + DEFAULT_SHIFTS_RANGE_MS : v2TimestampMs(query.to)
					const render = yield* schedules.shifts(tenant.orgId, params.id, fromMs, toMsValue)
					return {
						object: "oncall_shifts" as const,
						...scheduleObject(params.id),
						from: timestamp(render.from),
						to: timestamp(render.to),
						layers: Arr.map(render.layers, (layer) => Arr.map(layer, toV2Shift)),
						final: Arr.map(render.final, toV2Shift),
					}
				}),
			)
			.handle("listOverrides", ({ params, query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const response = yield* schedules.listOverrides(
						tenant.orgId,
						params.id,
						query.from === undefined ? undefined : v2TimestampMs(query.from),
					)
					const page = yield* paginateArray(Arr.map(response.overrides, toV2Override), query)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("createOverride", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const request = yield* decodeOverrideCreate({
						userId: payload.user_id,
						startsAt: v2TimestampMs(payload.starts_at),
						endsAt: v2TimestampMs(payload.ends_at),
					})
					const created = yield* schedules.createOverride(
						tenant.orgId,
						tenant.userId,
						tenant.roles,
						params.id,
						request,
					)
					yield* recordHttpAudit("oncall_override.created", {
						resourceId: created.id,
						metadata: {
							scheduleId: params.id,
							userId: created.userId,
							startsAt: created.startsAt,
							endsAt: created.endsAt,
						},
					})
					return toV2Override(created)
				}),
			)
			.handle("deleteOverride", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* schedules.deleteOverride(tenant.orgId, tenant.roles, params.id, params.override_id)
					yield* recordHttpAudit("oncall_override.deleted", {
						resourceId: params.override_id,
						metadata: { scheduleId: params.id },
					})
					const deleted: V2OnCallOverrideDeleteResponse = {
						id: params.override_id,
						object: "oncall_override",
						deleted: true,
					}
					return deleted
				}),
			)
	}),
)
