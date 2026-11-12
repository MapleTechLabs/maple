import type { AuditTrailCategory, AuditTrailOutcome, AuditTrailProvider } from "@maple/domain/audit-trail"
import { Option, Record as Rec } from "effect"

// The names of audit platforms, categories and outcomes, shared by the audit log and the
// detections that count its events. A value this build does not know shows as itself.

export const PROVIDER_LABEL = {
	maple: "Maple",
	vercel: "Vercel",
	gcp: "Google Cloud",
} satisfies Record<AuditTrailProvider, string>

export const CATEGORY_LABEL = {
	authentication: "Authentication",
	membership: "Membership",
	permission: "Permissions",
	credential: "Credentials",
	configuration: "Configuration",
	resource: "Resources",
	data_access: "Data access",
	billing: "Billing",
	other: "Other",
} satisfies Record<AuditTrailCategory, string>

export const OUTCOME_LABEL = {
	success: "Succeeded",
	failure: "Failed",
	denied: "Denied",
	unknown: "Unknown",
} satisfies Record<AuditTrailOutcome, string>

/** The outcomes worth filtering by. `unknown` is a platform that did not say, not something to look for. */
export const OUTCOME_FILTERS = [
	"success",
	"failure",
	"denied",
] as const satisfies ReadonlyArray<AuditTrailOutcome>

/** The label for `value`, or the value itself when this build has no name for it. */
export const labelIn = (labels: Readonly<Record<string, string>>, value: string): string =>
	Option.getOrElse(Rec.get(labels, value), () => value)

export const providerLabel = (provider: string): string => labelIn(PROVIDER_LABEL, provider)
export const categoryLabel = (category: string): string => labelIn(CATEGORY_LABEL, category)
export const outcomeLabel = (outcome: string): string => labelIn(OUTCOME_LABEL, outcome)
