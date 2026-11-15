import { CostBudgetBasis, CostBudgetPeriod } from "@maple/domain/cost-budget"
import { AlertDestinationId, AlertRuleId, AlertSeverity, CostBudget } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { AlertDestinationRowSchema } from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Menu from "@maple/views/ui/menu"
import { COST_GROUP_BYS, CostBudgetNewSearch } from "../../../route/search"
import { LiveRows, LoadOutcome } from "../../kit/load-schemas"
import { SessionGrants } from "../../kit/session-grants"
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
})
export type FormOptions = typeof FormOptions.Type

const Dimension = Schema.Literals(COST_GROUP_BYS)

export const Model = Schema.Struct({
	search: CostBudgetNewSearch,
	/** The budget being edited; `null` creates. */
	editingId: Schema.NullOr(AlertRuleId),
	/** The URL names a budget that is not an id, or that the org does not have. */
	isMissing: Schema.Boolean,
	/** The edited budget's read; the form fills from it once. */
	existing: KeyedSchema(CostBudget, LoadFailure),
	/** Null until read, and when the read failed: the form then offers what it already holds. */
	options: Schema.NullOr(FormOptions),
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
 * What the session says: `denied` only when it answered and the permission is missing. A session
 * that answered with nothing failed to read, so the form is shown and the API gets the last word.
 */
export const accessOf = (model: Pick<Model, "grants" | "isGrantsRead">): "unknown" | "ask" | "denied" =>
	!model.isGrantsRead
		? "unknown"
		: model.grants.length === 0 || Policy.has(model.grants, "alerts:manage")
			? "ask"
			: "denied"

export const Message = defineMessageUnion({
	CompletedReadGrants: SessionGrants,
	CompletedFetchExisting: { key: Schema.String, result: LoadOutcome(CostBudget) },
	CompletedFetchOptions: { result: LoadOutcome(FormOptions) },
	ClickedRetry: {},
	UpdatedDestinations: { orgId: Schema.String, rows: Schema.Array(AlertDestinationRowSchema) },
	ChangedText: { field: TextField, value: Schema.String },
	PickedCurrency: { currency: Schema.String },
	PickedPeriod: { period: CostBudgetPeriod },
	RemovedScope: { dimension: Dimension, value: Schema.String },
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
