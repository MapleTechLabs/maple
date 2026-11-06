import {
	AlertForbiddenError,
	AlertPersistenceError,
	AlertValidationError,
	IsoDateTimeString,
	MAX_ONCALL_FUTURE_OVERRIDES,
	MAX_ONCALL_OVERRIDE_MS,
	MAX_ONCALL_SCHEDULES_PER_ORG,
	OnCallAtResponse,
	OnCallNow,
	OnCallOverrideDocument,
	OnCallOverrideId as OnCallOverrideIdSchema,
	OnCallOverrideNotFoundError,
	OnCallOverridesListResponse,
	OnCallScheduleDocument,
	OnCallScheduleId as OnCallScheduleIdSchema,
	OnCallScheduleNotFoundError,
	OnCallSchedulesListResponse,
	OnCallShiftDocument,
	OnCallShiftsResponse,
	type AlertMemberDirectoryNotConfiguredError,
	type AlertMemberDirectoryUnavailableError,
	type OnCallLayers,
	type OnCallOverride,
	type OnCallOverrideCreateRequest,
	type OnCallOverrideId,
	type OnCallScheduleConfig,
	type OnCallScheduleCreateRequest,
	type OnCallScheduleId,
	type OnCallScheduleUpdateRequest,
	type OrgId,
	type RoleName,
	type UserId,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	OnCallOverrides,
	OnCallSchedules,
	type OnCallOverrideRow,
	type OnCallScheduleRow,
} from "@maple/db/tables"
import type { MapleDb } from "@maple/db/client"
import {
	MAX_ONCALL_RENDER_RANGE_MS,
	ONCALL_LOOKAROUND_MS,
	onCallAt as resolveOnCallAt,
	renderOnCall,
	type OnCallShift,
} from "@maple/alerting-core"
import { Array as Arr, Context, DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
import * as Policy from "@maple/domain/policy"
import { lockOrgAlertRules, makePersistenceError } from "./alert-persistence"
import { AlertRuntime } from "./AlertRuntime"

type MemberLookupError = AlertMemberDirectoryNotConfiguredError | AlertMemberDirectoryUnavailableError
type ScheduleWriteError =
	| AlertForbiddenError
	| AlertValidationError
	| AlertPersistenceError
	| MemberLookupError
type ScheduleReadError = AlertPersistenceError | OnCallScheduleNotFoundError

export interface OnCallSchedulesServiceApi {
	readonly list: (orgId: OrgId) => Effect.Effect<OnCallSchedulesListResponse, AlertPersistenceError>
	readonly get: (
		orgId: OrgId,
		scheduleId: OnCallScheduleId,
	) => Effect.Effect<OnCallScheduleDocument, ScheduleReadError>
	readonly create: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		request: OnCallScheduleCreateRequest,
	) => Effect.Effect<OnCallScheduleDocument, ScheduleWriteError>
	readonly update: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		scheduleId: OnCallScheduleId,
		request: OnCallScheduleUpdateRequest,
	) => Effect.Effect<OnCallScheduleDocument, ScheduleWriteError | OnCallScheduleNotFoundError>
	/** Deletes the schedule's overrides with it. */
	readonly delete: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
		scheduleId: OnCallScheduleId,
	) => Effect.Effect<void, AlertForbiddenError | ScheduleReadError>
	/** Overrides that end after `fromMs` (default now), by start. */
	readonly listOverrides: (
		orgId: OrgId,
		scheduleId: OnCallScheduleId,
		fromMs?: number,
	) => Effect.Effect<OnCallOverridesListResponse, ScheduleReadError>
	readonly createOverride: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		scheduleId: OnCallScheduleId,
		request: OnCallOverrideCreateRequest,
	) => Effect.Effect<OnCallOverrideDocument, ScheduleWriteError | OnCallScheduleNotFoundError>
	readonly deleteOverride: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
		scheduleId: OnCallScheduleId,
		overrideId: OnCallOverrideId,
	) => Effect.Effect<void, AlertForbiddenError | ScheduleReadError | OnCallOverrideNotFoundError>
	readonly onCallAt: (
		orgId: OrgId,
		scheduleId: OnCallScheduleId,
		atMs: number,
	) => Effect.Effect<OnCallAtResponse, ScheduleReadError>
	/** Rendered over [fromMs, toMs), clamped to 90 days. */
	readonly shifts: (
		orgId: OrgId,
		scheduleId: OnCallScheduleId,
		fromMs: number,
		toMs: number,
	) => Effect.Effect<OnCallShiftsResponse, ScheduleReadError | AlertValidationError>
	/** Display names by user id; empty when the member directory cannot be read. */
	readonly memberNames: (orgId: OrgId) => Effect.Effect<ReadonlyMap<string, string>>
}

const validationError = (message: string) => new AlertValidationError({ message, details: [message] })

const decodeScheduleIdSync = Schema.decodeUnknownSync(OnCallScheduleIdSchema)
const decodeOverrideIdSync = Schema.decodeUnknownSync(OnCallOverrideIdSchema)
const decodeIsoSync = Schema.decodeUnknownSync(IsoDateTimeString)
const iso = (ms: number) => decodeIsoSync(DateTime.formatIso(DateTime.makeUnsafe(ms)))

const configOf = (row: Pick<OnCallScheduleRow, "timeZone" | "layersJson">): OnCallScheduleConfig => ({
	timeZone: row.timeZone,
	layers: row.layersJson,
})

const toOverride = (row: OnCallOverrideRow): OnCallOverride => ({
	id: row.id,
	userId: row.userId,
	startsAt: row.startsAt,
	endsAt: row.endsAt,
	createdAt: row.createdAt,
})

const toShiftDocument = (shift: OnCallShift) =>
	new OnCallShiftDocument({
		userId: shift.userId,
		startsAt: iso(shift.startMs),
		endsAt: iso(shift.endMs),
		source: shift.source,
	})

const toOverrideDocument = (row: OnCallOverrideRow) =>
	new OnCallOverrideDocument({
		id: row.id,
		scheduleId: row.scheduleId,
		userId: row.userId,
		startsAt: iso(row.startsAt),
		endsAt: iso(row.endsAt),
		createdBy: row.createdBy,
		createdAt: iso(row.createdAt),
	})

const toDocument = (row: OnCallScheduleRow, overrides: ReadonlyArray<OnCallOverrideRow>, nowMs: number) => {
	const now = resolveOnCallAt(configOf(row), Arr.map(overrides, toOverride), nowMs)
	return new OnCallScheduleDocument({
		id: row.id,
		name: row.name,
		description: row.description,
		timeZone: row.timeZone,
		layers: row.layersJson,
		onCallNow:
			now === null
				? null
				: new OnCallNow({ userId: now.userId, startsAt: iso(now.startMs), endsAt: iso(now.endMs) }),
		// No escalation chain targets a schedule yet.
		chainIds: [],
		createdAt: iso(row.createdAt),
		updatedAt: iso(row.updatedAt),
	})
}

const participantsOf = (layers: OnCallLayers): ReadonlyArray<UserId> =>
	Arr.dedupe(Arr.flatMap(layers, (layer) => layer.participants))

export class OnCallSchedulesService extends Context.Service<
	OnCallSchedulesService,
	OnCallSchedulesServiceApi
>()("@maple/backend/services/alerts/OnCallSchedulesService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const runtime = yield* AlertRuntime
		const orgMembers = yield* OrgMembersService
		const dbExecute = makeDbExecute(database, "OnCallSchedulesService", makePersistenceError)

		const requireManage = (roles: ReadonlyArray<RoleName>) =>
			Policy.check(
				roles,
				"alerts:manage",
				(denial) =>
					new AlertForbiddenError({
						message: denial.message,
						...(roles.length > 0 ? { roles: [...roles] } : undefined),
					}),
			)

		/** Every id must be a current member of the org. */
		const requireMembers = (orgId: OrgId, userIds: ReadonlyArray<UserId>) =>
			orgMembers.resolveMembers(orgId, userIds).pipe(
				Effect.catchTag("@maple/http/errors/AlertRecipientSelectionError", (error) =>
					Effect.fail(
						validationError(
							`Not members of this workspace: ${Arr.join(error.unknownUserIds, ", ")}`,
						),
					),
				),
				Effect.asVoid,
			)

		const annotate = (scheduleId: OnCallScheduleId) =>
			Effect.annotateCurrentSpan("maple.oncall.schedule_id", scheduleId)

		const findRow = (db: MapleDb, orgId: OrgId, scheduleId: OnCallScheduleId) =>
			db
				.run(
					PG.from(OnCallSchedules)
						.select()
						.where(($) => [$.orgId.eq(orgId), $.id.eq(scheduleId)])
						.limit(1),
				)
				.pipe(
					Effect.flatMap((rows) =>
						Arr.match(rows, {
							onEmpty: () =>
								Effect.fail(
									new OnCallScheduleNotFoundError({
										message: "On-call schedule not found",
										scheduleId,
									}),
								),
							onNonEmpty: ([row]) => Effect.succeed(row),
						}),
					),
				)

		/** Overrides of the org (or one schedule) that overlap [fromMs, toMs); null `toMs` is open-ended. */
		const overlappingOverrides = (
			db: MapleDb,
			orgId: OrgId,
			fromMs: number,
			toMs: number | null,
			scheduleId?: OnCallScheduleId,
		) =>
			db.run(
				PG.from(OnCallOverrides)
					.select()
					.where(($) => [
						$.orgId.eq(orgId),
						...(scheduleId === undefined ? [] : [$.scheduleId.eq(scheduleId)]),
						$.endsAt.gt(fromMs),
						...(toMs === null ? [] : [$.startsAt.lt(toMs)]),
					])
					.orderBy(["startsAt", "asc"])
					.limit(MAX_ONCALL_FUTURE_OVERRIDES * 2),
			)

		const nowWindow = (nowMs: number) =>
			[nowMs - ONCALL_LOOKAROUND_MS, nowMs + ONCALL_LOOKAROUND_MS] as const

		const list = Effect.fn("OnCallSchedulesService.list")(function* (orgId: OrgId) {
			const nowMs = yield* runtime.now
			const [from, to] = nowWindow(nowMs)
			const [rows, overrides] = yield* dbExecute((db) =>
				Effect.all([
					db.run(
						PG.from(OnCallSchedules)
							.select()
							.where(($) => [$.orgId.eq(orgId)])
							.orderBy(["name", "asc"])
							.limit(MAX_ONCALL_SCHEDULES_PER_ORG),
					),
					overlappingOverrides(db, orgId, from, to),
				]),
			)
			yield* Effect.annotateCurrentSpan("result.rowCount", rows.length)
			return new OnCallSchedulesListResponse({
				schedules: Arr.map(rows, (row) =>
					toDocument(
						row,
						Arr.filter(overrides, (o) => o.scheduleId === row.id),
						nowMs,
					),
				),
			})
		})

		const loadDocument = (db: MapleDb, orgId: OrgId, scheduleId: OnCallScheduleId, nowMs: number) => {
			const [from, to] = nowWindow(nowMs)
			return Effect.all([
				findRow(db, orgId, scheduleId),
				overlappingOverrides(db, orgId, from, to, scheduleId),
			]).pipe(Effect.map(([row, overrides]) => toDocument(row, overrides, nowMs)))
		}

		const get = Effect.fn("OnCallSchedulesService.get")(function* (
			orgId: OrgId,
			scheduleId: OnCallScheduleId,
		) {
			yield* annotate(scheduleId)
			const nowMs = yield* runtime.now
			return yield* dbExecute((db) => loadDocument(db, orgId, scheduleId, nowMs))
		})

		const create = Effect.fn("OnCallSchedulesService.create")(function* (
			orgId: OrgId,
			userId: UserId,
			roles: ReadonlyArray<RoleName>,
			request: OnCallScheduleCreateRequest,
		) {
			yield* requireManage(roles)
			yield* requireMembers(orgId, participantsOf(request.layers))
			const nowMs = yield* runtime.now
			const id = decodeScheduleIdSync(runtime.makeUuid())
			yield* annotate(id)
			const row = yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						yield* lockOrgAlertRules(db, orgId)
						const existing = yield* db.run(
							PG.from(OnCallSchedules)
								.select("id")
								.where(($) => [$.orgId.eq(orgId)])
								.limit(MAX_ONCALL_SCHEDULES_PER_ORG),
						)
						if (existing.length >= MAX_ONCALL_SCHEDULES_PER_ORG) {
							return yield* validationError(
								`Organizations may have at most ${MAX_ONCALL_SCHEDULES_PER_ORG} on-call schedules`,
							)
						}
						const [inserted] = yield* db.run(
							PG.insertInto(OnCallSchedules)
								.values({
									id,
									orgId,
									name: request.name,
									description: request.description ?? null,
									timeZone: request.timeZone,
									layersJson: request.layers,
									createdAt: nowMs,
									updatedAt: nowMs,
									createdBy: userId,
									updatedBy: userId,
								})
								.returning(),
						)
						return inserted
					}),
				),
			)
			if (row === undefined) {
				return yield* new AlertPersistenceError({ message: "On-call schedule was not created" })
			}
			return toDocument(row, [], nowMs)
		})

		const update = Effect.fn("OnCallSchedulesService.update")(function* (
			orgId: OrgId,
			userId: UserId,
			roles: ReadonlyArray<RoleName>,
			scheduleId: OnCallScheduleId,
			request: OnCallScheduleUpdateRequest,
		) {
			yield* annotate(scheduleId)
			yield* requireManage(roles)
			if (request.layers !== undefined) yield* requireMembers(orgId, participantsOf(request.layers))
			const nowMs = yield* runtime.now
			return yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						yield* findRow(db, orgId, scheduleId)
						yield* db.run(
							PG.update(OnCallSchedules)
								.set({
									...(request.name === undefined ? undefined : { name: request.name }),
									...(request.description === undefined
										? undefined
										: { description: request.description }),
									...(request.timeZone === undefined
										? undefined
										: { timeZone: request.timeZone }),
									...(request.layers === undefined
										? undefined
										: { layersJson: request.layers }),
									updatedAt: nowMs,
									updatedBy: userId,
								})
								.where(($) => [$.orgId.eq(orgId), $.id.eq(scheduleId)]),
						)
						return yield* loadDocument(db, orgId, scheduleId, nowMs)
					}),
				),
			)
		})

		const remove = Effect.fn("OnCallSchedulesService.delete")(function* (
			orgId: OrgId,
			roles: ReadonlyArray<RoleName>,
			scheduleId: OnCallScheduleId,
		) {
			yield* annotate(scheduleId)
			yield* requireManage(roles)
			yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						yield* findRow(db, orgId, scheduleId)
						// Overrides go with it through the foreign key's cascade.
						yield* db.run(
							PG.deleteFrom(OnCallSchedules).where(($) => [
								$.orgId.eq(orgId),
								$.id.eq(scheduleId),
							]),
						)
					}),
				),
			)
		})

		const listOverrides = Effect.fn("OnCallSchedulesService.listOverrides")(function* (
			orgId: OrgId,
			scheduleId: OnCallScheduleId,
			fromMs?: number,
		) {
			yield* annotate(scheduleId)
			const from = fromMs ?? (yield* runtime.now)
			const rows = yield* dbExecute((db) =>
				Effect.gen(function* () {
					yield* findRow(db, orgId, scheduleId)
					return yield* overlappingOverrides(db, orgId, from, null, scheduleId)
				}),
			)
			return new OnCallOverridesListResponse({ overrides: Arr.map(rows, toOverrideDocument) })
		})

		const createOverride = Effect.fn("OnCallSchedulesService.createOverride")(function* (
			orgId: OrgId,
			userId: UserId,
			roles: ReadonlyArray<RoleName>,
			scheduleId: OnCallScheduleId,
			request: OnCallOverrideCreateRequest,
		) {
			yield* annotate(scheduleId)
			yield* requireManage(roles)
			const nowMs = yield* runtime.now
			if (request.endsAt <= request.startsAt) {
				return yield* validationError("An override must end after it starts")
			}
			if (request.endsAt - request.startsAt > MAX_ONCALL_OVERRIDE_MS) {
				return yield* validationError("An override may last at most 90 days")
			}
			if (request.endsAt <= nowMs) {
				return yield* validationError("An override must not end in the past")
			}
			yield* requireMembers(orgId, [request.userId])
			const id = decodeOverrideIdSync(runtime.makeUuid())
			const row = yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						yield* lockOrgAlertRules(db, orgId)
						yield* findRow(db, orgId, scheduleId)
						const future = yield* db.run(
							PG.from(OnCallOverrides)
								.select("id")
								.where(($) => [
									$.orgId.eq(orgId),
									$.scheduleId.eq(scheduleId),
									$.endsAt.gt(nowMs),
								])
								.limit(MAX_ONCALL_FUTURE_OVERRIDES),
						)
						if (future.length >= MAX_ONCALL_FUTURE_OVERRIDES) {
							return yield* validationError(
								`A schedule may have at most ${MAX_ONCALL_FUTURE_OVERRIDES} upcoming overrides`,
							)
						}
						const [inserted] = yield* db.run(
							PG.insertInto(OnCallOverrides)
								.values({
									id,
									orgId,
									scheduleId,
									userId: request.userId,
									startsAt: request.startsAt,
									endsAt: request.endsAt,
									createdBy: userId,
									createdAt: nowMs,
								})
								.returning(),
						)
						return inserted
					}),
				),
			)
			if (row === undefined) {
				return yield* new AlertPersistenceError({ message: "On-call override was not created" })
			}
			return toOverrideDocument(row)
		})

		const deleteOverride = Effect.fn("OnCallSchedulesService.deleteOverride")(function* (
			orgId: OrgId,
			roles: ReadonlyArray<RoleName>,
			scheduleId: OnCallScheduleId,
			overrideId: OnCallOverrideId,
		) {
			yield* annotate(scheduleId)
			yield* requireManage(roles)
			yield* dbExecute((db) =>
				Effect.gen(function* () {
					yield* findRow(db, orgId, scheduleId)
					const deleted = yield* db.run(
						PG.deleteFrom(OnCallOverrides)
							.where(($) => [
								$.orgId.eq(orgId),
								$.scheduleId.eq(scheduleId),
								$.id.eq(overrideId),
							])
							.returning("id"),
					)
					if (deleted.length === 0) {
						return yield* new OnCallOverrideNotFoundError({
							message: "On-call override not found",
							overrideId,
						})
					}
				}),
			)
		})

		const onCallAt = Effect.fn("OnCallSchedulesService.onCallAt")(function* (
			orgId: OrgId,
			scheduleId: OnCallScheduleId,
			atMs: number,
		) {
			yield* annotate(scheduleId)
			const [from, to] = nowWindow(atMs)
			const [row, overrides] = yield* dbExecute((db) =>
				Effect.all([
					findRow(db, orgId, scheduleId),
					overlappingOverrides(db, orgId, from, to, scheduleId),
				]),
			)
			const shift = resolveOnCallAt(configOf(row), Arr.map(overrides, toOverride), atMs)
			return new OnCallAtResponse({
				at: iso(atMs),
				shift: shift === null ? null : toShiftDocument(shift),
			})
		})

		const shifts = Effect.fn("OnCallSchedulesService.shifts")(function* (
			orgId: OrgId,
			scheduleId: OnCallScheduleId,
			fromMs: number,
			toMs: number,
		) {
			yield* annotate(scheduleId)
			if (toMs <= fromMs) return yield* validationError("The range must end after it starts")
			const endMs = Math.min(toMs, fromMs + MAX_ONCALL_RENDER_RANGE_MS)
			const [row, overrides] = yield* dbExecute((db) =>
				Effect.all([
					findRow(db, orgId, scheduleId),
					overlappingOverrides(db, orgId, fromMs, endMs, scheduleId),
				]),
			)
			const render = renderOnCall(configOf(row), Arr.map(overrides, toOverride), fromMs, endMs)
			return new OnCallShiftsResponse({
				from: iso(fromMs),
				to: iso(endMs),
				layers: Arr.map(render.layers, (layer) => Arr.map(layer, toShiftDocument)),
				final: Arr.map(render.final, toShiftDocument),
			})
		})

		const memberNames = Effect.fn("OnCallSchedulesService.memberNames")(function* (orgId: OrgId) {
			const members = yield* orgMembers.listMembers(orgId).pipe(Effect.orElseSucceed(() => []))
			return new Map(Arr.map(members, (m) => [m.userId, m.name ?? m.email] as const))
		})

		return {
			memberNames,
			list,
			get,
			create,
			update,
			delete: remove,
			listOverrides,
			createOverride,
			deleteOverride,
			onCallAt,
			shifts,
		} satisfies OnCallSchedulesServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(OrgMembersService.layer))
}
