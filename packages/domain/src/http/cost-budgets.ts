import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Array as Arr, Schema } from "effect"
import { AlertDestinationId, AlertRuleId } from "@maple/primitives"
import { AlertSeverity } from "../alerts"
import { CostCurrency, CostFilters, CostMetric } from "../cost"
import { CostBudgetAmount, CostBudgetBasis, CostBudgetPeriod, CostBudgetProgress } from "../cost-budget"
import { SessionAuthorization } from "./current-tenant"
import { HttpTaggedError } from "./error-policy"
import { CloudCostPersistenceError, costEndpointErrors } from "./query-engine"
import { EndpointAccess, requires } from "./endpoint-access"

// Cost budgets: an amount per calendar period over a slice of the org's spend. Each one is a
// hidden `cost_budget` alert rule, so its incidents and notifications are the alerting ones.
// Dashboard only; writes need `alerts:manage`.

/** Each budget reads the warehouse once an hour and once per list; the cap bounds that per org. */
export const MAX_COST_BUDGETS_PER_ORG = 50

const BudgetName = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(120))
const BudgetPercent = Schema.Number.check(Schema.isFinite(), Schema.isBetween({ minimum: 1, maximum: 1000 }))
const BudgetDestinationIds = Schema.Array(AlertDestinationId).check(Schema.isMaxLength(20))

/** One alert: opens at `percent` of the amount, on spend so far or on the period's forecast. */
export const CostBudgetAlert = Schema.Struct({
	severity: AlertSeverity,
	percent: BudgetPercent,
	basis: CostBudgetBasis,
	destinationIds: BudgetDestinationIds,
})
export type CostBudgetAlert = typeof CostBudgetAlert.Type

/** One alert per severity: a warning, a critical, or both. */
const CostBudgetAlerts = Schema.NonEmptyArray(CostBudgetAlert).check(
	Schema.isMaxLength(2),
	Schema.makeFilter(
		(alerts: ReadonlyArray<CostBudgetAlert>) =>
			Arr.dedupe(Arr.map(alerts, (alert) => alert.severity)).length === alerts.length ||
			"Expected at most one alert per severity",
	),
)

/** What a budget is, apart from its id and when it was written. */
export const CostBudgetDefinition = Schema.Struct({
	name: Schema.String,
	enabled: Schema.Boolean,
	amount: Schema.Number,
	currency: Schema.String,
	period: CostBudgetPeriod,
	metric: CostMetric,
	filters: CostFilters,
	/** Lowest severity first. */
	alerts: Schema.NonEmptyArray(CostBudgetAlert),
})
export type CostBudgetDefinition = typeof CostBudgetDefinition.Type

const CostBudgetFields = {
	id: AlertRuleId,
	...CostBudgetDefinition.fields,
	/** Epoch ms. */
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
} as const

export const CostBudget = Schema.Struct(CostBudgetFields)
export type CostBudget = typeof CostBudget.Type

/** A budget with where it stands in its current period. */
export const CostBudgetStatus = Schema.Struct({ ...CostBudgetFields, progress: CostBudgetProgress })
export type CostBudgetStatus = typeof CostBudgetStatus.Type

export const CostBudgetCreateRequest = Schema.Struct({
	name: BudgetName,
	enabled: Schema.optionalKey(Schema.Boolean),
	amount: CostBudgetAmount,
	currency: CostCurrency,
	period: CostBudgetPeriod,
	/** Defaults to `billed`. */
	metric: Schema.optionalKey(CostMetric),
	/** Absent or empty covers all of the org's spend in the currency. */
	filters: Schema.optionalKey(CostFilters),
	alerts: CostBudgetAlerts,
})
export type CostBudgetCreateRequest = typeof CostBudgetCreateRequest.Type

/** Only the fields sent change. `filters` and `alerts` replace what is stored whole. */
export const CostBudgetUpdateRequest = Schema.Struct({
	name: Schema.optionalKey(BudgetName),
	enabled: Schema.optionalKey(Schema.Boolean),
	amount: Schema.optionalKey(CostBudgetAmount),
	currency: Schema.optionalKey(CostCurrency),
	period: Schema.optionalKey(CostBudgetPeriod),
	metric: Schema.optionalKey(CostMetric),
	filters: Schema.optionalKey(CostFilters),
	alerts: Schema.optionalKey(CostBudgetAlerts),
})
export type CostBudgetUpdateRequest = typeof CostBudgetUpdateRequest.Type

/** Newest first. */
export const CostBudgetListResponse = Schema.Struct({ budgets: Schema.Array(CostBudgetStatus) })
export type CostBudgetListResponse = typeof CostBudgetListResponse.Type

export const CostBudgetDeleteResponse = Schema.Struct({ id: AlertRuleId })
export type CostBudgetDeleteResponse = typeof CostBudgetDeleteResponse.Type

export class CostBudgetForbiddenError extends HttpTaggedError<CostBudgetForbiddenError>()(
	"@maple/http/errors/CostBudgetForbiddenError",
	{ message: Schema.String },
	{
		status: 403,
		code: "cost_budget_forbidden",
		title: "Permission required",
		retry: "never",
		recovery: "request_access",
		exposure: "public_message",
	},
) {}

export class CostBudgetNotFoundError extends HttpTaggedError<CostBudgetNotFoundError>()(
	"@maple/http/errors/CostBudgetNotFoundError",
	{ budgetId: AlertRuleId, message: Schema.String },
	{
		status: 404,
		code: "cost_budget_not_found",
		title: "Budget not found",
		message: "No such budget.",
		param: "id",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

/** An unknown destination, a name another alert rule has, or the per-org cap. */
export class CostBudgetInvalidError extends HttpTaggedError<CostBudgetInvalidError>()(
	"@maple/http/errors/CostBudgetInvalidError",
	{ message: Schema.String },
	{
		status: 400,
		code: "cost_budget_invalid",
		title: "Invalid budget",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

const budgetWriteErrors = [CloudCostPersistenceError, CostBudgetForbiddenError] as const

export class CostBudgetsApiGroup extends HttpApiGroup.make("costBudgets")
	.add(
		// Each budget carries its current spend.
		HttpApiEndpoint.get("list", "/", {
			success: CostBudgetListResponse,
			error: costEndpointErrors,
		}).annotate(EndpointAccess, requires("telemetry:read")),
	)
	.add(
		HttpApiEndpoint.get("get", "/:id", {
			params: { id: AlertRuleId },
			success: CostBudget,
			error: [CloudCostPersistenceError, CostBudgetNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: CostBudgetCreateRequest,
			success: CostBudget,
			error: [...budgetWriteErrors, CostBudgetInvalidError],
		}),
	)
	.add(
		HttpApiEndpoint.patch("update", "/:id", {
			params: { id: AlertRuleId },
			payload: CostBudgetUpdateRequest,
			success: CostBudget,
			error: [...budgetWriteErrors, CostBudgetNotFoundError, CostBudgetInvalidError],
		}),
	)
	.add(
		HttpApiEndpoint.delete("remove", "/:id", {
			params: { id: AlertRuleId },
			success: CostBudgetDeleteResponse,
			error: [CloudCostPersistenceError, CostBudgetForbiddenError, CostBudgetNotFoundError],
		}),
	)
	.prefix("/internal/cost/budgets")
	.middleware(SessionAuthorization)
	.annotate(EndpointAccess, "handler") {}
