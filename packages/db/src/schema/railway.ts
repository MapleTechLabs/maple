import type { OrgId } from "@maple/domain"
import { boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

/**
 * One Railway API token per Maple org (workspace or account token, AES-GCM encrypted).
 * The row is also the poller's lease anchor and holds connection-wide failures.
 */
export const railwayConnections = pgTable(
	"railway_connections",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		tokenCiphertext: text("token_ciphertext").notNull(),
		tokenIv: text("token_iv").notNull(),
		tokenTag: text("token_tag").notNull(),
		/** Comma-joined workspace names the token could see at connect/discovery time. */
		workspaceNames: text("workspace_names"),
		connectedByUserId: text("connected_by_user_id").notNull(),
		/** Set when Railway rejected the token; polling stops until a new token is saved. */
		authFailedAt: timestamp("auth_failed_at", { withTimezone: true, mode: "date" }),
		discoveredAt: timestamp("discovered_at", { withTimezone: true, mode: "date" }),
		leaseUntil: timestamp("lease_until", { withTimezone: true, mode: "date" }),
		lastSuccessAt: timestamp("last_success_at", { withTimezone: true, mode: "date" }),
		lastError: text("last_error"),
		lastErrorAt: timestamp("last_error_at", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [uniqueIndex("railway_connections_org_idx").on(table.orgId)],
)

export type RailwayConnectionRow = typeof railwayConnections.$inferSelect
export type RailwayConnectionInsert = typeof railwayConnections.$inferInsert

/**
 * Poll state per discovered Railway environment: one `metrics` call per environment per tick.
 * Discovery soft-disables environments that disappear so a returning one resumes its watermark.
 */
export const railwayEnvironments = pgTable(
	"railway_environments",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		connectionId: text("connection_id").notNull(),
		projectId: text("project_id").notNull(),
		projectName: text("project_name").notNull(),
		environmentId: text("environment_id").notNull(),
		environmentName: text("environment_name").notNull(),
		/** JSON object of Railway service id → service name, refreshed by discovery. */
		servicesJson: text("services_json").notNull().default("{}"),
		enabled: boolean("enabled").notNull().default(true),
		/** End of the newest fully-ingested sample window. Null until the first poll. */
		watermarkAt: timestamp("watermark_at", { withTimezone: true, mode: "date" }),
		lastSuccessAt: timestamp("last_success_at", { withTimezone: true, mode: "date" }),
		lastError: text("last_error"),
		lastErrorAt: timestamp("last_error_at", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("railway_environments_org_env_idx").on(table.orgId, table.environmentId),
		index("railway_environments_connection_idx").on(table.connectionId),
	],
)

export type RailwayEnvironmentRow = typeof railwayEnvironments.$inferSelect
export type RailwayEnvironmentInsert = typeof railwayEnvironments.$inferInsert
