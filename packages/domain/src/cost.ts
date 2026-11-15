import { Schema } from "effect"

/**
 * `ChargeCategory` of the zero row the sync writes for a day a pull returned nothing for. It is
 * not a charge: it only gives the day a newer pull version, and every cost read leaves it out.
 */
export const COST_EMPTY_DAY_CATEGORY = "none"

/** Which money column a read sums: what was invoiced, or with upfront commitments spread over their term. */
export const CostMetric = Schema.Literals(["billed", "effective"])
export type CostMetric = typeof CostMetric.Type

/** What a cost read can group and filter by. `service` is the telemetry service a resource resolves to. */
export const CostDimension = Schema.Literals([
	"provider",
	"account",
	"cloud_service",
	"service_category",
	"usage_type",
	"region",
	"resource",
	"service",
])
export type CostDimension = typeof CostDimension.Type

/** Providers Maple reads cost from. One literal per built adapter. */
export const CostProvider = Schema.Literals([
	"aws",
	"openrouter",
	"github",
	"vercel",
	"cloudflare",
	"planetscale",
	"anthropic",
	"openai",
])
export type CostProvider = typeof CostProvider.Type

/** `billed`: the provider reported the money. `estimated`: usage times list price. */
export const CostBasis = Schema.Literals(["billed", "estimated"])
export type CostBasis = typeof CostBasis.Type

/**
 * What kind of charge a row is, after FOCUS `ChargeCategory`. `unknown`: the source does not split
 * charge types, so the row may net credits and purchases into usage.
 */
export const CostChargeCategory = Schema.Literals([
	"usage",
	"purchase",
	"tax",
	"credit",
	"adjustment",
	"unknown",
])
export type CostChargeCategory = typeof CostChargeCategory.Type

/** Values per dimension a cost read may narrow to; the query inlines them, so both sizes are capped. */
export const COST_FILTER_MAX_VALUES = 50
export const COST_FILTER_MAX_VALUE_LENGTH = 300

const CostFilterValues = Schema.Array(
	Schema.String.check(Schema.isMaxLength(COST_FILTER_MAX_VALUE_LENGTH)),
).check(Schema.isMaxLength(COST_FILTER_MAX_VALUES))

/** One optional value list per `CostDimension`; an empty or missing list does not narrow. */
export const CostFilters = Schema.Struct({
	provider: Schema.optionalKey(CostFilterValues),
	account: Schema.optionalKey(CostFilterValues),
	cloud_service: Schema.optionalKey(CostFilterValues),
	service_category: Schema.optionalKey(CostFilterValues),
	usage_type: Schema.optionalKey(CostFilterValues),
	region: Schema.optionalKey(CostFilterValues),
	resource: Schema.optionalKey(CostFilterValues),
	service: Schema.optionalKey(CostFilterValues),
} satisfies Record<CostDimension, Schema.Top>)
export type CostFilters = typeof CostFilters.Type

/** An ISO 4217 code as the providers bill it. The query inlines it, so nothing else gets through. */
export const CostCurrency = Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/u))
