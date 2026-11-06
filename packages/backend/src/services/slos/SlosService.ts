import { randomUUID } from "node:crypto"
import * as Orm from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AlertDestinations, AlertRuleClaims, AlertRules, Slos } from "@maple/db/tables"
import {
	SloNotFoundError,
	SloPersistenceError,
	SloValidationError,
	AlertThresholds,
	type WarehouseReadError,
} from "@maple/domain/http"
import {
	type AlertDestinationId,
	AlertRuleId,
	type OrgId,
	SloId,
	SloWindowDays,
	type UserId,
} from "@maple/domain/primitives"
import {
	budgetRemaining,
	sliRatio,
	SloTargetPercent,
	type SloBurnWindow,
	type SloHistoryPoint,
	type SloSli,
} from "@maple/domain/slo"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Schema, String as Str } from "effect"
import type { MapleDb } from "@maple/db/client"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { deleteRuleRows } from "@maple/backend/services/alerts/AlertRulesService"
import { readBudgetHistory, readBurnWindows, readWindowTotals } from "./slo-reads"
import { sloRuleFields, sloRuleName, type SloRuleInput } from "./slo-alert-rule"

export interface SloRecord {
	readonly id: SloId
	readonly orgId: OrgId
	readonly name: string
	readonly description: string | null
	readonly serviceName: string
	readonly environments: ReadonlyArray<string>
	readonly sli: SloSli
	readonly targetPercent: number
	readonly windowDays: SloWindowDays
	readonly alertRuleId: AlertRuleId | null
	readonly alerting: SloAlerting
	readonly createdAt: number
	readonly updatedAt: number
}

/** The SLO's burn-rate alert: on or off, and who each tier notifies. */
export interface SloAlerting {
	readonly enabled: boolean
	/** Notified when the fast burn (critical, page) fires. */
	readonly criticalDestinationIds: ReadonlyArray<AlertDestinationId>
	/** Notified when the slow burn (warning, ticket) fires; a critical incident notifies them too. */
	readonly warningDestinationIds: ReadonlyArray<AlertDestinationId>
}

export interface CreateSloInput {
	readonly name: string
	readonly description?: string | null
	readonly serviceName: string
	readonly environments?: ReadonlyArray<string>
	readonly sli: SloSli
	readonly targetPercent: number
	readonly windowDays?: SloWindowDays
	readonly alerting?: Partial<SloAlerting>
	readonly createdBy: UserId
}

export interface UpdateSloInput {
	readonly name?: string
	readonly description?: string | null
	readonly serviceName?: string
	readonly environments?: ReadonlyArray<string>
	readonly sli?: SloSli
	readonly targetPercent?: number
	readonly windowDays?: SloWindowDays
	readonly alerting?: Partial<SloAlerting>
	readonly updatedBy: UserId
}

type SloError = SloNotFoundError | SloValidationError | SloPersistenceError

export interface SloStatus {
	/** The read's end, snapped to the minute. */
	readonly asOfMs: number
	readonly total: number
	readonly good: number
	/** Good share over the SLO window, `null` without events. */
	readonly sli: number | null
	/** Share of the window's budget left: 1 untouched, negative when overspent. */
	readonly budgetRemaining: number
	readonly burnWindows: ReadonlyArray<SloBurnWindow>
}

export interface SloHistory {
	readonly asOfMs: number
	readonly bucketSeconds: number
	readonly points: ReadonlyArray<SloHistoryPoint>
}

type SloReadError = SloNotFoundError | SloPersistenceError | WarehouseReadError

export interface SlosServiceApi {
	readonly list: (orgId: OrgId) => Effect.Effect<ReadonlyArray<SloRecord>, SloPersistenceError>
	readonly get: (
		orgId: OrgId,
		sloId: SloId,
	) => Effect.Effect<SloRecord, SloNotFoundError | SloPersistenceError>
	readonly create: (
		orgId: OrgId,
		input: CreateSloInput,
	) => Effect.Effect<SloRecord, SloValidationError | SloPersistenceError>
	readonly update: (orgId: OrgId, sloId: SloId, input: UpdateSloInput) => Effect.Effect<SloRecord, SloError>
	readonly delete: (
		orgId: OrgId,
		sloId: SloId,
	) => Effect.Effect<SloId, SloNotFoundError | SloPersistenceError>
	/** Where the SLO stands now: its SLI, budget left and each burn window. */
	readonly status: (tenant: TenantContext, sloId: SloId) => Effect.Effect<SloStatus, SloReadError>
	/** The budget chart: hourly points over the SLO window. */
	readonly history: (tenant: TenantContext, sloId: SloId) => Effect.Effect<SloHistory, SloReadError>
}

export const DEFAULT_SLO_WINDOW_DAYS: SloWindowDays = 30

const toPersistenceError = (error: unknown) =>
	new SloPersistenceError({
		message: error instanceof Error ? error.message : "SLO persistence failed",
		cause: error,
	})

const invalid = (message: string) => new SloValidationError({ message })
const notFound = (sloId: SloId) => new SloNotFoundError({ sloId, message: "SLO not found" })

const requireText = (field: string, value: string) => {
	const trimmed = Str.trim(value)
	return trimmed.length === 0 ? Effect.fail(invalid(`${field} is required`)) : Effect.succeed(trimmed)
}

const validateTarget = (value: number) =>
	Schema.decodeEffect(SloTargetPercent)(value).pipe(
		Effect.mapError(() => invalid("target_percent must be between 50 and 99.999")),
	)

const validateWindow = (value: number) =>
	Schema.decodeUnknownEffect(SloWindowDays)(value).pipe(
		Effect.mapError(() => invalid("window_days must be 7, 28 or 30")),
	)

const normalizeEnvironments = (environments: ReadonlyArray<string>) =>
	Arr.dedupe(Arr.filter(Arr.map(environments, Str.trim), Str.isNonEmpty))

/** Every SLO with its burn-rate rule, which carries the alerting settings. */
const selectSlos = () =>
	PG.from(Slos, "s")
		.leftJoin(AlertRules, "r", (slo, rule) => slo.alertRuleId.eq(rule.id).and(slo.orgId.eq(rule.orgId)))
		.select(($) => ({
			id: $.id,
			orgId: $.orgId,
			name: $.name,
			description: $.description,
			serviceName: $.serviceName,
			environmentsJson: $.environmentsJson,
			sliJson: $.sliJson,
			targetPercent: $.targetPercent,
			windowDays: $.windowDays,
			alertRuleId: $.alertRuleId,
			ruleEnabled: $.r.enabled,
			ruleThresholdsJson: $.r.thresholdsJson,
			createdAt: $.createdAt,
			updatedAt: $.updatedAt,
		}))

interface SloSelectRow {
	readonly id: SloId
	readonly orgId: OrgId
	readonly name: string
	readonly description: string | null
	readonly serviceName: string
	readonly environmentsJson: ReadonlyArray<string>
	readonly sliJson: SloSli
	readonly targetPercent: number
	readonly windowDays: SloWindowDays
	readonly alertRuleId: AlertRuleId | null
	readonly ruleEnabled: boolean | null
	/** Untyped jsonb: read through `decodeThresholds`. */
	readonly ruleThresholdsJson: unknown
	readonly createdAt: number
	readonly updatedAt: number
}

const decodeThresholds = Schema.decodeUnknownOption(AlertThresholds)

/** A tier's destinations; none when the rule is missing (an SLO saved before burn alerts). */
const tierDestinations = (row: SloSelectRow, severity: "critical" | "warning") =>
	decodeThresholds(row.ruleThresholdsJson).pipe(
		Option.flatMap((tiers) => Arr.findFirst(tiers, (tier) => tier.severity === severity)),
		Option.match({
			onNone: (): ReadonlyArray<AlertDestinationId> => [],
			onSome: (tier) => tier.destinationIds,
		}),
	)

const toRecord = (row: SloSelectRow): SloRecord => ({
	id: row.id,
	orgId: row.orgId,
	name: row.name,
	description: row.description,
	serviceName: row.serviceName,
	environments: row.environmentsJson,
	sli: row.sliJson,
	targetPercent: row.targetPercent,
	windowDays: row.windowDays,
	alertRuleId: row.alertRuleId,
	alerting: {
		enabled: row.ruleEnabled ?? false,
		criticalDestinationIds: tierDestinations(row, "critical"),
		warningDestinationIds: tierDestinations(row, "warning"),
	},
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
})

/** The per-org lock alert rule writes take, so a rule name check and its insert are atomic. */
const lockOrgRules = (db: MapleDb, orgId: OrgId) =>
	db.execute(Orm.sql`select pg_advisory_xact_lock(hashtext(${orgId}))`)

/** Checks a burn-rate rule write: its destinations exist and its name is free among alert rules. */
const claimRuleWrite = Effect.fnUntraced(function* (
	db: MapleDb,
	orgId: OrgId,
	ruleId: AlertRuleId,
	rule: SloRuleInput,
) {
	const destinationIds = Arr.dedupe([...rule.criticalDestinationIds, ...rule.warningDestinationIds])
	if (destinationIds.length > 0) {
		const found = yield* db.run(
			PG.from(AlertDestinations)
				.select("id")
				.where(($) => [$.orgId.eq(orgId), $.id.in_(...destinationIds)]),
		)
		const known = new Set(Arr.map(found, (row) => row.id))
		const missing = Arr.findFirst(destinationIds, (id) => !known.has(id))
		if (Option.isSome(missing)) return yield* invalid(`Unknown alert destination ${missing.value}`)
	}
	const ruleName = sloRuleName(rule.name)
	const sameName = yield* db.run(
		PG.from(AlertRules)
			.select("id")
			.where(($) => [$.orgId.eq(orgId), $.name.eq(ruleName), $.id.neq(ruleId)])
			.limit(1),
	)
	if (sameName.length > 0) {
		return yield* invalid(
			`An alert rule named '${ruleName}' already exists; rename it or pick another SLO name`,
		)
	}
})

const sameIds = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
	a.length === b.length && Arr.every(a, (id, index) => id === b[index])

/** Names are unique per org: the list, incidents and notifications identify an SLO by it. */
const ensureNameFree = Effect.fnUntraced(function* (db: MapleDb, orgId: OrgId, name: string, sloId: SloId) {
	const same = yield* db.run(
		PG.from(Slos)
			.select("id")
			.where(($) => [$.orgId.eq(orgId), $.name.eq(name), $.id.neq(sloId)])
			.limit(1),
	)
	if (same.length > 0) return yield* invalid(`An SLO named '${name}' already exists; pick another name`)
})

export class SlosService extends Context.Service<SlosService, SlosServiceApi>()(
	"@maple/backend/services/slos/SlosService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "SlosService", toPersistenceError)
			const warehouse = yield* WarehouseQueryService
			const withWarehouse = Effect.provideService(WarehouseQueryService, warehouse)
			const nowMinute = Effect.map(Clock.currentTimeMillis, (now) => Math.floor(now / 60_000) * 60_000)

			const selectOne = (orgId: OrgId, sloId: SloId) =>
				dbExecute((db) =>
					db.run(
						selectSlos()
							.where(($) => [$.orgId.eq(orgId), $.id.eq(sloId)])
							.limit(1),
					),
				).pipe(
					Effect.flatMap((rows) => {
						const row = rows[0]
						return row === undefined
							? Effect.fail(notFound(sloId))
							: Effect.succeed(toRecord(row))
					}),
				)

			const list = Effect.fn("SlosService.list")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const rows = yield* dbExecute((db) =>
					db.run(
						selectSlos()
							.where(($) => [$.orgId.eq(orgId)])
							.orderBy(["createdAt", "desc"], ["id", "desc"]),
					),
				)
				return Arr.map(rows, toRecord)
			})

			const get = Effect.fn("SlosService.get")(function* (orgId: OrgId, sloId: SloId) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.slo.id": sloId })
				return yield* selectOne(orgId, sloId)
			})

			const create = Effect.fn("SlosService.create")(function* (orgId: OrgId, input: CreateSloInput) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.slo.sli": input.sli._tag })
				const name = yield* requireText("name", input.name)
				const serviceName = yield* requireText("service_name", input.serviceName)
				const targetPercent = yield* validateTarget(input.targetPercent)
				const windowDays = yield* validateWindow(input.windowDays ?? DEFAULT_SLO_WINDOW_DAYS)
				const environments = normalizeEnvironments(input.environments ?? [])
				const now = yield* Clock.currentTimeMillis
				const id = SloId.make(randomUUID())
				const ruleId = AlertRuleId.make(randomUUID())
				const rule: SloRuleInput = {
					name,
					serviceName,
					environments,
					enabled: input.alerting?.enabled ?? true,
					criticalDestinationIds: Arr.dedupe(input.alerting?.criticalDestinationIds ?? []),
					warningDestinationIds: Arr.dedupe(input.alerting?.warningDestinationIds ?? []),
				}
				yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* lockOrgRules(db, orgId)
							yield* ensureNameFree(db, orgId, name, id)
							yield* claimRuleWrite(db, orgId, ruleId, rule)
							yield* db.run(
								PG.insertInto(AlertRules).values({
									id: ruleId,
									orgId,
									...sloRuleFields(rule),
									lastScheduledAt: null,
									createdAt: now,
									updatedAt: now,
									createdBy: input.createdBy,
									updatedBy: input.createdBy,
								}),
							)
							yield* db.run(
								PG.insertInto(Slos).values({
									id,
									orgId,
									name,
									description: input.description ?? null,
									serviceName,
									environmentsJson: environments,
									sliJson: input.sli,
									targetPercent,
									windowDays,
									alertRuleId: ruleId,
									createdBy: input.createdBy,
									updatedBy: input.createdBy,
									createdAt: now,
									updatedAt: now,
								}),
							)
						}),
					),
				)
				return yield* selectOne(orgId, id).pipe(
					Effect.catchTag("@maple/http/errors/SloNotFoundError", () =>
						Effect.fail(new SloPersistenceError({ message: "Created SLO not found" })),
					),
				)
			})

			const update = Effect.fn("SlosService.update")(function* (
				orgId: OrgId,
				sloId: SloId,
				input: UpdateSloInput,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.slo.id": sloId })
				const name = input.name === undefined ? undefined : yield* requireText("name", input.name)
				const serviceName =
					input.serviceName === undefined
						? undefined
						: yield* requireText("service_name", input.serviceName)
				const targetPercent =
					input.targetPercent === undefined ? undefined : yield* validateTarget(input.targetPercent)
				const windowDays =
					input.windowDays === undefined ? undefined : yield* validateWindow(input.windowDays)
				const environments =
					input.environments === undefined ? undefined : normalizeEnvironments(input.environments)
				const now = yield* Clock.currentTimeMillis
				yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							// Lock, then re-read: the rule is rebuilt from a row no other write changes
							// before commit, and a concurrent delete either finished first or waits.
							yield* lockOrgRules(db, orgId)
							const lockedRows = yield* db.run(
								selectSlos()
									.where(($) => [$.orgId.eq(orgId), $.id.eq(sloId)])
									.limit(1),
							)
							const lockedRow = lockedRows[0]
							if (lockedRow === undefined) return yield* notFound(sloId)
							const locked = toRecord(lockedRow)
							if (name !== undefined) yield* ensureNameFree(db, orgId, name, sloId)
							const rule: SloRuleInput = {
								name: name ?? locked.name,
								serviceName: serviceName ?? locked.serviceName,
								environments: environments ?? locked.environments,
								// An SLO saved before burn alerts existed gets its rule switched on.
								enabled:
									input.alerting?.enabled ??
									(locked.alertRuleId === null || locked.alerting.enabled),
								criticalDestinationIds:
									input.alerting?.criticalDestinationIds === undefined
										? locked.alerting.criticalDestinationIds
										: Arr.dedupe(input.alerting.criticalDestinationIds),
								warningDestinationIds:
									input.alerting?.warningDestinationIds === undefined
										? locked.alerting.warningDestinationIds
										: Arr.dedupe(input.alerting.warningDestinationIds),
							}
							// The rule is written only when it changes: alert_rules is synced to browsers.
							const ruleChanged =
								locked.alertRuleId === null ||
								rule.name !== locked.name ||
								rule.serviceName !== locked.serviceName ||
								!sameIds(rule.environments, locked.environments) ||
								rule.enabled !== locked.alerting.enabled ||
								!sameIds(
									rule.criticalDestinationIds,
									locked.alerting.criticalDestinationIds,
								) ||
								!sameIds(rule.warningDestinationIds, locked.alerting.warningDestinationIds)
							const ruleId = locked.alertRuleId ?? AlertRuleId.make(randomUUID())
							if (ruleChanged) {
								yield* claimRuleWrite(db, orgId, ruleId, rule)
								if (locked.alertRuleId === null) {
									yield* db.run(
										PG.insertInto(AlertRules).values({
											id: ruleId,
											orgId,
											...sloRuleFields(rule),
											lastScheduledAt: null,
											createdAt: now,
											updatedAt: now,
											createdBy: input.updatedBy,
											updatedBy: input.updatedBy,
										}),
									)
								} else {
									// Ends a tick's claim on the old config, as a rule edit does.
									yield* db.run(
										PG.deleteFrom(AlertRuleClaims).where(($) => [$.ruleId.eq(ruleId)]),
									)
									yield* db.run(
										PG.update(AlertRules)
											.set({
												...sloRuleFields(rule),
												updatedAt: now,
												updatedBy: input.updatedBy,
											})
											.where(($) => [$.orgId.eq(orgId), $.id.eq(ruleId)]),
									)
								}
							}
							yield* db.run(
								PG.update(Slos)
									.set({
										...(locked.alertRuleId === null
											? { alertRuleId: ruleId }
											: undefined),
										...(name === undefined ? undefined : { name }),
										...(input.description === undefined
											? undefined
											: { description: input.description }),
										...(serviceName === undefined ? undefined : { serviceName }),
										...(environments === undefined
											? undefined
											: { environmentsJson: environments }),
										...(input.sli === undefined ? undefined : { sliJson: input.sli }),
										...(targetPercent === undefined ? undefined : { targetPercent }),
										...(windowDays === undefined ? undefined : { windowDays }),
										updatedBy: input.updatedBy,
										updatedAt: now,
									})
									.where(($) => [$.orgId.eq(orgId), $.id.eq(sloId)]),
							)
						}),
					),
				)
				return yield* selectOne(orgId, sloId)
			})

			const remove = Effect.fn("SlosService.delete")(function* (orgId: OrgId, sloId: SloId) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.slo.id": sloId })
				// The burn-rate rule goes with the SLO, through the rule delete's own cascade.
				const removed = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* lockOrgRules(db, orgId)
							const rows = yield* db.run(
								PG.deleteFrom(Slos)
									.where(($) => [$.orgId.eq(orgId), $.id.eq(sloId)])
									.returning("id", "alertRuleId"),
							)
							const ruleId = rows[0]?.alertRuleId ?? null
							if (ruleId !== null) yield* deleteRuleRows(db, orgId, ruleId)
							return rows
						}),
					),
				)
				if (removed.length === 0) return yield* notFound(sloId)
				return sloId
			})

			const status = Effect.fn("SlosService.status")(function* (tenant: TenantContext, sloId: SloId) {
				yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.slo.id": sloId })
				const slo = yield* selectOne(tenant.orgId, sloId)
				const asOfMs = yield* nowMinute
				const [totals, windows] = yield* Effect.all(
					[readWindowTotals(tenant, slo, asOfMs), readBurnWindows(tenant, slo, asOfMs)],
					{ concurrency: 2 },
				).pipe(withWarehouse)
				return {
					asOfMs,
					total: totals.total,
					good: totals.good,
					sli: sliRatio(totals),
					budgetRemaining: budgetRemaining(totals, slo.targetPercent),
					burnWindows: windows,
				} satisfies SloStatus
			})

			const history = Effect.fn("SlosService.history")(function* (tenant: TenantContext, sloId: SloId) {
				yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.slo.id": sloId })
				const slo = yield* selectOne(tenant.orgId, sloId)
				const asOfMs = yield* nowMinute
				const points = yield* readBudgetHistory(tenant, slo, asOfMs).pipe(withWarehouse)
				return { asOfMs, bucketSeconds: 3600, points } satisfies SloHistory
			})

			return { list, get, create, update, delete: remove, status, history } satisfies SlosServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(WarehouseQueryService.layer))
}
