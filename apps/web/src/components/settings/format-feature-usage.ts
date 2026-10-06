import { featureUnit } from "@/lib/billing/spend"
import { formatCount, formatUsage } from "@/lib/billing/usage"

/** A billable feature's volume in its own unit: bytes for GB features, a count otherwise. */
export const formatFeatureUsage = (featureId: string, value: number): string =>
	featureUnit(featureId) === "GB" ? formatUsage(value) : formatCount(value)
