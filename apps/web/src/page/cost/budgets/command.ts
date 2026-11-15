import { AlertRuleId } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { settleTo } from "@maple/views/data/load-failure"
import { fetchSessionGrants } from "../../kit/session-grants"
import { deleteBudget, listBudgets, readCostSources, updateBudget } from "../kit/budget-api"
import { Message } from "./model"

// The Budgets page's reads and writes.

export const ReadBudgetsGrants = fetchSessionGrants("ReadCostBudgetsGrants", Message.CompletedReadGrants)

export const FetchBudgets = Command.define("FetchCostBudgets", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchBudgets],
	execute: ({ key }) =>
		listBudgets.pipe(settleTo((result) => Message.CompletedFetchBudgets({ key, result }))),
})

/** The sources behind the account names; tagged with the org asked for, so a late answer is dropped. */
export const FetchBudgetSources = Command.define("FetchCostBudgetSources", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedFetchSources],
	execute: ({ orgId }) =>
		Effect.map(readCostSources, (sources) => Message.CompletedFetchSources({ orgId, sources })),
})

/** Turns one budget's alerts on or off; the answer is the budget as the API stored it. */
export const SaveBudgetEnabled = Command.define("SaveCostBudgetEnabled", {
	args: { id: AlertRuleId, enabled: Schema.Boolean },
	messages: [Message.CompletedToggle],
	execute: ({ id, enabled }) =>
		updateBudget(id, { enabled }).pipe(settleTo((result) => Message.CompletedToggle({ id, result }))),
})

export const DeleteBudget = Command.define("DeleteCostBudget", {
	args: { id: AlertRuleId },
	messages: [Message.CompletedDelete],
	execute: ({ id }) => deleteBudget(id).pipe(settleTo((result) => Message.CompletedDelete({ id, result }))),
})
