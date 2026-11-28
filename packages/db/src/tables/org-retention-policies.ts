import * as PG from "@maple-dev/effect-orm/postgres"
import { StoredRetentionOverrides } from "@maple/domain/retention"
import { OrgId, UserId } from "@maple/primitives"

// One row per org that changed its retention; a missing row or signal means the default.
// A source's own override lives on `sources.retention_days`.
export const OrgRetentionPolicies = PG.table("org_retention_policies", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		retentionDays: PG.column(PG.jsonb(StoredRetentionOverrides), {
			name: "retention_days",
			defaultExpr: "'{}'::jsonb",
		}),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		updatedBy: PG.column(PG.nullable(PG.brand(PG.text, UserId)), { name: "updated_by" }),
	},
	primaryKey: ["orgId"],
	tenantColumn: "orgId",
})

export type OrgRetentionPolicyRow = PG.SelectRowOf<typeof OrgRetentionPolicies>
