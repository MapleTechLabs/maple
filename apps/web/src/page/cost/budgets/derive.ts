import type { AlertRuleId, CostBudgetStatus } from "@maple/domain/http"
import { Array as Arr, Option } from "effect"
import { AsyncData } from "foldkit"
import type { Model } from "./model"

/** The budgets on screen, newest first; null until the list answers. */
export const budgetsOf = (model: Pick<Model, "list">): ReadonlyArray<CostBudgetStatus> | null =>
	AsyncData.matchData(model.list.data, {
		onEmpty: () => null,
		onFailure: () => null,
		onData: (page) => page.budgets,
	})

export const budgetById = (
	model: Pick<Model, "list">,
	id: AlertRuleId | null,
): Option.Option<CostBudgetStatus> => Arr.findFirst(budgetsOf(model) ?? [], (budget) => budget.id === id)

/** Whether any alert of the budget tells someone: with none, its incidents open unannounced. */
export const notifiesSomeone = (budget: CostBudgetStatus): boolean =>
	Arr.some(budget.alerts, (alert) => alert.destinationIds.length > 0)
