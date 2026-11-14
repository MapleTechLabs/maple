import * as PG from "@maple-dev/effect-orm/postgres"
import { VercelDrainState, VercelProjectScope } from "@maple/domain/http"
import { OrgId, SourceId } from "@maple/primitives"
import { Schema } from "effect"
import { Sources } from "./sources"

/**
 * One Vercel team per Maple org: the AES-GCM encrypted access token, the drains Maple created on
 * the team, and what they forward. The row is also the poller's lease anchor.
 */
export const VercelConnections = PG.table("vercel_connections", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		// The source the drains send as. Deleting the source deletes the row.
		sourceId: PG.column(PG.brand(PG.text, SourceId), { name: "source_id" }),
		teamId: PG.column(PG.text, { name: "team_id" }),
		teamSlug: PG.column(PG.text, { name: "team_slug" }),
		teamName: PG.column(PG.text, { name: "team_name" }),
		tokenCiphertext: PG.column(PG.text, { name: "token_ciphertext" }),
		tokenIv: PG.column(PG.text, { name: "token_iv" }),
		tokenTag: PG.column(PG.text, { name: "token_tag" }),
		connectedByUserId: PG.column(PG.text, { name: "connected_by_user_id" }),
		projectScope: PG.column(PG.brand(PG.text, VercelProjectScope), { name: "project_scope" }),
		projectIds: PG.column(PG.jsonb(Schema.Array(Schema.String)), { name: "project_ids", default: [] }),
		samplingRate: PG.column(PG.float8, { name: "sampling_rate", default: 1 }),
		logsEnabled: PG.column(PG.bool, { name: "logs_enabled", default: true }),
		tracesEnabled: PG.column(PG.bool, { name: "traces_enabled", default: true }),
		aiGatewayEnabled: PG.column(PG.bool, { name: "ai_gateway_enabled", default: true }),
		// Opt-in: Vercel bills these events, and Speed Insights and Audit Log need a plan the team may lack.
		speedInsightsEnabled: PG.column(PG.bool, { name: "speed_insights_enabled", default: false }),
		webAnalyticsEnabled: PG.column(PG.bool, { name: "web_analytics_enabled", default: false }),
		auditLogEnabled: PG.column(PG.bool, { name: "audit_log_enabled", default: false }),
		logDrainId: PG.column(PG.nullable(PG.text), { name: "log_drain_id" }),
		traceDrainId: PG.column(PG.nullable(PG.text), { name: "trace_drain_id" }),
		aiGatewayDrainId: PG.column(PG.nullable(PG.text), { name: "ai_gateway_drain_id" }),
		speedInsightsDrainId: PG.column(PG.nullable(PG.text), { name: "speed_insights_drain_id" }),
		webAnalyticsDrainId: PG.column(PG.nullable(PG.text), { name: "web_analytics_drain_id" }),
		auditLogDrainId: PG.column(PG.nullable(PG.text), { name: "audit_log_drain_id" }),
		/** What the last check of each drain found; null until one ran. */
		logDrainState: PG.column(PG.nullable(PG.jsonb(VercelDrainState)), { name: "log_drain_state" }),
		traceDrainState: PG.column(PG.nullable(PG.jsonb(VercelDrainState)), { name: "trace_drain_state" }),
		aiGatewayDrainState: PG.column(PG.nullable(PG.jsonb(VercelDrainState)), {
			name: "ai_gateway_drain_state",
		}),
		speedInsightsDrainState: PG.column(PG.nullable(PG.jsonb(VercelDrainState)), {
			name: "speed_insights_drain_state",
		}),
		webAnalyticsDrainState: PG.column(PG.nullable(PG.jsonb(VercelDrainState)), {
			name: "web_analytics_drain_state",
		}),
		auditLogDrainState: PG.column(PG.nullable(PG.jsonb(VercelDrainState)), {
			name: "audit_log_drain_state",
		}),
		/** Lookup hash of the ingest key in the drains' Authorization header; a mismatch re-keys them. */
		drainKeyHash: PG.column(PG.nullable(PG.text), { name: "drain_key_hash" }),
		/** Set when Vercel rejected the token; polling stops until a new token is saved. */
		authFailedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "auth_failed_at" }),
		discoveredAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "discovered_at" }),
		/** Creation time of the newest deployment read; the next read starts a little before it. */
		deploymentsWatermarkAt: PG.column(PG.nullable(PG.timestamptzMillis), {
			name: "deployments_watermark_at",
		}),
		leaseUntil: PG.column(PG.nullable(PG.timestamptzMillis), { name: "lease_until" }),
		// A failed poll's back-off (a rate limit): no tick claims the row before then.
		holdUntil: PG.column(PG.nullable(PG.timestamptzMillis), { name: "hold_until" }),
		lastSuccessAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_success_at" }),
		lastError: PG.column(PG.nullable(PG.text), { name: "last_error" }),
		lastErrorAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_error_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.index("vercel_connections_source_idx", ["sourceId"]),
		PG.uniqueIndex("vercel_connections_org_idx", ["orgId"]),
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

export type VercelConnectionRow = PG.SelectRowOf<typeof VercelConnections>

/** The team's projects, refreshed hourly by discovery; a project gone upstream is deleted. */
export const VercelProjects = PG.table("vercel_projects", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		connectionId: PG.column(PG.text, { name: "connection_id" }),
		projectId: PG.column(PG.text, { name: "project_id" }),
		name: PG.text,
		framework: PG.nullable(PG.text),
		productionDeploymentId: PG.column(PG.nullable(PG.text), { name: "production_deployment_id" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [PG.uniqueIndex("vercel_projects_org_project_idx", ["orgId", "projectId"])],
	tenantColumn: "orgId",
})

export type VercelProjectRow = PG.SelectRowOf<typeof VercelProjects>

/** Recent deployments, the newest 50 per project. */
export const VercelDeployments = PG.table("vercel_deployments", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		connectionId: PG.column(PG.text, { name: "connection_id" }),
		projectId: PG.column(PG.text, { name: "project_id" }),
		deploymentId: PG.column(PG.text, { name: "deployment_id" }),
		url: PG.text,
		target: PG.nullable(PG.text),
		state: PG.text,
		branch: PG.nullable(PG.text),
		commitSha: PG.column(PG.nullable(PG.text), { name: "commit_sha" }),
		commitMessage: PG.column(PG.nullable(PG.text), { name: "commit_message" }),
		creator: PG.nullable(PG.text),
		errorCode: PG.column(PG.nullable(PG.text), { name: "error_code" }),
		errorMessage: PG.column(PG.nullable(PG.text), { name: "error_message" }),
		createdAtVercel: PG.column(PG.timestamptzMillis, { name: "created_at_vercel" }),
		buildingAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "building_at" }),
		readyAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "ready_at" }),
		inspectorUrl: PG.column(PG.nullable(PG.text), { name: "inspector_url" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("vercel_deployments_org_deployment_idx", ["orgId", "deploymentId"]),
		PG.index("vercel_deployments_org_project_created_idx", ["orgId", "projectId", "createdAtVercel"]),
	],
	tenantColumn: "orgId",
})

export type VercelDeploymentRow = PG.SelectRowOf<typeof VercelDeployments>
