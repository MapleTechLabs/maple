// The setup audit's report as it crosses the wire. The checks that produce it live in
// `@maple/backend/services/org/setup-audit`.

import { Schema } from "effect"
import { HttpTaggedError } from "./http/error-policy"

export class SetupAuditUnavailableError extends HttpTaggedError<SetupAuditUnavailableError>()(
	"@maple/http/errors/SetupAuditUnavailableError",
	{
		message: Schema.String,
		operation: Schema.String,
		cause: Schema.Defect(),
	},
	{
		status: 503,
		code: "setup_audit_unavailable",
		title: "Setup audit is temporarily unavailable",
		message: "The setup audit is temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export const AUDIT_SEVERITIES = ["critical", "warn", "info"] as const
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number]

export const AUDIT_STATUSES = ["pass", "fail", "skip"] as const
export type AuditStatus = (typeof AUDIT_STATUSES)[number]

export const AUDIT_CATEGORIES = [
	"alerting",
	"notifications",
	"ingestion",
	"attributes",
	"traces",
	"integrations",
	"data_platform",
] as const
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number]

export const AUDIT_AFFECTED_KINDS = [
	"service",
	"alert_rule",
	"alert_destination",
	"attribute_mapping",
	"scrape_target",
	"repository",
	"integration",
	"attribute_key",
] as const

/** A concrete thing a finding points at, so the UI can chip it and deep-link to its editor. */
export interface AuditAffectedEntity {
	readonly kind: (typeof AUDIT_AFFECTED_KINDS)[number]
	/** Internal id when the entity has one; encoded to a public id at the wire boundary. */
	readonly id?: string
	readonly name: string
	/** Per-entity evidence, e.g. `last error: timeout after 5s`. */
	readonly note?: string
}

export interface AuditCheckResult {
	readonly id: string
	readonly category: AuditCategory
	readonly title: string
	readonly severity: AuditSeverity
	readonly status: AuditStatus
	readonly detail: string | null
	readonly affected: ReadonlyArray<AuditAffectedEntity>
	readonly affectedCount: number
	readonly fixHint: string
}

export interface SetupAuditSummary {
	readonly critical: number
	readonly warn: number
	readonly info: number
	readonly pass: number
	readonly skip: number
}

export interface SetupAuditReport {
	readonly generatedAt: number
	/** `no_data` short-circuits the whole report — see `runSetupAudit`. */
	readonly dataStatus: "ok" | "no_data"
	readonly warehouseAvailable: boolean
	readonly summary: SetupAuditSummary
	readonly checks: ReadonlyArray<AuditCheckResult>
	readonly openRecommendationCount: number
}
