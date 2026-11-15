import { CostDimension } from "@maple/domain/cost"
import { CostBudgetBasis, CostBudgetPeriod } from "@maple/domain/cost-budget"
import {
	AlertDestinationId,
	AlertRuleId,
	AlertSeverity,
	CostBudget,
	CostSourceSummary,
} from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { AlertDestinationRowSchema } from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Menu from "@maple/views/ui/menu"
import { CostBudgetNewSearch } from "../../../route/search"
import { LiveRows, LoadOutcome } from "../../kit/load-schemas"
import { canManageAlerts, SessionGrants } from "../../kit/session-grants"
import { CostFacets } from "../message"
import { Form, TextField } from "./form"

// `/cost/budgets/new`: the editor of one cost budget, new or (`?budgetId=`) existing. Whoever
// manages alerts (`alerts:manage`) opens it.

/** What the form offers to pick from: the org's billing currencies and each dimension's largest values. */
export const FormOptions = Schema.Struct({
	/** The currency most of the org's recent cost is in; "" when it has none yet. */
	currency: Schema.String,
	currencies: Schema.Array(Schema.String),
	facets: CostFacets,
	/** The org's cost sources, which name an account by what reads it. */
	sources: Schema.Array(CostSourceSummary),
})
export type FormOptions = typeof FormOptions.Type

export const Model = Schema.Struct({
	search: CostBudgetNewSearch,
	/** The budget being edited; `null` creates. */
	editingId: Schema.NullOr(AlertRuleId),
	/** The URL names a budget that is not an id, or that the org does not have. */
	isMissing: Schema.Boolean,
	/** The edited budget's read; the form fills from it once. */
	existing: KeyedSchema(CostBudget, LoadFailure),
	/** Null until read, and when the read failed. */
	options: Schema.NullOr(FormOptions),
	/** The options read's failure: the form then offers what it holds, and to read again. */
	optionsFailure: Schema.NullOr(LoadFailure),
	form: Form,
	isSaving: Schema.Boolean,
	/** The last save's failure, shown above the action bar in the server's words. */
	saveFailure: Schema.NullOr(LoadFailure),
	destinations: LiveRows(AlertDestinationRowSchema),
	scopeMenu: Menu.Model,
	destinationMenus: Schema.Struct({ warning: Menu.Model, critical: Menu.Model }),
	grants: Schema.Array(Policy.PermissionName),
	/** False until the session answers: the page says nothing about access before it knows. */
	isGrantsRead: Schema.Boolean,
})
export type Model = typeof Model.Type

/**
 * What the session says. An analyst holds no permission at all, so an answer without
 * `alerts:manage` is a refusal, as it is in the SLO and uptime editors.
 */
export const accessOf = (model: Pick<Model, "grants" | "isGrantsRead">): "unknown" | "ask" | "denied" =>
	!model.isGrantsRead ? "unknown" : canManageAlerts(model) ? "ask" : "denied"

/**
 * A new budget waits for the options: until they answer its currency is a guess, and a budget in
 * a currency the org is not billed in measures nothing.
 */
export const isAwaitingOptions = (model: Pick<Model, "editingId" | "options" | "optionsFailure">): boolean =>
	model.editingId === null && model.options === null && model.optionsFailure === null

export const Message = defineMessageUnion({
	CompletedReadGrants: SessionGrants,
	CompletedFetchExisting: { key: Schema.String, result: LoadOutcome(CostBudget) },
	CompletedFetchOptions: { result: LoadOutcome(FormOptions) },
	ClickedRetry: {},
	ClickedRetryOptions: {},
	UpdatedDestinations: { orgId: Schema.String, rows: Schema.Array(AlertDestinationRowSchema) },
	ChangedText: { field: TextField, value: Schema.String },
	PickedCurrency: { currency: Schema.String },
	PickedPeriod: { period: CostBudgetPeriod },
	RemovedScope: { dimension: CostDimension, value: Schema.String },
	GotScopeMenuMessage: { message: Menu.Message },
	ToggledAlert: { severity: AlertSeverity },
	ChangedPercent: { severity: AlertSeverity, value: Schema.String },
	PickedBasis: { severity: AlertSeverity, basis: CostBudgetBasis },
	RemovedDestination: { severity: AlertSeverity, id: AlertDestinationId },
	GotDestinationMenuMessage: { severity: AlertSeverity, message: Menu.Message },
	ToggledEnabled: {},
	ClickedSave: {},
	CompletedSave: { result: LoadOutcome(CostBudget) },
})
export type Message = typeof Message.Type
