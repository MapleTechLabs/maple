import * as PG from "@maple-dev/effect-orm/postgres"
import { IngestRuleSpec } from "@maple/domain/ingest-rules"
import { IngestRuleId, OrgId } from "@maple/domain/primitives"

/**
 * Customer drop/redact rules. The ingest gateway reads the enabled rows per org
 * (`apps/ingest`, `fetch_ingest_rules`), so `spec_json` is the contract in
 * `@maple/domain/ingest-rules` and must stay readable by its serde types.
 */
export const OrgIngestRules = PG.table("org_ingest_rules", {
	columns: {
		id: PG.brand(PG.text, IngestRuleId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		name: PG.text,
		enabled: PG.column(PG.bool, { default: true }),
		/** Redact rules run in ascending position; drop rules always run first. */
		position: PG.column(PG.int4, { default: 0 }),
		specJson: PG.column(PG.jsonb(IngestRuleSpec), { name: "spec_json" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at", defaultExpr: "now()" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at", defaultExpr: "now()" }),
	},
	primaryKey: ["id"],
	indexes: [PG.index("org_ingest_rules_org_idx", ["orgId"])],
	tenantColumn: "orgId",
})

/** One row per org with rules: the HMAC key `hash` redactions use, created with the first rule. */
export const OrgIngestRuleSettings = PG.table("org_ingest_rule_settings", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		hashSalt: PG.column(PG.text, { name: "hash_salt" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at", defaultExpr: "now()" }),
	},
	primaryKey: ["orgId"],
	tenantColumn: "orgId",
})

export type OrgIngestRuleRow = PG.SelectRowOf<typeof OrgIngestRules>

/**
 * Per-rule hit counts, written by the ingest gateway: every 60s it adds what each
 * rule matched, dropped and redacted into the hour's row (`ON CONFLICT … DO UPDATE`
 * with `+`, so several gateway tasks add up). Read by the settings page and billing.
 */
export const OrgIngestRuleStats = PG.table("org_ingest_rule_stats", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		ruleId: PG.column(PG.brand(PG.text, IngestRuleId), { name: "rule_id" }),
		/** Start of the UTC hour. */
		bucket: PG.timestamptzMillis,
		signal: PG.text,
		matched: PG.column(PG.int8, { default: 0 }),
		dropped: PG.column(PG.int8, { default: 0 }),
		droppedBytes: PG.column(PG.int8, { name: "dropped_bytes", default: 0 }),
		redactedValues: PG.column(PG.int8, { name: "redacted_values", default: 0 }),
	},
	primaryKey: ["orgId", "ruleId", "bucket", "signal"],
	indexes: [PG.index("org_ingest_rule_stats_org_bucket_idx", ["orgId", "bucket"])],
	tenantColumn: "orgId",
})
