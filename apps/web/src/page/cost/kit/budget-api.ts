import type {
	AlertRuleId,
	CostBudgetCreateRequest,
	CostBudgetUpdateRequest,
	CostSourceSummary,
} from "@maple/domain/http"
import { getCostSources } from "@maple/web-data/warehouse/cost"
import { Effect } from "effect"
import { MapleInternalApiClient } from "../../../platform/api-clients"

// The cost budgets on the api Worker. Every member reads them; a write needs `slos:manage` and
// answers `cost_budget_forbidden` without it.

/** Every budget of the org with where it stands, newest first. One read: the API caps an org at 50. */
export const listBudgets = Effect.flatMap(MapleInternalApiClient, (api) => api.costBudgets.list())

export const getBudget = (id: AlertRuleId) =>
	Effect.flatMap(MapleInternalApiClient, (api) => api.costBudgets.get({ params: { id } }))

export const createBudget = (payload: CostBudgetCreateRequest) =>
	Effect.flatMap(MapleInternalApiClient, (api) => api.costBudgets.create({ payload }))

/** Only the fields sent change; the answer is the budget as stored. */
export const updateBudget = (id: AlertRuleId, payload: CostBudgetUpdateRequest) =>
	Effect.flatMap(MapleInternalApiClient, (api) => api.costBudgets.update({ params: { id }, payload }))

/** Deletes the budget's rule, and its incidents with it. */
export const deleteBudget = (id: AlertRuleId) =>
	Effect.flatMap(MapleInternalApiClient, (api) => api.costBudgets.remove({ params: { id } }))

/**
 * The org's cost sources, which name an account by what reads it. None when the read fails: an
 * account then reads as its id.
 */
export const readCostSources = getCostSources().pipe(
	Effect.map((answer) => answer.sources),
	Effect.orElseSucceed((): ReadonlyArray<CostSourceSummary> => []),
)
