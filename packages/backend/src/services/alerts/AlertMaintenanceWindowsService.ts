import {
	AlertForbiddenError,
	AlertMaintenanceWindowId as AlertMaintenanceWindowIdSchema,
	AlertMaintenanceWindowNotFoundError,
	AlertMaintenanceWindowsListResponse,
	AlertPersistenceError,
	AlertValidationError,
	toStoredMaintenanceSchedule,
	type AlertMaintenanceWindowCreateRequest,
	type AlertMaintenanceWindowDocument,
	type AlertMaintenanceWindowId,
	type AlertMaintenanceWindowUpdateRequest,
	type AlertSilenceMatchers,
	type OrgId,
	type RoleName,
	type StoredAlertMaintenanceSchedule,
	type UserId,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AlertMaintenanceWindows, AlertRules, type AlertMaintenanceWindowRow } from "@maple/db/tables"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import * as Policy from "@maple/domain/policy"
import { lockOrgMaintenanceWindows, makePersistenceError } from "./alert-persistence"
import { AlertRuntime } from "./AlertRuntime"
import { retireSilences, syncWindow } from "./alert-maintenance-window-sync"
import {
	decodeMaintenanceWindow,
	maintenanceWindowToDocument,
	selectMaintenanceWindows,
	type DecodedMaintenanceWindow,
	type StoredMaintenanceWindowRow,
} from "./alert-maintenance-window-store"

/** Windows an org may hold at once; one-off windows that have ended do not count. */
const MAX_WINDOWS_PER_ORG = 100
/** Windows one keyset page of the materialize pass reads. */
const MATERIALIZE_PAGE = 500
const MATERIALIZE_CONCURRENCY = 4
/** The pass stops paging after this long, inside the 15-minute lane's 10-minute deadline. */
const MATERIALIZE_BUDGET_MS = 8 * 60_000

const onceEndsAtOf = (schedule: StoredAlertMaintenanceSchedule): number | null =>
	schedule._tag === "once" ? schedule.endsAt : null

const decodeWindowIdSync = Schema.decodeUnknownSync(AlertMaintenanceWindowIdSchema)

export interface MaterializeResult {
	readonly windows: number
	readonly silencesUpserted: number
	readonly failures: number
	/** Keyset pages read; the pass stopped early when `budgetExhausted`. */
	readonly pages: number
	readonly budgetExhausted: boolean
}

export interface AlertMaintenanceWindowsServiceApi {
	readonly list: (
		orgId: OrgId,
		options?: { readonly limit?: number; readonly offset?: number },
	) => Effect.Effect<AlertMaintenanceWindowsListResponse, AlertPersistenceError>
	readonly get: (
		orgId: OrgId,
		windowId: AlertMaintenanceWindowId,
	) => Effect.Effect<
		AlertMaintenanceWindowDocument,
		AlertPersistenceError | AlertMaintenanceWindowNotFoundError
	>
	readonly create: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		request: AlertMaintenanceWindowCreateRequest,
	) => Effect.Effect<
		AlertMaintenanceWindowDocument,
		AlertForbiddenError | AlertValidationError | AlertPersistenceError
	>
	readonly update: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		windowId: AlertMaintenanceWindowId,
		request: AlertMaintenanceWindowUpdateRequest,
	) => Effect.Effect<
		AlertMaintenanceWindowDocument,
		| AlertForbiddenError
		| AlertValidationError
		| AlertPersistenceError
		| AlertMaintenanceWindowNotFoundError
	>
	/** Deletes the window, ends an occurrence in progress now and drops the ones still ahead. */
	readonly delete: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		windowId: AlertMaintenanceWindowId,
	) => Effect.Effect<
		AlertMaintenanceWindowDocument,
		AlertForbiddenError | AlertPersistenceError | AlertMaintenanceWindowNotFoundError
	>
	/** Writes every enabled window's occurrences in [now, now + 48h) as silences, across all orgs. */
	readonly materialize: (
		nowMs: number,
		options?: { readonly pageSize?: number },
	) => Effect.Effect<MaterializeResult, AlertPersistenceError>
}

const validationError = (message: string) => new AlertValidationError({ message, details: [message] })

export class AlertMaintenanceWindowsService extends Context.Service<
	AlertMaintenanceWindowsService,
	AlertMaintenanceWindowsServiceApi
>()("@maple/backend/services/alerts/AlertMaintenanceWindowsService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const runtime = yield* AlertRuntime
		const dbExecute = makeDbExecute(database, "AlertMaintenanceWindowsService", makePersistenceError)

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

		const decodeRow = (row: StoredMaintenanceWindowRow) =>
			Effect.fromOption(decodeMaintenanceWindow(row)).pipe(
				Effect.mapError(
					() => new AlertPersistenceError({ message: "Stored maintenance window is invalid" }),
				),
			)

		const toDocument = (window: DecodedMaintenanceWindow, nowMs: number) =>
			Effect.fromOption(maintenanceWindowToDocument(window, nowMs)).pipe(
				Effect.mapError(
					() => new AlertPersistenceError({ message: "Stored maintenance window is invalid" }),
				),
			)

		const findRow = Effect.fn("AlertMaintenanceWindowsService.findRow")(function* (
			orgId: OrgId,
			windowId: AlertMaintenanceWindowId,
		) {
			const rows = yield* dbExecute((db) =>
				db.run(
					selectMaintenanceWindows()
						.where(($) => [$.orgId.eq(orgId), $.id.eq(windowId)])
						.limit(1),
				),
			)
			const row = rows[0]
			if (row === undefined) {
				return yield* new AlertMaintenanceWindowNotFoundError({
					message: "Maintenance window not found",
					maintenanceWindowId: windowId,
				})
			}
			return yield* decodeRow(row)
		})

		/** Every rule id must belong to the org, so a typo cannot silence nothing while looking fine. */
		const requireRuleIds = Effect.fn("AlertMaintenanceWindowsService.requireRuleIds")(function* (
			orgId: OrgId,
			matchers: AlertSilenceMatchers,
		) {
			const ruleIds = Arr.dedupe(matchers.ruleIds ?? [])
			if (ruleIds.length === 0) return
			const found = yield* dbExecute((db) =>
				db.run(
					PG.from(AlertRules)
						.select("id")
						.where(($) => [$.orgId.eq(orgId), $.id.in_(...ruleIds)]),
				),
			)
			const known = new Set(Arr.map(found, (row) => row.id))
			const missing = Arr.filter(ruleIds, (id) => !known.has(id))
			if (missing.length > 0) {
				return yield* new AlertValidationError({
					message: "Unknown alert rule in maintenance window matchers",
					details: Arr.map(missing, (id) => `Alert rule ${id} does not exist`),
				})
			}
		})

		const validateSchedule = (schedule: StoredAlertMaintenanceSchedule, nowMs: number) =>
			schedule._tag === "once" && schedule.endsAt <= nowMs
				? Effect.fail(validationError("A one-off maintenance window must end in the future"))
				: Effect.void

		/** `syncWindow` in a transaction of its own, with span attributes. */
		const materializeWindow = Effect.fn("AlertMaintenanceWindowsService.materializeWindow")(function* (
			window: DecodedMaintenanceWindow,
			nowMs: number,
		) {
			const upserted = yield* dbExecute((db) =>
				db.transaction(syncWindow(db, runtime.makeUuid, window, nowMs, false)),
			)
			yield* Effect.annotateCurrentSpan({
				"maple.maintenance_window.id": window.row.id,
				"maple.maintenance_window.silences_upserted": upserted,
			})
			return upserted
		})

		const list = Effect.fn("AlertMaintenanceWindowsService.list")(function* (
			orgId: OrgId,
			options: { readonly limit?: number; readonly offset?: number } = {},
		) {
			const nowMs = yield* runtime.now
			const rows = yield* dbExecute((db) =>
				db.run(
					selectMaintenanceWindows()
						.where(($) => [$.orgId.eq(orgId)])
						.orderBy(["createdAt", "desc"], ["id", "asc"])
						.limit(options.limit ?? MAX_WINDOWS_PER_ORG)
						.offset(options.offset ?? 0),
				),
			)
			const windows = yield* Effect.forEach(rows, (row) =>
				decodeRow(row).pipe(Effect.flatMap((window) => toDocument(window, nowMs))),
			)
			return new AlertMaintenanceWindowsListResponse({ windows })
		})

		const get = Effect.fn("AlertMaintenanceWindowsService.get")(function* (
			orgId: OrgId,
			windowId: AlertMaintenanceWindowId,
		) {
			const window = yield* findRow(orgId, windowId)
			const nowMs = yield* runtime.now
			return yield* toDocument(window, nowMs)
		})

		const create = Effect.fn("AlertMaintenanceWindowsService.create")(function* (
			orgId: OrgId,
			userId: UserId,
			roles: ReadonlyArray<RoleName>,
			request: AlertMaintenanceWindowCreateRequest,
		) {
			yield* requireManage(roles)
			const nowMs = yield* runtime.now
			const schedule = toStoredMaintenanceSchedule(request.schedule)
			yield* validateSchedule(schedule, nowMs)
			yield* requireRuleIds(orgId, request.matchers)

			const row: AlertMaintenanceWindowRow = {
				id: decodeWindowIdSync(runtime.makeUuid()),
				orgId,
				name: request.name,
				reason: request.reason ?? null,
				matchersJson: request.matchers,
				scheduleJson: schedule,
				excludeFromBaselines: request.excludeFromBaselines ?? true,
				enabled: request.enabled ?? true,
				onceEndsAt: onceEndsAtOf(schedule),
				revision: 1,
				createdAt: nowMs,
				updatedAt: nowMs,
				createdBy: userId,
				updatedBy: userId,
			}
			const window: DecodedMaintenanceWindow = { row, matchers: request.matchers, schedule }
			// The cap is counted under the org lock, so concurrent creates cannot both pass it.
			// Occurrences are written right away, so one starting before the next pass is not missed.
			yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						yield* lockOrgMaintenanceWindows(db, orgId)
						const existing = yield* db.run(
							PG.from(AlertMaintenanceWindows)
								.select("id")
								.where(($) => [
									$.orgId.eq(orgId),
									PG.or($.onceEndsAt.isNull(), $.onceEndsAt.gt(nowMs)),
								])
								.limit(MAX_WINDOWS_PER_ORG),
						)
						if (existing.length >= MAX_WINDOWS_PER_ORG)
							return yield* validationError(
								`An organization can have at most ${MAX_WINDOWS_PER_ORG} maintenance windows`,
							)
						yield* db.run(PG.insertInto(AlertMaintenanceWindows).values(row))
						if (row.enabled) yield* syncWindow(db, runtime.makeUuid, window, nowMs, false)
					}),
				),
			)
			yield* Effect.annotateCurrentSpan({ "maple.maintenance_window.id": row.id })
			return yield* toDocument(window, nowMs)
		})

		const update = Effect.fn("AlertMaintenanceWindowsService.update")(function* (
			orgId: OrgId,
			userId: UserId,
			roles: ReadonlyArray<RoleName>,
			windowId: AlertMaintenanceWindowId,
			request: AlertMaintenanceWindowUpdateRequest,
		) {
			yield* requireManage(roles)
			const nowMs = yield* runtime.now
			const current = yield* findRow(orgId, windowId)
			const schedule =
				request.schedule === undefined
					? current.schedule
					: toStoredMaintenanceSchedule(request.schedule)
			// Re-enabling a one-off window that already ended would turn on something that never fires.
			const enabling = request.enabled === true && !current.row.enabled
			if (request.schedule !== undefined || enabling) yield* validateSchedule(schedule, nowMs)
			if (request.matchers !== undefined) yield* requireRuleIds(orgId, request.matchers)

			const next: DecodedMaintenanceWindow = {
				row: {
					...current.row,
					name: request.name ?? current.row.name,
					reason: request.reason === undefined ? current.row.reason : request.reason,
					excludeFromBaselines: request.excludeFromBaselines ?? current.row.excludeFromBaselines,
					enabled: request.enabled ?? current.row.enabled,
					matchersJson: request.matchers ?? current.matchers,
					scheduleJson: schedule,
					onceEndsAt: onceEndsAtOf(schedule),
					updatedAt: nowMs,
					updatedBy: userId,
				},
				matchers: request.matchers ?? current.matchers,
				schedule,
			}
			yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						// The bumped revision voids any materialize pass that read the row before this edit.
						const written = yield* db.run(
							PG.update(AlertMaintenanceWindows)
								.set(($) => ({
									name: next.row.name,
									reason: next.row.reason,
									matchersJson: next.matchers,
									scheduleJson: next.schedule,
									excludeFromBaselines: next.row.excludeFromBaselines,
									enabled: next.row.enabled,
									onceEndsAt: next.row.onceEndsAt,
									revision: $.revision.add(1),
									updatedAt: nowMs,
									updatedBy: userId,
								}))
								.where(($) => [$.orgId.eq(orgId), $.id.eq(windowId)])
								.returning("revision"),
						)
						const revision = written[0]?.revision
						if (revision === undefined) return
						if (next.row.enabled)
							yield* syncWindow(
								db,
								runtime.makeUuid,
								{ ...next, row: { ...next.row, revision } },
								nowMs,
								true,
							)
						else yield* retireSilences(db, orgId, windowId, nowMs, userId)
					}),
				),
			)
			return yield* toDocument(next, nowMs)
		})

		const remove = Effect.fn("AlertMaintenanceWindowsService.delete")(function* (
			orgId: OrgId,
			userId: UserId,
			roles: ReadonlyArray<RoleName>,
			windowId: AlertMaintenanceWindowId,
		) {
			yield* requireManage(roles)
			const nowMs = yield* runtime.now
			const current = yield* findRow(orgId, windowId)
			yield* dbExecute((db) =>
				db.transaction(
					retireSilences(db, orgId, windowId, nowMs, userId).pipe(
						Effect.andThen(
							db.run(
								PG.deleteFrom(AlertMaintenanceWindows).where(($) => [
									$.orgId.eq(orgId),
									$.id.eq(windowId),
								]),
							),
						),
					),
				),
			)
			return yield* toDocument({ ...current, row: { ...current.row, enabled: false } }, nowMs)
		})

		const materializeOne = (row: StoredMaintenanceWindowRow, nowMs: number) =>
			Option.match(decodeMaintenanceWindow(row), {
				onNone: () =>
					Effect.logWarning("Skipping an unreadable maintenance window").pipe(
						Effect.annotateLogs({ "maple.maintenance_window.id": row.id }),
						Effect.as({ upserted: 0, failed: 1 }),
					),
				onSome: (window) =>
					materializeWindow(window, nowMs).pipe(
						Effect.map((upserted) => ({ upserted, failed: 0 })),
						// One window failing must not hold back every other org's.
						Effect.catch((error) =>
							Effect.logError("Maintenance window materialize failed").pipe(
								Effect.annotateLogs({
									"maple.maintenance_window.id": row.id,
									"error.message": error.message,
								}),
								Effect.as({ upserted: 0, failed: 1 }),
							),
						),
					),
			})

		const emptyResult: MaterializeResult = {
			windows: 0,
			silencesUpserted: 0,
			failures: 0,
			pages: 0,
			budgetExhausted: false,
		}

		/** One keyset page and the pages after it, until the windows or the time budget run out. */
		const materializeFrom = (
			cursor: AlertMaintenanceWindowId | null,
			nowMs: number,
			pageSize: number,
			deadlineMs: number,
			sofar: MaterializeResult,
		): Effect.Effect<MaterializeResult, AlertPersistenceError> =>
			Effect.gen(function* () {
				if ((yield* Clock.currentTimeMillis) >= deadlineMs) return { ...sofar, budgetExhausted: true }
				// Deliberate cross-org system scan: the pass writes every org's occurrences.
				const rows = yield* dbExecute((db) =>
					db.run(
						selectMaintenanceWindows()
							.where(($) => [
								$.enabled.eq(true),
								// A one-off window that has ended has nothing left to write.
								PG.or($.onceEndsAt.isNull(), $.onceEndsAt.gt(nowMs)),
								...(cursor === null ? [] : [$.id.gt(cursor)]),
							])
							.orderBy(["id", "asc"])
							.limit(pageSize),
					),
				)
				const results = yield* Effect.forEach(rows, (row) => materializeOne(row, nowMs), {
					concurrency: MATERIALIZE_CONCURRENCY,
				})
				const next: MaterializeResult = {
					windows: sofar.windows + rows.length,
					silencesUpserted: Arr.reduce(
						results,
						sofar.silencesUpserted,
						(sum, r) => sum + r.upserted,
					),
					failures: Arr.reduce(results, sofar.failures, (sum, r) => sum + r.failed),
					pages: sofar.pages + 1,
					budgetExhausted: false,
				}
				const last = Arr.last(rows)
				return rows.length < pageSize || Option.isNone(last)
					? next
					: yield* materializeFrom(last.value.id, nowMs, pageSize, deadlineMs, next)
			})

		const materialize = Effect.fn("AlertMaintenanceWindowsService.materialize")(function* (
			nowMs: number,
			options: { readonly pageSize?: number } = {},
		) {
			const startedAt = yield* Clock.currentTimeMillis
			const result = yield* materializeFrom(
				null,
				nowMs,
				options.pageSize ?? MATERIALIZE_PAGE,
				startedAt + MATERIALIZE_BUDGET_MS,
				emptyResult,
			)
			if (result.budgetExhausted)
				yield* Effect.logWarning(
					"Maintenance window pass ran out of time; the rest waits for the next",
				).pipe(Effect.annotateLogs({ "maple.maintenance_window.window_count": result.windows }))
			yield* Effect.annotateCurrentSpan({
				"maple.maintenance_window.window_count": result.windows,
				"maple.maintenance_window.silences_upserted": result.silencesUpserted,
				"maple.maintenance_window.failures": result.failures,
				"maple.maintenance_window.pages": result.pages,
				"maple.maintenance_window.budget_exhausted": result.budgetExhausted,
			})
			return result
		})

		return {
			list,
			get,
			create,
			update,
			delete: remove,
			materialize,
		} satisfies AlertMaintenanceWindowsServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
