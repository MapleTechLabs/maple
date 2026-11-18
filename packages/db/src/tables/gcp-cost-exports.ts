import * as PG from "@maple-dev/effect-orm/postgres"
import { GcpConnectorId, OrgId, UserId } from "@maple/primitives"
import { GcpConnectors } from "./gcp-connectors"

// A Cloud Billing export to BigQuery an org reads its Google Cloud spend from, through the reader
// account of one of its GCP connectors. One per billing account: a standard and a detailed export
// of one account hold the same spend twice. `cost_sources.connection_ref` holds `id`. Deleting the
// connector deletes the row, and the cost sync then removes its source.
export const GcpCostExports = PG.table("gcp_cost_exports", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		connectorId: PG.column(PG.brand(PG.text, GcpConnectorId), { name: "connector_id" }),
		// `project.dataset.table`, as BigQuery names the export table.
		tableRef: PG.column(PG.text, { name: "table_ref" }),
		// The billing account the table exports, read from its name (`01ABCD-234567-89ABCD`).
		billingAccountId: PG.column(PG.text, { name: "billing_account_id" }),
		createdBy: PG.column(PG.brand(PG.text, UserId), { name: "created_by" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("gcp_cost_exports_org_account_idx", ["orgId", "billingAccountId"]),
		PG.index("gcp_cost_exports_connector_idx", ["connectorId"]),
	],
	foreignKeys: [
		PG.foreignKey({
			columns: ["connectorId"],
			references: GcpConnectors,
			foreignColumns: ["id"],
			onDelete: "cascade",
		}),
	],
	tenantColumn: "orgId",
})

export type GcpCostExportRow = PG.SelectRowOf<typeof GcpCostExports>
