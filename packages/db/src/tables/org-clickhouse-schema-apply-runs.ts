import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId } from "@maple/domain/primitives"

/**
 * One in-flight / last schema-apply run per org. The schema-apply Cloudflare
 * Workflow writes progress here as it executes each step (structural DDL +
 * backfill chunks); the dashboard polls it via the apply-schema status endpoint.
 *
 * Single row per org (orgId pk): a new apply overwrites the previous run's
 * progress. Durable migration bookkeeping still lives in ClickHouse's
 * `_maple_schema_migrations`; this table is only the UI-facing progress mirror.
 */
export const OrgClickHouseSchemaApplyRuns = PG.table("org_clickhouse_schema_apply_runs", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		// Cloudflare Workflow instance id (for status()/dedup), null before kickoff.
		workflowInstanceId: PG.column(PG.nullable(PG.text), { name: "workflow_instance_id" }),
		// "queued" | "running" | "succeeded" | "failed"
		status: PG.text,
		// Human-readable current phase, e.g. "migration 4 · backfill service_overview_spans".
		phase: PG.nullable(PG.text),
		// Migration version currently being applied (null when between/!running).
		currentMigration: PG.column(PG.nullable(PG.int4), { name: "current_migration" }),
		stepsTotal: PG.column(PG.nullable(PG.int4), { name: "steps_total" }),
		stepsDone: PG.column(PG.nullable(PG.int4), { name: "steps_done" }),
		// Migration versions applied this run, and skipped-object summary.
		appliedVersions: PG.column(PG.nullable(PG.jsonb()), { name: "applied_versions" }),
		skipped: PG.nullable(PG.jsonb()),
		errorMessage: PG.column(PG.nullable(PG.text), { name: "error_message" }),
		startedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "started_at" }),
		finishedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "finished_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: { columns: ["orgId"], name: "org_clickhouse_schema_apply_runs_org_id_pk" },
	tenantColumn: "orgId",
})

export type OrgClickHouseSchemaApplyRunRow = PG.SelectRowOf<typeof OrgClickHouseSchemaApplyRuns>
export type OrgClickHouseSchemaApplyRunInsert = PG.InsertRowOf<typeof OrgClickHouseSchemaApplyRuns>
