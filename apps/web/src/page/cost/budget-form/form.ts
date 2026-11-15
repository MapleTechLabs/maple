import { CostDimension, CostMetric } from "@maple/domain/cost"
import { CostBudgetBasis, CostBudgetPeriod } from "@maple/domain/cost-budget"
import { AlertDestinationId, AlertSeverity } from "@maple/domain/http"
import { Schema } from "effect"
import { COST_GROUP_BYS } from "../../../route/search"
import { perDimension } from "../derive"

/** The typed inputs, addressed by name from one Message. */
export const TextField = Schema.Literals(["name", "amount"])
export type TextField = typeof TextField.Type

/** One of the budget's two alerts as the form holds it: kept while off, so turning it back on restores it. */
export const AlertForm = Schema.Struct({
	isOn: Schema.Boolean,
	/** As typed: a number only once it is valid. */
	percent: Schema.String,
	basis: CostBudgetBasis,
	destinationIds: Schema.Array(AlertDestinationId),
})
export type AlertForm = typeof AlertForm.Type

/**
 * One value per dimension a budget can be narrowed by. The form offers the Cost page's six; the
 * API also takes the other two, which an edit shows and keeps.
 */
export const perScope = <A>(of: (dimension: CostDimension) => A): Readonly<Record<CostDimension, A>> => ({
	...perDimension(of),
	usage_type: of("usage_type"),
	service: of("service"),
})

export const Form = Schema.Struct({
	name: Schema.String,
	/** As typed: an amount only once it is a positive number. */
	amount: Schema.String,
	currency: Schema.String,
	period: CostBudgetPeriod,
	/** Not offered: a new budget measures billed cost, an edited one keeps what it has. */
	metric: CostMetric,
	/** The slice of spend, one value list per dimension; all empty covers all spend. */
	scope: Schema.Struct(perScope(() => Schema.Array(Schema.String))),
	alerts: Schema.Struct({ warning: AlertForm, critical: AlertForm }),
	enabled: Schema.Boolean,
})
export type Form = typeof Form.Type

export const SEVERITIES = AlertSeverity.literals

/**
 * A new budget: all spend, monthly, a warning when the forecast passes the amount and a critical
 * when the spend does, on, nobody notified yet.
 */
export const emptyForm = (fields: Partial<Form> = {}): Form => ({
	name: "",
	amount: "",
	currency: "USD",
	period: "month",
	metric: "billed",
	scope: perScope(() => []),
	alerts: {
		warning: { isOn: true, percent: "100", basis: "forecast", destinationIds: [] },
		critical: { isOn: true, percent: "100", basis: "actual", destinationIds: [] },
	},
	enabled: true,
	...fields,
})

/** The dimensions a scope can name, in the Cost page's order. */
export const SCOPE_DIMENSIONS = COST_GROUP_BYS
