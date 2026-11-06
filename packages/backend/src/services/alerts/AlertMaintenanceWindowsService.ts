import {
	AlertForbiddenError,
	AlertMaintenanceWindowId as AlertMaintenanceWindowIdSchema,
	AlertMaintenanceWindowNotFoundError,
	AlertMaintenanceWindowsListResponse,
	AlertPersistenceError,
	AlertSilenceId as AlertSilenceIdSchema,
	AlertValidationError,
	MAINTENANCE_MATERIALIZE_HORIZON_MS,
	maintenanceOccurrences,
	maintenanceSilenceReason,
	toStoredMaintenanceSchedule,
	type AlertMaintenanceWindowCreateRequest,
	type AlertMaintenanceWindowDocument,
	type AlertMaintenanceWindowId,
	type AlertMaintenanceWindowUpdateRequest,
	type AlertSilenceId,
	type AlertSilenceMatchers,
	type MaintenanceOccurrence,
	type OrgId,
	type RoleName,
	type StoredAlertMaintenanceSchedule,
	type UserId,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	AlertMaintenanceWindows,
	AlertRules,
	AlertSilences,
	type AlertMaintenanceWindowRow,
} from "@maple/db/tables"
import { Array as Arr, Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import * as Policy from "@maple/domain/policy"
import { makePersistenceError } from "./alert-persistence"
import { AlertRuntime } from "./AlertRuntime"
import {
	decodeMaintenanceWindow,
	maintenanceWindowToDocument,
	selectMaintenanceWindows,
	type DecodedMaintenanceWindow,
	type StoredMaintenanceWindowRow,
} from "./alert-maintenance-window-store"

/** Windows an org may hold at once. */
const MAX_WINDOWS_PER_ORG = 100
/** Windows one materialize pass reads; more are logged and wait for a later pass. */
const MATERIALIZE_BATCH = 2_000
const MATERIALIZE_CONCURRENCY = 4

const decodeWindowIdSync = Schema.decodeUnknownSync(AlertMaintenanceWindowIdSchema)
const decodeSilenceIdSync = Schema.decodeUnknownSync(AlertSilenceIdSchema)

export interface MaterializeResult {
	readonly windows: number
	readonly silencesUpserted: number
	readonly failures: number
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
	readonly materialize: (nowMs: number) => Effect.Effect<MaterializeResult, AlertPersistenceError>
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

		const silenceFields = (window: DecodedMaintenanceWindow, nowMs: number) => ({
			reason: maintenanceSilenceReason(window.row.name, window.row.reason),
			matchersJson: window.matchers,
			updatedAt: nowMs,
			updatedBy: window.row.updatedBy,
		})

		/** Ends a running occurrence now (its owed page then goes out) and drops the ones ahead. */
		const retireSilences = Effect.fn("AlertMaintenanceWindowsService.retireSilences")(function* (
			orgId: OrgId,
			windowId: AlertMaintenanceWindowId,
			nowMs: number,
			updatedBy: string,
		) {
			yield* dropFutureSilences(orgId, windowId, nowMs)
			yield* dbExecute((db) =>
				db.run(
					PG.update(AlertSilences)
						.set({ endsAt: nowMs, updatedAt: nowMs, updatedBy })
						.where(($) => [
							$.orgId.eq(orgId),
							$.maintenanceWindowId.eq(windowId),
							$.startsAt.lte(nowMs),
							$.endsAt.gt(nowMs),
						]),
				),
			)
		})

		const dropFutureSilences = (orgId: OrgId, windowId: AlertMaintenanceWindowId, nowMs: number) =>
			dbExecute((db) =>
				db.run(
					PG.deleteFrom(AlertSilences).where(($) => [
						$.orgId.eq(orgId),
						$.maintenanceWindowId.eq(windowId),
						$.startsAt.gt(nowMs),
					]),
				),
			)

		const upsertOccurrence = (
			window: DecodedMaintenanceWindow,
			occurrence: MaintenanceOccurrence,
			nowMs: number,
		) => {
			const fields = silenceFields(window, nowMs)
			const insert = PG.insertInto(AlertSilences).values({
				id: decodeSilenceIdSync(runtime.makeUuid()),
				orgId: window.row.orgId,
				maintenanceWindowId: window.row.id,
				startsAt: occurrence.startsAtMs,
				endsAt: occurrence.endsAtMs,
				createdAt: nowMs,
				createdBy: window.row.updatedBy,
				...fields,
			})
			// A started occurrence is never rewritten here; one ahead takes the window's current shape.
			return dbExecute((db) =>
				db.run(
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
				),
			)
		}

		/**
		 * Writes the window's occurrences in [now, now + 48h). An occurrence already running
		 * keeps its row; `refresh` (after an edit) gives it the window's new matchers and end.
		 */
		const materializeWindow = Effect.fn("AlertMaintenanceWindowsService.materializeWindow")(function* (
			window: DecodedMaintenanceWindow,
			nowMs: number,
			refresh: boolean,
		) {
			const { orgId, id } = window.row
			const occurrences = maintenanceOccurrences(
				window.schedule,
				nowMs,
				nowMs + MAINTENANCE_MATERIALIZE_HORIZON_MS,
			)
			const running = yield* dbExecute((db) =>
				db.run(
					PG.from(AlertSilences)
						.select("id", "startsAt", "endsAt")
						.where(($) => [
							$.orgId.eq(orgId),
							$.maintenanceWindowId.eq(id),
							$.startsAt.lte(nowMs),
							$.endsAt.gt(nowMs),
						]),
				),
			)
			if (refresh && running.length > 0) {
				yield* dbExecute((db) =>
					db.run(
						PG.update(AlertSilences)
							.set(silenceFields(window, nowMs))
							.where(($) => [
								$.orgId.eq(orgId),
								$.id.in_(...Arr.map(running, (row) => row.id)),
							]),
					),
				)
			}
			const current = Arr.head(running)
			// The running row takes its occurrence's end, so an edit that moves the end applies now.
			const syncRunning = (
				row: { readonly id: AlertSilenceId; readonly endsAt: number },
				endsAtMs: number,
			) =>
				row.endsAt === endsAtMs
					? Effect.succeed(0)
					: dbExecute((db) =>
							db.run(
								PG.update(AlertSilences)
									.set({ endsAt: endsAtMs, updatedAt: nowMs })
									.where(($) => [$.orgId.eq(orgId), $.id.eq(row.id)]),
							),
						).pipe(Effect.as(1))
			const writes = yield* Effect.forEach(occurrences, (occurrence) =>
				occurrence.startsAtMs <= nowMs && Option.isSome(current)
					? syncRunning(current.value, occurrence.endsAtMs)
					: upsertOccurrence(window, occurrence, nowMs).pipe(Effect.as(1)),
			)
			const upserted = Arr.reduce(writes, 0, (sum, count) => sum + count)
			yield* Effect.annotateCurrentSpan({
				"maple.maintenance_window.id": id,
				"maple.maintenance_window.occurrences": occurrences.length,
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

			const existing = yield* dbExecute((db) =>
				db.run(
					PG.from(AlertMaintenanceWindows)
						.select("id")
						.where(($) => [$.orgId.eq(orgId)])
						.limit(MAX_WINDOWS_PER_ORG),
				),
			)
			if (existing.length >= MAX_WINDOWS_PER_ORG)
				return yield* validationError(
					`An organization can have at most ${MAX_WINDOWS_PER_ORG} maintenance windows`,
				)

			const row: AlertMaintenanceWindowRow = {
				id: decodeWindowIdSync(runtime.makeUuid()),
				orgId,
				name: request.name,
				reason: request.reason ?? null,
				matchersJson: request.matchers,
				scheduleJson: schedule,
				excludeFromBaselines: request.excludeFromBaselines ?? true,
				enabled: request.enabled ?? true,
				createdAt: nowMs,
				updatedAt: nowMs,
				createdBy: userId,
				updatedBy: userId,
			}
			yield* dbExecute((db) => db.run(PG.insertInto(AlertMaintenanceWindows).values(row)))
			yield* Effect.annotateCurrentSpan({ "maple.maintenance_window.id": row.id })
			const window: DecodedMaintenanceWindow = { row, matchers: request.matchers, schedule }
			// Right away, so an occurrence starting before the next cron pass is not missed.
			if (row.enabled) yield* materializeWindow(window, nowMs, false)
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
			if (request.schedule !== undefined) yield* validateSchedule(schedule, nowMs)
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
					updatedAt: nowMs,
					updatedBy: userId,
				},
				matchers: request.matchers ?? current.matchers,
				schedule,
			}
			yield* dbExecute((db) =>
				db.run(
					PG.update(AlertMaintenanceWindows)
						.set({
							name: next.row.name,
							reason: next.row.reason,
							matchersJson: next.matchers,
							scheduleJson: next.schedule,
							excludeFromBaselines: next.row.excludeFromBaselines,
							enabled: next.row.enabled,
							updatedAt: nowMs,
							updatedBy: userId,
						})
						.where(($) => [$.orgId.eq(orgId), $.id.eq(windowId)]),
				),
			)
			if (next.row.enabled) {
				yield* dropFutureSilences(orgId, windowId, nowMs)
				yield* materializeWindow(next, nowMs, true)
			} else {
				yield* retireSilences(orgId, windowId, nowMs, userId)
			}
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
			yield* retireSilences(orgId, windowId, nowMs, userId)
			yield* dbExecute((db) =>
				db.run(
					PG.deleteFrom(AlertMaintenanceWindows).where(($) => [
						$.orgId.eq(orgId),
						$.id.eq(windowId),
					]),
				),
			)
			return yield* toDocument({ ...current, row: { ...current.row, enabled: false } }, nowMs)
		})

		const materialize = Effect.fn("AlertMaintenanceWindowsService.materialize")(function* (
			nowMs: number,
		) {
			// Deliberate cross-org system scan: the cron writes every org's occurrences.
			const rows = yield* dbExecute((db) =>
				db.run(
					selectMaintenanceWindows()
						.where(($) => [$.enabled.eq(true)])
						.orderBy(["id", "asc"])
						.limit(MATERIALIZE_BATCH),
				),
			)
			if (rows.length >= MATERIALIZE_BATCH)
				yield* Effect.logWarning("Maintenance windows exceed one materialize batch").pipe(
					Effect.annotateLogs({ "maple.maintenance_window.batch": MATERIALIZE_BATCH }),
				)
			const results = yield* Effect.forEach(
				rows,
				(row) =>
					Option.match(decodeMaintenanceWindow(row), {
						onNone: () =>
							Effect.logWarning("Skipping an unreadable maintenance window").pipe(
								Effect.annotateLogs({ "maple.maintenance_window.id": row.id }),
								Effect.as({ upserted: 0, failed: 1 }),
							),
						onSome: (window) =>
							materializeWindow(window, nowMs, false).pipe(
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
					}),
				{ concurrency: MATERIALIZE_CONCURRENCY },
			)
			const result: MaterializeResult = {
				windows: rows.length,
				silencesUpserted: Arr.reduce(results, 0, (sum, r) => sum + r.upserted),
				failures: Arr.reduce(results, 0, (sum, r) => sum + r.failed),
			}
			yield* Effect.annotateCurrentSpan({
				"maple.maintenance_window.window_count": result.windows,
				"maple.maintenance_window.silences_upserted": result.silencesUpserted,
				"maple.maintenance_window.failures": result.failures,
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
