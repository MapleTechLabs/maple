import * as PG from "@maple-dev/effect-orm/postgres"
import { IssueSeverity } from "@maple/domain/http"
import { ErrorIssueId, InvestigationId, IssueEscalationId, OrgId } from "@maple/domain/primitives"
import { Schema } from "effect"

export const IssueEscalationSourceSchema = Schema.Literals(["ai", "manual"])
export const IssueEscalationReasonSchema = Schema.Literals(["severity_set", "severity_escalated"])
export const IssueEscalationStatusSchema = Schema.Literals(["queued", "sent", "skipped", "failed"])

/**
 * Org-level escalation policy: which destinations a triage-outcome severity
 * routes to. Escalations fire only on AI-applied or manual severity changes,
 * never detector-initial severity (detection noise is already covered by alert
 * rule destinations and the error notification policy).
 */
export const IssueEscalationPolicies = PG.table("issue_escalation_policies", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		enabled: PG.column(PG.bool, { default: false }),
		// Array<{ severity: IssueSeverity; destinationIds: string[]; minConfidence?: "low"|"medium"|"high" }>
		rulesJson: PG.column(PG.jsonb(Schema.Array(Schema.Unknown)), { name: "rules_json", default: [] }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		updatedBy: PG.column(PG.text, { name: "updated_by" }),
	},
	primaryKey: ["orgId"],
	tenantColumn: "orgId",
})

export type IssueEscalationPolicyRow = PG.SelectRowOf<typeof IssueEscalationPolicies>

/**
 * Escalation outbox. Writers (the AI triage workflow's persist step, manual
 * severity changes) insert rows; the alerting worker's escalation tick drains
 * them through NotificationDispatcher. The unique dedupeKey
 * (`esc:{orgId}:{issueId}:{severity}`) makes escalation at-most-once per
 * issue+level, and upward-only semantics live in the writers.
 */
export const IssueEscalations = PG.table("issue_escalations", {
	columns: {
		id: PG.brand(PG.text, IssueEscalationId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		issueId: PG.column(PG.brand(PG.text, ErrorIssueId), { name: "issue_id" }),
		severity: PG.brand(PG.text, IssueSeverity),
		source: PG.brand(PG.text, IssueEscalationSourceSchema),
		reason: PG.brand(PG.text, IssueEscalationReasonSchema),
		runId: PG.column(PG.nullable(PG.text), { name: "run_id" }),
		investigationId: PG.column(PG.nullable(PG.brand(PG.text, InvestigationId)), {
			name: "investigation_id",
		}),
		// Triage snapshot captured at enqueue (summary, suspectedCause, ...) so the
		// dispatch payload survives later runs overwriting the run row.
		payloadJson: PG.column(PG.jsonb(), { name: "payload_json", default: {} }),
		deliveryResultsJson: PG.column(PG.jsonb(), { name: "delivery_results_json", default: [] }),
		status: PG.column(PG.brand(PG.text, IssueEscalationStatusSchema), { default: "queued" }),
		attempts: PG.column(PG.int4, { default: 0 }),
		dedupeKey: PG.column(PG.text, { name: "dedupe_key" }),
		error: PG.nullable(PG.text),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		processedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "processed_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("issue_escalations_dedupe_idx", ["dedupeKey"]),
		PG.index("issue_escalations_due_idx", ["status", "createdAt"]),
		PG.index("issue_escalations_org_issue_idx", ["orgId", "issueId"]),
	],
	tenantColumn: "orgId",
})

export type IssueEscalationRow = PG.SelectRowOf<typeof IssueEscalations>
