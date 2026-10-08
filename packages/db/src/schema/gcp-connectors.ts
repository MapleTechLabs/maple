import type { GcpConnectorId, GcpProjectId, GcpResourceNumber, GcpScopeType, OrgId } from "@maple/domain"
import { boolean, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

// One row per connected Google Cloud scope: a project, or everything under a folder or
// organization. `project_id` is the host project, where Maple's own resources live (Pub/Sub topic,
// subscription, service account); for a project scope it equals `scope_id`. The ingest gateway's
// `/v1/logpush/gcp/...` receiver authenticates a push by `id` + `secret_hash` and writes
// `last_received_at` / `last_error`. `metrics_enabled` covers metrics and resource collection.
export const gcpConnectors = pgTable(
	"gcp_connectors",
	{
		id: text("id").$type<GcpConnectorId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		scopeType: text("scope_type").$type<GcpScopeType>().notNull(),
		scopeId: text("scope_id").$type<GcpProjectId | GcpResourceNumber>().notNull(),
		projectId: text("project_id").$type<GcpProjectId>().notNull(),
		logsEnabled: boolean("logs_enabled").notNull().default(true),
		metricsEnabled: boolean("metrics_enabled").notNull().default(false),
		secretCiphertext: text("secret_ciphertext").notNull(),
		secretIv: text("secret_iv").notNull(),
		secretTag: text("secret_tag").notNull(),
		secretHash: text("secret_hash").notNull(),
		lastReceivedAt: timestamp("last_received_at", { withTimezone: true, mode: "date" }),
		lastError: text("last_error"),
		// Metrics poller: end of the last minute it ingested. Null until the first successful poll.
		metricsWatermarkAt: timestamp("metrics_watermark_at", { withTimezone: true, mode: "date" }),
		lastMetricsReceivedAt: timestamp("last_metrics_received_at", { withTimezone: true, mode: "date" }),
		lastMetricsError: text("last_metrics_error"),
		// A tick claims the connector by moving this past now, and it is never cleared: it also
		// orders the next tick, least recently polled first.
		metricsLeaseUntil: timestamp("metrics_lease_until", { withTimezone: true, mode: "date" }),
		// Last sync of `gcp_resources` that Google answered, whole or cut short at a cap; the next
		// one is due an hour later. The error says why the latest attempt fell short.
		resourcesSyncedAt: timestamp("resources_synced_at", { withTimezone: true, mode: "date" }),
		lastResourcesError: text("last_resources_error"),
		createdBy: text("created_by").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("gcp_connectors_org_scope_idx").on(table.orgId, table.scopeType, table.scopeId),
		uniqueIndex("gcp_connectors_secret_hash_unique").on(table.secretHash),
	],
)

export type GcpConnectorRow = typeof gcpConnectors.$inferSelect
