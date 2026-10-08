import type { OrgId } from "@maple/domain"
import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

// One row per connected Google Cloud project. The ingest gateway's `/v1/logpush/gcp/...` receiver
// authenticates a push by `id` + `secret_hash` and writes `last_received_at` / `last_error`.
export const gcpConnectors = pgTable(
	"gcp_connectors",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		projectId: text("project_id").notNull(),
		secretCiphertext: text("secret_ciphertext").notNull(),
		secretIv: text("secret_iv").notNull(),
		secretTag: text("secret_tag").notNull(),
		secretHash: text("secret_hash").notNull(),
		lastReceivedAt: timestamp("last_received_at", { withTimezone: true, mode: "date" }),
		lastError: text("last_error"),
		createdBy: text("created_by").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("gcp_connectors_org_project_idx").on(table.orgId, table.projectId),
		uniqueIndex("gcp_connectors_secret_hash_unique").on(table.secretHash),
	],
)

export type GcpConnectorRow = typeof gcpConnectors.$inferSelect
