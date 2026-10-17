import * as PG from "@maple-dev/effect-orm/postgres"
import { GcpCloudSqlSettings } from "@maple/domain/http"
import { GcpConnectorId, OrgId } from "@maple/domain/primitives"
import { Schema } from "effect"
import { GcpConnectors } from "./gcp-connectors"

/**
 * What a Google Cloud connector's scope contains, synced from Cloud Asset Inventory: its
 * projects (that is how a folder or organization scope is discovered) and the resources behind
 * the curated metrics, by full resource name (`//run.googleapis.com/projects/p/.../services/s`).
 * A sync replaces the connector's set, so a resource that is gone upstream is gone here;
 * `lastSeenAt` is the sync that last returned the row. `details` holds what the search does not
 * answer: a Cloud SQL instance's settings, from a listing of the instances themselves.
 */
export const GcpResources = PG.table("gcp_resources", {
	columns: {
		connectorId: PG.column(PG.brand(PG.text, GcpConnectorId), { name: "connector_id" }),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		name: PG.text,
		assetType: PG.column(PG.text, { name: "asset_type" }),
		projectId: PG.column(PG.text, { name: "project_id" }),
		location: PG.nullable(PG.text),
		displayName: PG.column(PG.nullable(PG.text), { name: "display_name" }),
		state: PG.nullable(PG.text),
		labels: PG.jsonb(Schema.Record(Schema.String, Schema.String)),
		details: PG.nullable(PG.jsonb(GcpCloudSqlSettings)),
		resourceCreatedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "resource_created_at" }),
		resourceUpdatedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "resource_updated_at" }),
		lastSeenAt: PG.column(PG.timestamptzMillis, { name: "last_seen_at" }),
	},
	primaryKey: ["connectorId", "name"],
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

export type GcpResourceRow = PG.SelectRowOf<typeof GcpResources>
