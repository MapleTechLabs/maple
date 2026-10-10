import * as PG from "@maple-dev/effect-orm/postgres"
import {
	GcpConnectorId,
	GcpProjectId,
	GcpResourceNumber,
	GcpScopeType,
	OrgId,
} from "@maple/domain/primitives"
import { Schema } from "effect"

// One row per connected Google Cloud scope: a project, or everything under a folder or
// organization. `project_id` is the host project, where Maple's own resources live (Pub/Sub topic,
// subscription, service account); for a project scope it equals `scope_id`. The ingest gateway's
// `/v1/logpush/gcp/...` receiver authenticates a push by `id` + `secret_hash` and writes
// `last_received_at` / `last_error` and the setup report. `metrics_enabled` covers metrics and
// resource collection.
export const GcpConnectors = PG.table("gcp_connectors", {
	columns: {
		id: PG.brand(PG.text, GcpConnectorId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		scopeType: PG.column(PG.brand(PG.text, GcpScopeType), { name: "scope_type" }),
		scopeId: PG.column(PG.brand(PG.text, Schema.Union([GcpProjectId, GcpResourceNumber])), {
			name: "scope_id",
		}),
		projectId: PG.column(PG.brand(PG.text, GcpProjectId), { name: "project_id" }),
		logsEnabled: PG.column(PG.bool, { name: "logs_enabled", default: true }),
		metricsEnabled: PG.column(PG.bool, { name: "metrics_enabled", default: false }),
		secretCiphertext: PG.column(PG.text, { name: "secret_ciphertext" }),
		secretIv: PG.column(PG.text, { name: "secret_iv" }),
		secretTag: PG.column(PG.text, { name: "secret_tag" }),
		secretHash: PG.column(PG.text, { name: "secret_hash" }),
		lastReceivedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_received_at" }),
		lastError: PG.column(PG.nullable(PG.text), { name: "last_error" }),
		// What the latest setup script run reported it set up in Google Cloud, written by the
		// receiver. Null until a run reports: the switches above say what should be there.
		appliedLogsEnabled: PG.column(PG.nullable(PG.bool), { name: "applied_logs_enabled" }),
		appliedMetricsEnabled: PG.column(PG.nullable(PG.bool), { name: "applied_metrics_enabled" }),
		setupReportedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "setup_reported_at" }),
		// Metrics poller: end of the last minute it ingested. Null until the first successful poll.
		metricsWatermarkAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "metrics_watermark_at" }),
		lastMetricsReceivedAt: PG.column(PG.nullable(PG.timestamptzMillis), {
			name: "last_metrics_received_at",
		}),
		lastMetricsError: PG.column(PG.nullable(PG.text), { name: "last_metrics_error" }),
		// A tick claims the connector by moving this past now, and it is never cleared: it also
		// orders the next tick, least recently polled first.
		metricsLeaseUntil: PG.column(PG.nullable(PG.timestamptzMillis), { name: "metrics_lease_until" }),
		// Last sync of `gcp_resources` that Google answered, whole or cut short at a cap; the next
		// one is due an hour later. The error says why the latest attempt fell short.
		resourcesSyncedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "resources_synced_at" }),
		lastResourcesError: PG.column(PG.nullable(PG.text), { name: "last_resources_error" }),
		createdBy: PG.column(PG.text, { name: "created_by" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("gcp_connectors_org_scope_idx", ["orgId", "scopeType", "scopeId"]),
		PG.uniqueIndex("gcp_connectors_secret_hash_unique", ["secretHash"]),
	],
	tenantColumn: "orgId",
})

export type GcpConnectorRow = PG.SelectRowOf<typeof GcpConnectors>
