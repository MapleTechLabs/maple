import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { AiTriageRunId, ErrorIssueId, OrgId, UserId } from "@maple/domain/primitives"
import type { AiTriageIncidentKind, AiTriageRunStatus } from "@maple/domain/http"

/**
 * Per-org AI auto-triage policy. Disabled by default, so an admin must opt in.
 * Triage runs on Maple's managed AI (Cloudflare Workers AI via the chat-flue
 * Flue workflow) — no per-org model or key configuration is needed.
 */
export const aiTriageSettings = sqliteTable("ai_triage_settings", {
	orgId: text("org_id").$type<OrgId>().notNull().primaryKey(),
	enabled: integer("enabled", { mode: "number" }).notNull().default(0),
	maxRunsPerDay: integer("max_runs_per_day", { mode: "number" }).notNull().default(20),
	updatedAt: integer("updated_at", { mode: "number" }).notNull(),
	updatedBy: text("updated_by").$type<UserId>(),
})

/**
 * One AI triage investigation per incident (the unique index enforces it;
 * a re-run resets the existing row back to `queued` with a fresh workflow
 * instance). contextJson is written at enqueue time so the workflow needs no
 * kind-specific joins; resultJson holds the structured AiTriageResult.
 */
export const aiTriageRuns = sqliteTable(
	"ai_triage_runs",
	{
		id: text("id").$type<AiTriageRunId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		incidentKind: text("incident_kind").$type<AiTriageIncidentKind>().notNull(),
		incidentId: text("incident_id").notNull(),
		issueId: text("issue_id").$type<ErrorIssueId>(),
		status: text("status").$type<AiTriageRunStatus>().notNull().default("queued"),
		contextJson: text("context_json").notNull().default("{}"),
		resultJson: text("result_json"),
		model: text("model"),
		inputTokens: integer("input_tokens", { mode: "number" }),
		outputTokens: integer("output_tokens", { mode: "number" }),
		error: text("error"),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		startedAt: integer("started_at", { mode: "number" }),
		completedAt: integer("completed_at", { mode: "number" }),
		updatedAt: integer("updated_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("ai_triage_runs_incident_idx").on(table.orgId, table.incidentKind, table.incidentId),
		index("ai_triage_runs_org_issue_idx").on(table.orgId, table.issueId),
		index("ai_triage_runs_org_created_idx").on(table.orgId, table.createdAt),
	],
)

export type AiTriageSettingsRow = typeof aiTriageSettings.$inferSelect
export type AiTriageRunRow = typeof aiTriageRuns.$inferSelect
export type AiTriageRunInsert = typeof aiTriageRuns.$inferInsert
