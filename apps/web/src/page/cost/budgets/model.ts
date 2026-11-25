import {
	AlertRuleId,
	CostBudget,
	CostBudgetDeleteResponse,
	CostBudgetListResponse,
	CostSourceSummary,
} from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import { LoadOutcome } from "../../kit/load-schemas"
import { SessionGrants } from "../../kit/session-grants"

// `/cost/budgets`: the org's cost budgets, each a hidden alert rule that measures a slice of spend
// against an amount per period. Every member reads them; `slos:manage` changes them.

export const Model = Schema.Struct({
	grants: Schema.Array(Policy.PermissionName),
	/** False until the session answers: the page offers no write before it knows who may. */
	isGrantsRead: Schema.Boolean,
	/** The list as the API last gave it; a saved toggle or a delete writes the API's answer into it. */
	list: KeyedSchema(CostBudgetListResponse, LoadFailure),
	/** The org's cost sources, which name an account a budget covers; empty until read. */
	sources: Schema.Array(CostSourceSummary),
	/** The budgets whose switch has a save in flight. */
	togglingIds: Schema.Array(AlertRuleId),
	/** The budget the delete dialog asks about. */
	confirmDeleteId: Schema.NullOr(AlertRuleId),
	deletingId: Schema.NullOr(AlertRuleId),
	deleteDialog: Dialog.Model,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	CompletedReadGrants: SessionGrants,
	CompletedFetchBudgets: { key: Schema.String, result: LoadOutcome(CostBudgetListResponse) },
	CompletedFetchSources: { orgId: Schema.String, sources: Schema.Array(CostSourceSummary) },
	ClickedRetry: {},
	ClickedEdit: { id: AlertRuleId },
	ToggledBudget: { id: AlertRuleId },
	CompletedToggle: { id: AlertRuleId, result: LoadOutcome(CostBudget) },
	ClickedDelete: { id: AlertRuleId },
	GotDeleteDialogMessage: { message: Dialog.Message },
	ClickedConfirmDelete: {},
	CompletedDelete: { id: AlertRuleId, result: LoadOutcome(CostBudgetDeleteResponse) },
})
export type Message = typeof Message.Type
