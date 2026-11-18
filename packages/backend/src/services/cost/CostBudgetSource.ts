import * as PG from "@maple-dev/effect-orm/postgres"
import { CostSources } from "@maple/db/tables"
import {
	type CostBudgetProgress,
	type StoredCostBudget,
	costBudgetPeriodWindow,
	costBudgetProgress,
} from "@maple/domain/cost-budget"
import { CloudCostPersistenceError, type OrgId, type TenantContext } from "@maple/domain/http"
import { Queries } from "@maple/query-engine/registry"
import type { QueryEngineDirectError } from "@maple/query-engine/runtime"
import { Array as Arr, Context, DateTime, Effect, Layer } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { makeQueryRunners } from "@maple/backend/queries/query-runner"
import { QueryEngineService } from "@maple/backend/services/warehouse/QueryEngineService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { utcToday } from "./sync-plan"

type ProgressError = CloudCostPersistenceError | QueryEngineDirectError

/** What a read of a budget's spend needs of it. */
type MeasuredBudget = Pick<StoredCostBudget, "amount" | "currency" | "period" | "metric" | "filters">

export interface CostBudgetSourceApi {
	/** Where each budget stands in the period `nowMs` is in, in the order given. */
	readonly progress: <Budget extends MeasuredBudget>(
		tenant: TenantContext,
		budgets: ReadonlyArray<Budget>,
		nowMs: number,
	) => Effect.Effect<ReadonlyArray<readonly [Budget, CostBudgetProgress]>, ProgressError>
}

const toPersistenceError = makePersistenceErrorMapper(CloudCostPersistenceError, "Cost sources read failed")

/** Budgets read at once; each is one small query over `cost_daily`. */
const PROGRESS_CONCURRENCY = 5

/**
 * What a budget has spent, for the alert evaluator and the budgets API: only the database and
 * the warehouse.
 */
export class CostBudgetSource extends Context.Service<CostBudgetSource, CostBudgetSourceApi>()(
	"@maple/backend/services/cost/CostBudgetSource",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const warehouse = yield* WarehouseQueryService
			const queryEngine = yield* QueryEngineService
			const dbExecute = makeDbExecute(database, "CostBudgetSource", toPersistenceError)
			const { runQuery } = makeQueryRunners({ warehouse, queryEngine })

			/** The org's connected sources: a disconnected one keeps its rows, so every read names them. */
			const sourcesOf = (orgId: OrgId) =>
				dbExecute((db) =>
					db.run(
						PG.from(CostSources)
							.select("id", "updatedAt")
							.where(($) => [$.orgId.eq(orgId)]),
					),
				)

			const progress = Effect.fn("CostBudgetSource.progress")(function* <Budget extends MeasuredBudget>(
				tenant: TenantContext,
				budgets: ReadonlyArray<Budget>,
				nowMs: number,
			) {
				yield* Effect.annotateCurrentSpan({
					orgId: tenant.orgId,
					"maple.cost.budgets": budgets.length,
				})
				if (budgets.length === 0) return []
				const sources = yield* sourcesOf(tenant.orgId)
				// No source, no spend: the budget stands at zero without a read.
				if (sources.length === 0) {
					return Arr.map(
						budgets,
						(budget) => [budget, costBudgetProgress(budget, nowMs, [])] as const,
					)
				}
				const sourceIds = Arr.map(sources, (source) => source.id)
				const written = Arr.reduce(sources, 0, (latest, source) => Math.max(latest, source.updatedAt))
				const today = utcToday(nowMs)
				return yield* Effect.forEach(
					budgets,
					(budget) =>
						runQuery(Queries.costTimeseries, tenant, {
							startTime: `${costBudgetPeriodWindow(budget.period, nowMs).startDay} 00:00:00`,
							endTime: `${today} 00:00:00`,
							metric: budget.metric,
							filters: budget.filters,
							currency: budget.currency,
							sourceIds,
							written,
						}).pipe(
							Effect.map(
								(rows) =>
									[
										budget,
										costBudgetProgress(
											budget,
											nowMs,
											Arr.map(rows, (row) => ({
												day: DateTime.formatIsoDateUtc(row.date),
												cost: row.cost,
											})),
										),
									] as const,
							),
						),
					{ concurrency: PROGRESS_CONCURRENCY },
				)
			})

			return { progress } satisfies CostBudgetSourceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(WarehouseQueryService.layer, QueryEngineService.layer)),
	)
}
