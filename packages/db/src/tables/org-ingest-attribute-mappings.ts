import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId } from "@maple/domain/primitives"

export const OrgIngestAttributeMappings = PG.table("org_ingest_attribute_mappings", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		name: PG.text,
		sourceContext: PG.column(PG.text, { name: "source_context" }),
		sourceKey: PG.column(PG.text, { name: "source_key" }),
		targetKey: PG.column(PG.text, { name: "target_key" }),
		operation: PG.text,
		enabled: PG.column(PG.bool, { default: true }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at", defaultExpr: "now()" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at", defaultExpr: "now()" }),
	},
	primaryKey: ["id"],
	indexes: [PG.index("org_ingest_attribute_mappings_org_idx", ["orgId"])],
	tenantColumn: "orgId",
})

export type OrgIngestAttributeMappingRow = PG.SelectRowOf<typeof OrgIngestAttributeMappings>
export type OrgIngestAttributeMappingInsert = PG.InsertRowOf<typeof OrgIngestAttributeMappings>
