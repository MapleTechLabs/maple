import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { ErrorIssueId, OrgId } from "@maple/domain/primitives"
import type { IssueSeverity } from "@maple/domain/http"

/**
 * Org-level escalation policy: which destinations a triage-outcome severity
 * routes to. Escalations fire only on AI-applied or manual severity changes —
 * never detector-initial severity (detection noise is already covered by alert
 * rule destinations and the error notification policy).
 */
export const issueEscalationPolicies = sqliteTable("issue_escalation_policies", {
	orgId: text("org_id").$type<OrgId>().notNull().primaryKey(),
	enabled: integer("enabled", { mode: "number" }).notNull().default(0),
	// Array<{ severity: IssueSeverity; destinationIds: string[]; minConfidence?: "low"|"medium"|"high" }>
	rulesJson: text("rules_json").notNull().default("[]"),
	updatedAt: integer("updated_at", { mode: "number" }).notNull(),
	updatedBy: text("updated_by").notNull(),
})

export type IssueEscalationPolicyRow = typeof issueEscalationPolicies.$inferSelect

/**
 * Escalation outbox. Writers (the AI triage workflow's persist step, manual
 * severity changes) insert rows; the alerting worker's escalation tick drains
 * them through NotificationDispatcher. The unique dedupeKey
 * (`esc:{orgId}:{issueId}:{severity}`) makes escalation at-most-once per
 * issue+level, and upward-only semantics live in the writers.
 */
export const issueEscalations = sqliteTable(
	"issue_escalations",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		issueId: text("issue_id").$type<ErrorIssueId>().notNull(),
		severity: text("severity").$type<IssueSeverity>().notNull(),
		source: text("source").$type<"ai" | "manual">().notNull(),
		reason: text("reason").$type<"severity_set" | "severity_escalated">().notNull(),
		runId: text("run_id"),
		// Triage snapshot captured at enqueue (summary, suspectedCause, …) so the
		// dispatch payload survives later runs overwriting the run row.
		payloadJson: text("payload_json").notNull().default("{}"),
		status: text("status").$type<"queued" | "sent" | "skipped" | "failed">().notNull().default("queued"),
		attempts: integer("attempts", { mode: "number" }).notNull().default(0),
		dedupeKey: text("dedupe_key").notNull(),
		error: text("error"),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		processedAt: integer("processed_at", { mode: "number" }),
	},
	(table) => [
		uniqueIndex("issue_escalations_dedupe_idx").on(table.dedupeKey),
		index("issue_escalations_due_idx").on(table.status, table.createdAt),
		index("issue_escalations_org_issue_idx").on(table.orgId, table.issueId),
	],
)

export type IssueEscalationRow = typeof issueEscalations.$inferSelect
