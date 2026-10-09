import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId } from "@maple/domain/primitives"

export const OrgIngestSamplingPolicies = PG.table("org_ingest_sampling_policies", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		traceSampleRatio: PG.column(PG.float8, { name: "trace_sample_ratio", default: 1 }),
		alwaysKeepErrorSpans: PG.column(PG.bool, { name: "always_keep_error_spans", default: true }),
		alwaysKeepSlowSpansMs: PG.column(PG.nullable(PG.int4), { name: "always_keep_slow_spans_ms" }),
		// Ingest parses string log attributes holding a JSON object into dotted keys.
		expandJsonLogAttributes: PG.column(PG.bool, { name: "expand_json_log_attributes", default: false }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at", defaultExpr: "now()" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at", defaultExpr: "now()" }),
	},
	primaryKey: ["orgId"],
	tenantColumn: "orgId",
})

export type OrgIngestSamplingPolicyRow = PG.SelectRowOf<typeof OrgIngestSamplingPolicies>
export type OrgIngestSamplingPolicyInsert = PG.InsertRowOf<typeof OrgIngestSamplingPolicies>
