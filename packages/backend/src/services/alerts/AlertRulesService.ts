import {
	AlertForbiddenError,
	AlertRuleDestinationNotFoundError,
	AlertRuleNotFoundError,
	AlertRuleStoredConfigInvalidError,
	AlertPersistenceError,
	AlertRuleDeleteResponse,
	AlertRuleDocument,
	AlertRulesListResponse,
	AlertValidationError,
	RoleName,
	type AlertDestinationId,
	type AlertRuleId,
	type AlertRuleUpsertRequest,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import * as Orm from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	AlertDeliveryEvents,
	AlertDestinations,
	AlertIncidents,
	AlertRuleClaims,
	AlertRules,
	AlertRuleStates,
} from "@maple/db/tables"
import { Array as Arr, Context, Effect, HashSet, Layer, Schema } from "effect"
import { Database, type DatabaseApi } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { currentTxid, readTxid } from "@maple/backend/platform/electric-txid"
import {
	makeAlertRuleNormalizer,
	makeAlertValidationError,
	normalizedRuleToDocument,
	normalizeOptionalString,
	rowToRuleDocument,
	selectStoredAlertRules,
	type RuleEvaluationState,
} from "./AlertRuleModel"
import { makePersistenceError } from "./alert-persistence"
import { AlertRuntime, type AlertRuntimeApi } from "./AlertRuntime"

const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)
const adminRoles = [decodeRoleNameSync("root"), decodeRoleNameSync("org:admin")]
const MAX_ACTIVE_ALERT_RULES_PER_ORG = 100

const isAdmin = (roles: ReadonlyArray<RoleName>) => roles.some((role) => adminRoles.includes(role))

export interface AlertRulesServiceApi {
	readonly listRules: (
		orgId: OrgId,
	) => Effect.Effect<AlertRulesListResponse, AlertPersistenceError | AlertRuleStoredConfigInvalidError>
	readonly createRule: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		request: AlertRuleUpsertRequest,
	) => Effect.Effect<
		AlertRuleDocument,
		AlertForbiddenError | AlertValidationError | AlertPersistenceError | AlertRuleDestinationNotFoundError
	>
	readonly deleteRule: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
		ruleId: AlertRuleDocument["id"],
	) => Effect.Effect<
		AlertRuleDeleteResponse,
		AlertForbiddenError | AlertPersistenceError | AlertRuleNotFoundError
	>
}

export const makeAlertRulePersistence = (options: {
	readonly database: DatabaseApi
	readonly runtime: AlertRuntimeApi
}) => {
	const { database, runtime } = options
	const { normalizeRule, normalizeRuleRow } = makeAlertRuleNormalizer(runtime)

	const dbExecute = makeDbExecute(database, "AlertRulesService", makePersistenceError)

	const requireAdmin = Effect.fn("AlertRulesService.requireAdmin")(function* (
		roles: ReadonlyArray<RoleName>,
	) {
		if (isAdmin(roles)) return
		return yield* Effect.fail(
			new AlertForbiddenError({
				message: "Only org admins can manage alerts",
				...(roles.length > 0 ? { roles: [...roles] } : undefined),
			}),
		)
	})

	const findRuleRow = Effect.fn("AlertRulesService.findRuleRow")(function* (
		orgId: OrgId,
		ruleId: AlertRuleDocument["id"],
	) {
		const rows = yield* dbExecute((db) =>
			db.run(
				selectStoredAlertRules()
					.where(($) => [$.orgId.eq(orgId), $.id.eq(ruleId)])
					.limit(1),
			),
		)
		return rows[0]
	})

	const requireRuleRow = Effect.fn("AlertRulesService.requireRuleRow")(function* (
		orgId: OrgId,
		ruleId: AlertRuleDocument["id"],
	) {
		const row = yield* findRuleRow(orgId, ruleId)
		if (row !== undefined) return row
		return yield* Effect.fail(
			new AlertRuleNotFoundError({
				message: "Alert rule not found",
				ruleId,
			}),
		)
	})

	const requireDestinationIds = Effect.fn("AlertRulesService.requireDestinationIds")(function* (
		orgId: OrgId,
		destinationIds: ReadonlyArray<AlertDestinationId>,
	) {
		if (destinationIds.length === 0) return
		const rows = yield* dbExecute((db) =>
			db.run(
				PG.from(AlertDestinations)
					.select("id")
					.where(($) => [$.orgId.eq(orgId), $.id.in_(...destinationIds)]),
			),
		)
		const existingIds = HashSet.fromIterable(Arr.map(rows, (row) => row.id))
		const missing = Arr.filter(destinationIds, (id) => !HashSet.has(existingIds, id))
		const missingDestinationId = missing[0]
		if (missingDestinationId !== undefined) {
			return yield* Effect.fail(
				new AlertRuleDestinationNotFoundError({
					message: "Alert rule references an unknown destination",
					destinationId: missingDestinationId,
				}),
			)
		}
	})

	const writeRuleRow = Effect.fn("AlertRulesService.writeRuleRow")(function* (
		orgId: OrgId,
		userId: UserId,
		existingId: AlertRuleId | null,
		request: AlertRuleUpsertRequest,
	) {
		const normalized = yield* normalizeRule(orgId, request)
		const ruleId = existingId ?? normalized.id
		const timestamp = yield* runtime.now
		const ruleFields = {
			name: normalized.name,
			notes: normalizeOptionalString(request.notes),
			notificationTemplateJson: normalized.notificationTemplate ?? null,
			enabled: normalized.enabled,
			severity: normalized.severity,
			serviceNamesJson: normalized.serviceNames.length > 0 ? normalized.serviceNames : null,
			excludeServiceNamesJson:
				normalized.excludeServiceNames.length > 0 ? normalized.excludeServiceNames : null,
			environmentsJson: normalized.environments.length > 0 ? normalized.environments : null,
			tagsJson: normalized.tags.length > 0 ? normalized.tags : null,
			groupBy: normalized.groupBy != null ? JSON.stringify(normalized.groupBy) : null,
			signalType: normalized.signalType,
			comparator: normalized.comparator,
			threshold: normalized.threshold,
			thresholdUpper: normalized.thresholdUpper,
			windowMinutes: normalized.windowMinutes,
			minimumSampleCount: normalized.minimumSampleCount,
			consecutiveBreachesRequired: normalized.consecutiveBreachesRequired,
			consecutiveHealthyRequired: normalized.consecutiveHealthyRequired,
			renotifyIntervalMinutes: normalized.renotifyIntervalMinutes,
			apdexThresholdMs: normalized.apdexThresholdMs,
			queryBuilderDraftJson: normalized.queryBuilderDraft ?? null,
			rawQuerySql: normalized.rawQuerySql,
			destinationIdsJson: normalized.destinationIds,
			querySpecJson: normalized.compiledPlan.query ?? null,
			reducer: normalized.compiledPlan.reducer,
			sampleCountStrategy: normalized.compiledPlan.sampleCountStrategy,
			noDataBehavior: normalized.compiledPlan.noDataBehavior,
			updatedAt: timestamp,
			updatedBy: userId,
		} as const

		const writeRows = yield* dbExecute((db) =>
			db.transaction(
				Effect.gen(function* () {
					yield* db.execute(Orm.sql`select pg_advisory_xact_lock(hashtext(${orgId}))`)
					// Destination existence is checked INSIDE the lock: destination
					// deletion takes the same per-org advisory lock around its reference
					// scan, so a rule can no longer commit a reference to a destination
					// whose deletion validated "unreferenced" concurrently.
					if (normalized.destinationIds.length > 0) {
						const destinationRows = yield* db.run(
							PG.from(AlertDestinations)
								.select("id")
								.where(($) => [$.orgId.eq(orgId), $.id.in_(...normalized.destinationIds)]),
						)
						const existingIds = new Set(destinationRows.map((destination) => destination.id))
						const missingDestinationId = normalized.destinationIds.find(
							(id) => !existingIds.has(id),
						)
						if (missingDestinationId !== undefined) {
							return yield* Effect.fail(
								new AlertRuleDestinationNotFoundError({
									message: "Alert rule references an unknown destination",
									destinationId: missingDestinationId,
								}),
							)
						}
					}
					if (normalized.enabled) {
						const activeRows = yield* db.run(
							PG.from(AlertRules)
								.select("id")
								.where(($) => [$.orgId.eq(orgId), $.enabled.eq(true)]),
						)
						const alreadyActive =
							existingId != null && activeRows.some((row) => row.id === existingId)
						if (!alreadyActive && activeRows.length >= MAX_ACTIVE_ALERT_RULES_PER_ORG) {
							return yield* Effect.fail(
								makeAlertValidationError(
									`Organizations may have at most ${MAX_ACTIVE_ALERT_RULES_PER_ORG} active alert rules`,
								),
							)
						}
					}

					return existingId == null
						? yield* db.run(
								PG.insertInto(AlertRules)
									.values({
										id: ruleId,
										orgId,
										...ruleFields,
										createdAt: timestamp,
										createdBy: userId,
									})
									.returning(() => ({ txid: currentTxid })),
							)
						: yield* db.run(
								PG.update(AlertRules)
									.set(ruleFields)
									.where(($) => [$.orgId.eq(orgId), $.id.eq(existingId)])
									.returning(() => ({ txid: currentTxid })),
							)
				}),
			),
		)
		return {
			normalized,
			ruleId,
			timestamp,
			txid: readTxid(writeRows),
		}
	})

	const upsertRuleRow = Effect.fn("AlertRulesService.upsertRuleRow")(function* (
		orgId: OrgId,
		userId: UserId,
		existingId: AlertRuleId,
		request: AlertRuleUpsertRequest,
	) {
		const { ruleId, txid } = yield* writeRuleRow(orgId, userId, existingId, request)
		const row = yield* findRuleRow(orgId, ruleId)
		if (row === undefined) {
			return yield* Effect.fail(
				new AlertPersistenceError({
					message: "Alert rule row was not readable after it was saved",
				}),
			)
		}
		const document = yield* rowToRuleDocument(row)
		return txid === undefined ? document : new AlertRuleDocument({ ...document, txid })
	})

	const listRules = Effect.fn("AlertRulesService.listRules")(function* (orgId: OrgId) {
		const rows = yield* dbExecute((db) =>
			db.run(
				selectStoredAlertRules()
					.where(($) => [$.orgId.eq(orgId)])
					.orderBy(["createdAt", "desc"], ["id", "desc"]),
			),
		)
		const stateRows = yield* dbExecute((db) =>
			db.run(
				PG.from(AlertRuleStates)
					.select("ruleId", "lastError", "lastEvaluatedAt")
					.where(($) => [$.orgId.eq(orgId)]),
			),
		)
		const errorByRule = new Map<string, RuleEvaluationState>()
		for (const state of stateRows) {
			if (state.lastError == null) continue
			const existing = errorByRule.get(state.ruleId)
			if (existing == null || (state.lastEvaluatedAt ?? 0) > (existing.evaluatedAt ?? 0)) {
				errorByRule.set(state.ruleId, {
					error: state.lastError,
					evaluatedAt: state.lastEvaluatedAt,
				})
			}
		}
		const rules = yield* Effect.forEach(rows, (row) => rowToRuleDocument(row, errorByRule.get(row.id)))
		return new AlertRulesListResponse({ rules })
	})

	const createRule = Effect.fn("AlertRulesService.createRule")(function* (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		request: AlertRuleUpsertRequest,
	) {
		yield* requireAdmin(roles)
		const { normalized, timestamp, txid } = yield* writeRuleRow(orgId, userId, null, request)
		return normalizedRuleToDocument(normalized, {
			notes: normalizeOptionalString(request.notes),
			userId,
			timestamp,
			...(!(txid === undefined) ? { txid } : undefined),
		})
	})

	const deleteRule = Effect.fn("AlertRulesService.deleteRule")(function* (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
		ruleId: AlertRuleDocument["id"],
	) {
		yield* requireAdmin(roles)
		yield* requireRuleRow(orgId, ruleId)
		const deleted = yield* dbExecute((db) =>
			db.transaction(
				Effect.gen(function* () {
					yield* db.run(
						PG.deleteFrom(AlertDeliveryEvents).where(($) => [
							$.orgId.eq(orgId),
							$.ruleId.eq(ruleId),
						]),
					)
					yield* db.run(
						PG.deleteFrom(AlertIncidents).where(($) => [$.orgId.eq(orgId), $.ruleId.eq(ruleId)]),
					)
					yield* db.run(
						PG.deleteFrom(AlertRuleStates).where(($) => [$.orgId.eq(orgId), $.ruleId.eq(ruleId)]),
					)
					yield* db.run(PG.deleteFrom(AlertRuleClaims).where(($) => [$.ruleId.eq(ruleId)]))
					return yield* db.run(
						PG.deleteFrom(AlertRules)
							.where(($) => [$.orgId.eq(orgId), $.id.eq(ruleId)])
							.returning(() => ({ txid: currentTxid })),
					)
				}),
			),
		)
		const txid = readTxid(deleted)
		return new AlertRuleDeleteResponse({
			id: ruleId,
			...(txid !== undefined ? { txid } : undefined),
		})
	})

	return {
		listRules,
		createRule,
		deleteRule,
		requireAdmin,
		normalizeRule,
		normalizeRuleRow,
		requireRuleRow,
		requireDestinationIds,
		upsertRuleRow,
	}
}

export class AlertRulesService extends Context.Service<AlertRulesService, AlertRulesServiceApi>()(
	"@maple/api/services/alerts/AlertRulesService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const runtime = yield* AlertRuntime
			const persistence = makeAlertRulePersistence({ database, runtime })
			return {
				listRules: persistence.listRules,
				createRule: persistence.createRule,
				deleteRule: persistence.deleteRule,
			} satisfies AlertRulesServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
