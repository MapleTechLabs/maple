import * as PG from "@maple-dev/effect-orm/postgres"
import { Schema } from "effect"
import {
	OrgId,
	ScrapeTargetId,
	SourceId,
	SupabaseConnectionId,
	SupabaseProjectId,
	SupabaseProjectRef,
	UserId,
} from "@maple/domain/primitives"
import { Sources } from "./sources"

/**
 * One Supabase organization per Maple org, bound when the Management API OAuth grant is
 * exchanged (Supabase's consent screen grants exactly one organization). The tokens live in
 * `oauth_connections` (provider "supabase"); this row is the discovery lease anchor.
 */
export const SupabaseConnections = PG.table("supabase_connections", {
	columns: {
		id: PG.brand(PG.text, SupabaseConnectionId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		// The source this integration sends as. Deleting the source deletes the row.
		sourceId: PG.column(PG.brand(PG.text, SourceId), { name: "source_id" }),
		/** The granted organization's id; projects are matched to it by `organization_id`. */
		supabaseOrganizationId: PG.column(PG.text, { name: "supabase_organization_id" }),
		supabaseOrganizationSlug: PG.column(PG.text, { name: "supabase_organization_slug" }),
		supabaseOrganizationName: PG.column(PG.text, { name: "supabase_organization_name" }),
		connectedByUserId: PG.column(PG.brand(PG.text, UserId), { name: "connected_by_user_id" }),
		discoveryLeaseUntil: PG.column(PG.nullable(PG.timestamptzMillis), { name: "discovery_lease_until" }),
		lastDiscoveryAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_discovery_at" }),
		lastDiscoveryError: PG.column(PG.nullable(PG.text), { name: "last_discovery_error" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.index("supabase_connections_source_idx", ["sourceId"]),
		PG.uniqueIndex("supabase_connections_org_idx", ["orgId"]),
	],
	foreignKeys: [
		PG.foreignKey({
			columns: ["sourceId"],
			references: Sources,
			foreignColumns: ["id"],
			onDelete: "cascade",
		}),
	],
	tenantColumn: "orgId",
})

export type SupabaseConnectionRow = PG.SelectRowOf<typeof SupabaseConnections>
export type SupabaseConnectionInsert = PG.InsertRowOf<typeof SupabaseConnections>

/**
 * A project discovered under the connected Supabase organization. Discovery stamps `removedAt`
 * on projects that disappear (instead of deleting them) so a returning project keeps its toggles.
 */
export const SupabaseProjects = PG.table("supabase_projects", {
	columns: {
		id: PG.brand(PG.text, SupabaseProjectId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		connectionId: PG.column(PG.brand(PG.text, SupabaseConnectionId), { name: "connection_id" }),
		projectRef: PG.column(PG.brand(PG.text, SupabaseProjectRef), { name: "project_ref" }),
		name: PG.text,
		region: PG.text,
		/** Supabase's lifecycle status (`ACTIVE_HEALTHY`, `INACTIVE`, ...), as reported. */
		status: PG.text,
		metricsEnabled: PG.column(PG.bool, { name: "metrics_enabled", default: true }),
		/** The managed scrape target feeding this project's metrics. */
		scrapeTargetId: PG.column(PG.nullable(PG.brand(PG.text, ScrapeTargetId)), {
			name: "scrape_target_id",
		}),
		logDrainEnabled: PG.column(PG.bool, { name: "log_drain_enabled", default: false }),
		/** Supabase's id for the log drain Maple created on this project. */
		logDrainId: PG.column(PG.nullable(PG.text), { name: "log_drain_id" }),
		/** Opt-in: polled logs count against the org's ingest. */
		logsEnabled: PG.column(PG.bool, { name: "logs_enabled", default: false }),
		/** Logs before this were sent; the next poll reads from here. */
		logsWatermarkAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "logs_watermark_at" }),
		/** Ids already sent within the watermark's millisecond, dropped when the next poll re-reads it. */
		logsBoundaryIds: PG.column(PG.jsonb(Schema.Array(Schema.String)), {
			name: "logs_boundary_ids",
			default: [],
		}),
		logsLeaseUntil: PG.column(PG.nullable(PG.timestamptzMillis), { name: "logs_lease_until" }),
		logsLastPolledAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "logs_last_polled_at" }),
		logsError: PG.column(PG.nullable(PG.text), { name: "logs_error" }),
		lastSeenAt: PG.column(PG.timestamptzMillis, { name: "last_seen_at" }),
		removedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "removed_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("supabase_projects_connection_ref_idx", ["connectionId", "projectRef"]),
		PG.index("supabase_projects_org_idx", ["orgId"]),
	],
	foreignKeys: [
		PG.foreignKey({
			columns: ["connectionId"],
			references: SupabaseConnections,
			foreignColumns: ["id"],
			onDelete: "cascade",
		}),
	],
	tenantColumn: "orgId",
})

export type SupabaseProjectRow = PG.SelectRowOf<typeof SupabaseProjects>
export type SupabaseProjectInsert = PG.InsertRowOf<typeof SupabaseProjects>
