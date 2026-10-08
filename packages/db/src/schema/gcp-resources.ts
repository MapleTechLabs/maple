import type { GcpConnectorId, OrgId } from "@maple/domain"
import { jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core"
import { gcpConnectors } from "./gcp-connectors"

/**
 * What a Google Cloud connector's scope contains, synced from Cloud Asset Inventory: its
 * projects (that is how a folder or organization scope is discovered) and the resources behind
 * the curated metrics, by full resource name (`//run.googleapis.com/projects/p/.../services/s`).
 * A sync replaces the connector's set, so a resource that is gone upstream is gone here;
 * `lastSeenAt` is the sync that last returned the row.
 */
export const gcpResources = pgTable(
	"gcp_resources",
	{
		connectorId: text("connector_id")
			.$type<GcpConnectorId>()
			.notNull()
			.references(() => gcpConnectors.id, { onDelete: "cascade" }),
		orgId: text("org_id").$type<OrgId>().notNull(),
		name: text("name").notNull(),
		assetType: text("asset_type").notNull(),
		projectId: text("project_id").notNull(),
		location: text("location"),
		displayName: text("display_name"),
		state: text("state"),
		labels: jsonb("labels").$type<Record<string, string>>().notNull(),
		resourceCreatedAt: timestamp("resource_created_at", { withTimezone: true, mode: "date" }),
		resourceUpdatedAt: timestamp("resource_updated_at", { withTimezone: true, mode: "date" }),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [primaryKey({ columns: [table.connectorId, table.name] })],
)
