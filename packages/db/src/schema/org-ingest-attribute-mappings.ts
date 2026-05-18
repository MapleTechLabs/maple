import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"

export const orgIngestAttributeMappings = sqliteTable(
	"org_ingest_attribute_mappings",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").notNull(),
		name: text("name").notNull(),
		sourceContext: text("source_context").notNull(),
		sourceKey: text("source_key").notNull(),
		targetKey: text("target_key").notNull(),
		operation: text("operation").notNull(),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		createdAt: integer("created_at")
			.notNull()
			.default(sql`(unixepoch('subsec') * 1000)`),
		updatedAt: integer("updated_at")
			.notNull()
			.default(sql`(unixepoch('subsec') * 1000)`),
	},
	(table) => [index("org_ingest_attribute_mappings_org_idx").on(table.orgId)],
)

export type OrgIngestAttributeMappingRow = typeof orgIngestAttributeMappings.$inferSelect
export type OrgIngestAttributeMappingInsert = typeof orgIngestAttributeMappings.$inferInsert
