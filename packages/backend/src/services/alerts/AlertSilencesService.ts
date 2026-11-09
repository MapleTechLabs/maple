import {
	AlertForbiddenError,
	AlertPersistenceError,
	AlertSilenceId as AlertSilenceIdSchema,
	AlertSilenceNotFoundError,
	AlertSilencesListResponse,
	AlertValidationError,
	MAX_ALERT_SILENCE_DURATION_MS,
	type AlertMaintenanceWindowId,
	type AlertSilenceCreateRequest,
	type AlertSilenceDocument,
	type AlertSilenceId,
	type AlertSilenceMatchers,
	type AlertSilenceStatus,
	type AlertSilenceUpdateRequest,
	type OrgId,
	type RoleName,
	type UserId,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AlertMaintenanceWindows, AlertRules, AlertSilences, type AlertSilenceRow } from "@maple/db/tables"
import { Array as Arr, Context, Effect, Layer, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { timestampMs } from "@maple/backend/platform/time"
import * as Policy from "@maple/domain/policy"
import { makePersistenceError } from "./alert-persistence"
import { AlertRuntime } from "./AlertRuntime"
import { selectSilences, silenceRowToDocument, type StoredSilenceRow } from "./alert-silence-store"

/** Scheduled and active silences an org may hold at once. */
const MAX_OPEN_SILENCES_PER_ORG = 200
/** A start this far in the past still reads as "now" (a client clock a little behind). */
const START_SKEW_MS = 5 * 60_000

const decodeSilenceIdSync = Schema.decodeUnknownSync(AlertSilenceIdSchema)

export interface ListAlertSilencesOptions {
	readonly status?: AlertSilenceStatus
	/** Only the occurrences one maintenance window wrote. */
	readonly maintenanceWindowId?: AlertMaintenanceWindowId
	readonly limit?: number
	readonly offset?: number
}

export interface AlertSilencesServiceApi {
	readonly list: (
		orgId: OrgId,
		options?: ListAlertSilencesOptions,
	) => Effect.Effect<AlertSilencesListResponse, AlertPersistenceError>
	readonly get: (
		orgId: OrgId,
		silenceId: AlertSilenceId,
	) => Effect.Effect<AlertSilenceDocument, AlertPersistenceError | AlertSilenceNotFoundError>
	readonly create: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		request: AlertSilenceCreateRequest,
	) => Effect.Effect<
		AlertSilenceDocument,
		AlertForbiddenError | AlertValidationError | AlertPersistenceError
	>
	readonly update: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		silenceId: AlertSilenceId,
		request: AlertSilenceUpdateRequest,
	) => Effect.Effect<
		AlertSilenceDocument,
		AlertForbiddenError | AlertValidationError | AlertPersistenceError | AlertSilenceNotFoundError
	>
	/** Ends a silence now; a scheduled one is cancelled. Rows are kept so history can name them. */
	readonly end: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		silenceId: AlertSilenceId,
	) => Effect.Effect<
		AlertSilenceDocument,
		AlertForbiddenError | AlertValidationError | AlertPersistenceError | AlertSilenceNotFoundError
	>
}

const validationError = (message: string) => new AlertValidationError({ message, details: [message] })

export class AlertSilencesService extends Context.Service<AlertSilencesService, AlertSilencesServiceApi>()(
	"@maple/backend/services/alerts/AlertSilencesService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const runtime = yield* AlertRuntime
			const dbExecute = makeDbExecute(database, "AlertSilencesService", makePersistenceError)

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

			const toDocument = (row: StoredSilenceRow, nowMs: number) =>
				Effect.fromOption(silenceRowToDocument(row, nowMs)).pipe(
					Effect.mapError(
						() =>
							new AlertPersistenceError({
								message: "Stored alert silence matchers are invalid",
							}),
					),
				)

			const findRow = Effect.fn("AlertSilencesService.findRow")(function* (
				orgId: OrgId,
				silenceId: AlertSilenceId,
			) {
				const rows = yield* dbExecute((db) =>
					db.run(
						selectSilences()
							.where(($) => [$.orgId.eq(orgId), $.id.eq(silenceId)])
							.limit(1),
					),
				)
				const row = rows[0]
				if (row === undefined) {
					return yield* new AlertSilenceNotFoundError({
						message: "Alert silence not found",
						silenceId,
					})
				}
				return row
			})

			/** Every rule id must belong to the org, so a typo cannot silence nothing while looking fine. */
			const requireRuleIds = Effect.fn("AlertSilencesService.requireRuleIds")(function* (
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
						message: "Unknown alert rule in silence matchers",
						details: Arr.map(missing, (id) => `Alert rule ${id} does not exist`),
					})
				}
			})

			/** A silence a maintenance window wrote is changed through the window, which would undo the edit. */
			const requireUnmanaged = Effect.fn("AlertSilencesService.requireUnmanaged")(function* (
				orgId: OrgId,
				row: StoredSilenceRow,
			) {
				const windowId = row.maintenanceWindowId
				if (windowId === null) return
				const windows = yield* dbExecute((db) =>
					db.run(
						PG.from(AlertMaintenanceWindows)
							.select("name")
							.where(($) => [$.orgId.eq(orgId), $.id.eq(windowId)])
							.limit(1),
					),
				)
				const window = windows[0]
				return yield* validationError(
					window === undefined
						? "This silence came from a maintenance window that was deleted, so it cannot be edited"
						: `This silence belongs to maintenance window ${window.name}; edit or disable the window instead`,
				)
			})

			const validateWindow = (startsAtMs: number, endsAtMs: number, nowMs: number) => {
				if (endsAtMs <= startsAtMs)
					return Effect.fail(validationError("endsAt must be after startsAt"))
				if (endsAtMs <= nowMs) return Effect.fail(validationError("endsAt must be in the future"))
				if (endsAtMs - startsAtMs > MAX_ALERT_SILENCE_DURATION_MS)
					return Effect.fail(validationError("A silence can last at most 30 days"))
				return Effect.void
			}

			const list = Effect.fn("AlertSilencesService.list")(function* (
				orgId: OrgId,
				options: ListAlertSilencesOptions = {},
			) {
				const nowMs = yield* runtime.now
				const status = options.status
				const rows = yield* dbExecute((db) =>
					db.run(
						selectSilences()
							.where(($) => [
								$.orgId.eq(orgId),
								...(status === "active" ? [$.startsAt.lte(nowMs), $.endsAt.gt(nowMs)] : []),
								...(status === "scheduled" ? [$.startsAt.gt(nowMs)] : []),
								...(status === "ended" ? [$.endsAt.lte(nowMs)] : []),
								...(options.maintenanceWindowId === undefined
									? []
									: [$.maintenanceWindowId.eq(options.maintenanceWindowId)]),
							])
							.orderBy(["endsAt", "desc"], ["id", "asc"])
							.limit(options.limit ?? 500)
							.offset(options.offset ?? 0),
					),
				)
				const silences = yield* Effect.forEach(rows, (row) => toDocument(row, nowMs))
				return new AlertSilencesListResponse({ silences })
			})

			const get = Effect.fn("AlertSilencesService.get")(function* (
				orgId: OrgId,
				silenceId: AlertSilenceId,
			) {
				const row = yield* findRow(orgId, silenceId)
				const nowMs = yield* runtime.now
				return yield* toDocument(row, nowMs)
			})

			const create = Effect.fn("AlertSilencesService.create")(function* (
				orgId: OrgId,
				userId: UserId,
				roles: ReadonlyArray<RoleName>,
				request: AlertSilenceCreateRequest,
			) {
				yield* requireManage(roles)
				const nowMs = yield* runtime.now
				const requestedStart = request.startsAt === undefined ? nowMs : timestampMs(request.startsAt)
				if (requestedStart < nowMs - START_SKEW_MS)
					return yield* validationError("startsAt cannot be in the past")
				// A start within the skew stands as given, so a duration the caller added to it is kept exactly.
				const startsAtMs = requestedStart
				const endsAtMs = timestampMs(request.endsAt)
				yield* validateWindow(startsAtMs, endsAtMs, nowMs)
				yield* requireRuleIds(orgId, request.matchers)

				const open = yield* dbExecute((db) =>
					db.run(
						PG.from(AlertSilences)
							.select("id")
							// A maintenance window's occurrences have their own cap and do not count.
							.where(($) => [
								$.orgId.eq(orgId),
								$.endsAt.gt(nowMs),
								$.maintenanceWindowId.isNull(),
							])
							.limit(MAX_OPEN_SILENCES_PER_ORG),
					),
				)
				if (open.length >= MAX_OPEN_SILENCES_PER_ORG)
					return yield* validationError(
						`An organization can have at most ${MAX_OPEN_SILENCES_PER_ORG} active or scheduled silences`,
					)

				const row: AlertSilenceRow = {
					id: decodeSilenceIdSync(runtime.makeUuid()),
					orgId,
					reason: request.reason,
					matchersJson: request.matchers,
					startsAt: startsAtMs,
					endsAt: endsAtMs,
					maintenanceWindowId: null,
					excludeFromBaselines: false,
					createdAt: nowMs,
					updatedAt: nowMs,
					createdBy: userId,
					updatedBy: userId,
				}
				yield* dbExecute((db) => db.run(PG.insertInto(AlertSilences).values(row)))
				yield* Effect.annotateCurrentSpan({ "maple.alert_silence.id": row.id })
				return yield* toDocument(row, nowMs)
			})

			const update = Effect.fn("AlertSilencesService.update")(function* (
				orgId: OrgId,
				userId: UserId,
				roles: ReadonlyArray<RoleName>,
				silenceId: AlertSilenceId,
				request: AlertSilenceUpdateRequest,
			) {
				yield* requireManage(roles)
				const nowMs = yield* runtime.now
				const current = yield* findRow(orgId, silenceId)
				yield* requireUnmanaged(orgId, current)
				if (current.endsAt <= nowMs)
					return yield* validationError("An ended silence cannot be changed")
				const started = current.startsAt <= nowMs
				if (started && request.startsAt !== undefined)
					return yield* validationError("A silence that has started cannot change its start")

				const startsAtMs =
					request.startsAt === undefined
						? current.startsAt
						: Math.max(timestampMs(request.startsAt), nowMs)
				const endsAtMs = request.endsAt === undefined ? current.endsAt : timestampMs(request.endsAt)
				yield* validateWindow(startsAtMs, endsAtMs, nowMs)
				if (request.matchers !== undefined) yield* requireRuleIds(orgId, request.matchers)

				const next: StoredSilenceRow = {
					...current,
					reason: request.reason ?? current.reason,
					matchersJson: request.matchers ?? current.matchersJson,
					startsAt: startsAtMs,
					endsAt: endsAtMs,
					updatedAt: nowMs,
					updatedBy: userId,
				}
				yield* dbExecute((db) =>
					db.run(
						PG.update(AlertSilences)
							.set({
								reason: next.reason,
								...(request.matchers === undefined
									? undefined
									: { matchersJson: request.matchers }),
								startsAt: next.startsAt,
								endsAt: next.endsAt,
								updatedAt: next.updatedAt,
								updatedBy: next.updatedBy,
							})
							.where(($) => [$.orgId.eq(orgId), $.id.eq(silenceId)]),
					),
				)
				return yield* toDocument(next, nowMs)
			})

			const end = Effect.fn("AlertSilencesService.end")(function* (
				orgId: OrgId,
				userId: UserId,
				roles: ReadonlyArray<RoleName>,
				silenceId: AlertSilenceId,
			) {
				yield* requireManage(roles)
				const nowMs = yield* runtime.now
				const current = yield* findRow(orgId, silenceId)
				yield* requireUnmanaged(orgId, current)
				if (current.endsAt <= nowMs) return yield* toDocument(current, nowMs)
				// A scheduled silence that never started collapses to an empty window at now.
				const startsAt = Math.min(current.startsAt, nowMs)
				const ended: StoredSilenceRow = {
					...current,
					startsAt,
					endsAt: nowMs,
					updatedAt: nowMs,
					updatedBy: userId,
				}
				yield* dbExecute((db) =>
					db.run(
						PG.update(AlertSilences)
							.set({ startsAt, endsAt: nowMs, updatedAt: nowMs, updatedBy: userId })
							.where(($) => [$.orgId.eq(orgId), $.id.eq(silenceId)]),
					),
				)
				return yield* toDocument(ended, nowMs)
			})

			return { list, get, create, update, end } satisfies AlertSilencesServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
