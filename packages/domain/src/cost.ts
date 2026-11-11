import { Schema } from "effect"

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
