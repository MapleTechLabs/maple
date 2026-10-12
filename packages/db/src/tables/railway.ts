import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId } from "@maple/domain/primitives"

/**
 * One Railway API token per Maple org (workspace or account token, AES-GCM encrypted).
 * The row is also the poller's lease anchor and holds connection-wide failures.
 */
export const RailwayConnections = PG.table("railway_connections", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		tokenCiphertext: PG.column(PG.text, { name: "token_ciphertext" }),
		tokenIv: PG.column(PG.text, { name: "token_iv" }),
		tokenTag: PG.column(PG.text, { name: "token_tag" }),
		/** Comma-joined workspace names the token could see at connect/discovery time. */
		workspaceNames: PG.column(PG.nullable(PG.text), { name: "workspace_names" }),
		connectedByUserId: PG.column(PG.text, { name: "connected_by_user_id" }),
		/** Set when Railway rejected the token; polling stops until a new token is saved. */
		authFailedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "auth_failed_at" }),
		discoveredAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "discovered_at" }),
		leaseUntil: PG.column(PG.nullable(PG.timestamptzMillis), { name: "lease_until" }),
		lastSuccessAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_success_at" }),
		lastError: PG.column(PG.nullable(PG.text), { name: "last_error" }),
		lastErrorAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_error_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [PG.uniqueIndex("railway_connections_org_idx", ["orgId"])],
	tenantColumn: "orgId",
})

export type RailwayConnectionRow = PG.SelectRowOf<typeof RailwayConnections>
export type RailwayConnectionInsert = PG.InsertRowOf<typeof RailwayConnections>

/**
 * Poll state per discovered Railway environment: one `metrics` call per environment per tick.
 * Discovery soft-disables environments that disappear so a returning one resumes its watermark.
 */
export const RailwayEnvironments = PG.table("railway_environments", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		connectionId: PG.column(PG.text, { name: "connection_id" }),
		projectId: PG.column(PG.text, { name: "project_id" }),
		projectName: PG.column(PG.text, { name: "project_name" }),
		environmentId: PG.column(PG.text, { name: "environment_id" }),
		environmentName: PG.column(PG.text, { name: "environment_name" }),
		/** JSON object of Railway service id → service name, refreshed by discovery. */
		servicesJson: PG.column(PG.text, { name: "services_json", default: "{}" }),
		enabled: PG.column(PG.bool, { default: true }),
		/** End of the newest fully-ingested sample window. Null until the first poll. */
		watermarkAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "watermark_at" }),
		lastSuccessAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_success_at" }),
		lastError: PG.column(PG.nullable(PG.text), { name: "last_error" }),
		lastErrorAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_error_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("railway_environments_org_env_idx", ["orgId", "environmentId"]),
		PG.index("railway_environments_connection_idx", ["connectionId"]),
	],
	tenantColumn: "orgId",
})

export type RailwayEnvironmentRow = PG.SelectRowOf<typeof RailwayEnvironments>
export type RailwayEnvironmentInsert = PG.InsertRowOf<typeof RailwayEnvironments>
