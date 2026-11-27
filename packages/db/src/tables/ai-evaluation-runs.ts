import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId } from "@maple/primitives"
import { Schema } from "effect"

/** The scorers Maple runs on an org's agent sessions. */
export const AiEvaluationScorerSchema = Schema.Literals(["session_checks"])
export type AiEvaluationScorer = typeof AiEvaluationScorerSchema.Type

// One row per (org, scorer) Maple scores sessions for: the row enrolls the org, and carries how far
// scoring has got. Sessions whose last span is at or before `cursorAt` have been scored.
export const AiEvaluationRuns = PG.table("ai_evaluation_runs", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		scorer: PG.brand(PG.text, AiEvaluationScorerSchema),
		cursorAt: PG.column(PG.timestamptzMillis, { name: "cursor_at" }),
		lastRunAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_run_at" }),
		lastError: PG.column(PG.nullable(PG.text), { name: "last_error" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
	},
	primaryKey: ["orgId", "scorer"],
	tenantColumn: "orgId",
})

export type AiEvaluationRunRow = PG.SelectRowOf<typeof AiEvaluationRuns>
