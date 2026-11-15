import { randomUUID } from "node:crypto"
import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb } from "@maple/db/client"
import { AlertDestinations, AlertRuleClaims, AlertRules } from "@maple/db/tables"
import {
	CloudCostPersistenceError,
	type CostBudget,
	type CostBudgetAlert,
	type CostBudgetCreateRequest,
	CostBudgetDefinition,
	CostBudgetInvalidError,
	CostBudgetNotFoundError,
	type CostBudgetStatus,
	type CostBudgetUpdateRequest,
	MAX_COST_BUDGETS_PER_ORG,
	type TenantContext,
} from "@maple/domain/http"
import { type AlertDestinationId, AlertRuleId, type OrgId, type UserId } from "@maple/primitives"
import type { QueryEngineDirectError } from "@maple/query-engine/runtime"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Order, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { deleteRuleRows } from "@maple/backend/services/alerts/AlertRulesService"
import { lockOrgAlertRules } from "@maple/backend/services/alerts/alert-persistence"
import { CostBudgetSource } from "./CostBudgetSource"
import { costBudgetFromRow, costBudgetRuleFields } from "./cost-budget-rule"

type BudgetReadError = CostBudgetNotFoundError | CloudCostPersistenceError

export interface CostBudgetsServiceApi {
	/** One org's budgets with where each stands in its current period, newest first. */
	readonly list: (
		tenant: TenantContext,
	) => Effect.Effect<ReadonlyArray<CostBudgetStatus>, CloudCostPersistenceError | QueryEngineDirectError>
	readonly get: (orgId: OrgId, id: AlertRuleId) => Effect.Effect<CostBudget, BudgetReadError>
	readonly create: (
		orgId: OrgId,
		input: CostBudgetCreateRequest,
		createdBy: UserId,
	) => Effect.Effect<CostBudget, CostBudgetInvalidError | CloudCostPersistenceError>
	readonly update: (
		orgId: OrgId,
		id: AlertRuleId,
		input: CostBudgetUpdateRequest,
		updatedBy: UserId,
	) => Effect.Effect<CostBudget, BudgetReadError | CostBudgetInvalidError>
	/** Deletes the rule with its state, incidents and deliveries, open incidents included. */
	readonly remove: (orgId: OrgId, id: AlertRuleId) => Effect.Effect<AlertRuleId, BudgetReadError>
}

const toPersistenceError = makePersistenceErrorMapper(
	CloudCostPersistenceError,
	"Cost budget persistence failed",
)

const invalid = (message: string) => new CostBudgetInvalidError({ message })
const notFound = (budgetId: AlertRuleId) =>
	new CostBudgetNotFoundError({ budgetId, message: "Budget not found" })
const unreadable = () => new CloudCostPersistenceError({ message: "The stored budget cannot be read" })

/** The columns a budget reads back from; add a `where` to it. */
const selectBudgets = () =>
	PG.from(AlertRules).select(($) => ({
		id: $.id,
		name: $.name,
		enabled: $.enabled,
		costBudgetJson: PG.undecoded($.costBudgetJson),
		thresholdsJson: PG.undecoded($.thresholdsJson),
		createdAt: $.createdAt,
		updatedAt: $.updatedAt,
	}))

const selectBudget = (orgId: OrgId, id: AlertRuleId) =>
	selectBudgets()
		.where(($) => [$.orgId.eq(orgId), $.id.eq(id), $.signalType.eq("cost_budget")])
		.limit(1)

const sameDefinition = Schema.toEquivalence(CostBudgetDefinition)

const warningFirst: Order.Order<CostBudgetAlert> = Order.mapInput(Order.Number, (alert) =>
	alert.severity === "warning" ? 0 : 1,
)

/** Alerts as a budget reads back: lowest severity first, each one's destinations deduped. */
const normalizeAlerts = (alerts: Arr.NonEmptyReadonlyArray<CostBudgetAlert>) =>
	Arr.sort(
		Arr.map(alerts, (alert) => ({ ...alert, destinationIds: Arr.dedupe(alert.destinationIds) })),
		warningFirst,
	)

/** Checks a budget write: its destinations exist and its name is free among alert rules. */
const claimRuleWrite = Effect.fnUntraced(function* (
	db: MapleDb,
	orgId: OrgId,
	ruleId: AlertRuleId,
	rule: CostBudgetDefinition,
) {
	const destinationIds: ReadonlyArray<AlertDestinationId> = Arr.dedupe(
		Arr.flatMap(rule.alerts, (alert) => alert.destinationIds),
	)
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
	// Alert rule names are unique per org, across every kind of rule.
	const sameName = yield* db.run(
		PG.from(AlertRules)
			.select("id")
			.where(($) => [$.orgId.eq(orgId), $.name.eq(rule.name), $.id.neq(ruleId)])
			.limit(1),
	)
	if (sameName.length > 0) {
		return yield* invalid(`A budget or alert rule named '${rule.name}' already exists; pick another name`)
	}
})

/** The budget as its row holds it; on a write's transaction, what that write stored. */
const readStored = Effect.fnUntraced(function* (db: MapleDb, orgId: OrgId, id: AlertRuleId) {
	const rows = yield* db.run(selectBudget(orgId, id))
	const row = rows[0]
	if (row === undefined) return yield* notFound(id)
	const budget = costBudgetFromRow(row)
	if (Option.isNone(budget)) return yield* unreadable()
	return budget.value
})

/** Cost budgets: each one is a hidden `cost_budget` alert rule, written only from here. */
export class CostBudgetsService extends Context.Service<CostBudgetsService, CostBudgetsServiceApi>()(
	"@maple/backend/services/cost/CostBudgetsService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const source = yield* CostBudgetSource
			const dbExecute = makeDbExecute(database, "CostBudgetsService", toPersistenceError)

			const selectOne = (orgId: OrgId, id: AlertRuleId) => dbExecute((db) => readStored(db, orgId, id))

			const list = Effect.fn("CostBudgetsService.list")(function* (tenant: TenantContext) {
				yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
				const rows = yield* dbExecute((db) =>
					db.run(
						selectBudgets()
							.where(($) => [$.orgId.eq(tenant.orgId), $.signalType.eq("cost_budget")])
							.orderBy(["createdAt", "desc"], ["id", "desc"]),
					),
				)
				// A row this build cannot read is left out, so the rest of the list still shows.
				const budgets = Arr.getSomes(Arr.map(rows, costBudgetFromRow))
				const now = yield* Clock.currentTimeMillis
				const standing = yield* source.progress(tenant, budgets, now)
				return Arr.map(standing, ([budget, progress]) => ({ ...budget, progress }))
			})

			const get = Effect.fn("CostBudgetsService.get")(function* (orgId: OrgId, id: AlertRuleId) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.alert.rule_id": id })
				return yield* selectOne(orgId, id)
			})

			const create = Effect.fn("CostBudgetsService.create")(function* (
				orgId: OrgId,
				input: CostBudgetCreateRequest,
				createdBy: UserId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const now = yield* Clock.currentTimeMillis
				const id = AlertRuleId.make(randomUUID())
				const rule: CostBudgetDefinition = {
					name: input.name,
					enabled: input.enabled ?? true,
					amount: input.amount,
					currency: input.currency,
					period: input.period,
					metric: input.metric ?? "billed",
					filters: input.filters ?? {},
					alerts: normalizeAlerts(input.alerts),
				}
				// Read back before commit: a delete that lands right after cannot turn the answer
				// into a 404 for a budget that was created.
				return yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* lockOrgAlertRules(db, orgId)
							const [existing] = yield* db.run(
								PG.from(AlertRules)
									.select(() => ({ count: PG.count() }))
									.where(($) => [$.orgId.eq(orgId), $.signalType.eq("cost_budget")]),
							)
							if (Number(existing?.count ?? 0) >= MAX_COST_BUDGETS_PER_ORG) {
								return yield* invalid(
									`An organization can have at most ${MAX_COST_BUDGETS_PER_ORG} budgets`,
								)
							}
							yield* claimRuleWrite(db, orgId, id, rule)
							yield* db.run(
								PG.insertInto(AlertRules).values({
									id,
									orgId,
									...costBudgetRuleFields(rule),
									lastScheduledAt: null,
									createdAt: now,
									updatedAt: now,
									createdBy,
									updatedBy: createdBy,
								}),
							)
							return yield* readStored(db, orgId, id)
						}),
					),
				).pipe(
					Effect.catchTag("@maple/http/errors/CostBudgetNotFoundError", () =>
						Effect.fail(new CloudCostPersistenceError({ message: "Created budget not found" })),
					),
				)
			})

			const update = Effect.fn("CostBudgetsService.update")(function* (
				orgId: OrgId,
				id: AlertRuleId,
				input: CostBudgetUpdateRequest,
				updatedBy: UserId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.alert.rule_id": id })
				const now = yield* Clock.currentTimeMillis
				return yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							// Lock, then re-read: the rule is rebuilt from a row no other write changes
							// before commit, and a concurrent delete either finished first or waits.
							yield* lockOrgAlertRules(db, orgId)
							const rows = yield* db.run(selectBudget(orgId, id))
							const row = rows[0]
							if (row === undefined) return yield* notFound(id)
							const stored = costBudgetFromRow(row)
							if (Option.isNone(stored)) return yield* unreadable()
							const locked = stored.value
							const rule: CostBudgetDefinition = {
								name: input.name ?? locked.name,
								enabled: input.enabled ?? locked.enabled,
								amount: input.amount ?? locked.amount,
								currency: input.currency ?? locked.currency,
								period: input.period ?? locked.period,
								metric: input.metric ?? locked.metric,
								filters: input.filters ?? locked.filters,
								alerts:
									input.alerts === undefined
										? locked.alerts
										: normalizeAlerts(input.alerts),
							}
							// The rule is written only when it changes: alert_rules is synced to browsers.
							if (sameDefinition(rule, locked)) return locked
							yield* claimRuleWrite(db, orgId, id, rule)
							// Ends a tick's claim on the old config, as a rule edit does.
							yield* db.run(PG.deleteFrom(AlertRuleClaims).where(($) => [$.ruleId.eq(id)]))
							yield* db.run(
								PG.update(AlertRules)
									.set({ ...costBudgetRuleFields(rule), updatedAt: now, updatedBy })
									.where(($) => [$.orgId.eq(orgId), $.id.eq(id)]),
							)
							// The answer is what this write stored, read before the lock is released.
							return yield* readStored(db, orgId, id)
						}),
					),
				)
			})

			const remove = Effect.fn("CostBudgetsService.remove")(function* (orgId: OrgId, id: AlertRuleId) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.alert.rule_id": id })
				yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* lockOrgAlertRules(db, orgId)
							// Only a budget's rule: another kind of rule is deleted through its owner.
							const rows = yield* db.run(
								PG.from(AlertRules)
									.select("id")
									.where(($) => [
										$.orgId.eq(orgId),
										$.id.eq(id),
										$.signalType.eq("cost_budget"),
									])
									.limit(1),
							)
							if (rows.length === 0) return yield* notFound(id)
							// The rule delete's own cascade: state, deliveries and incidents go with it.
							yield* deleteRuleRows(db, orgId, id)
						}),
					),
				)
				return id
			})

			return { list, get, create, update, remove } satisfies CostBudgetsServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(CostBudgetSource.layer))
}
