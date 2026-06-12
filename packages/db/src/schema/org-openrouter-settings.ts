import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core"

export const orgOpenrouterSettings = pgTable(
	"org_openrouter_settings",
	{
		orgId: text("org_id").notNull(),
		apiKeyCiphertext: text("api_key_ciphertext").notNull(),
		apiKeyIv: text("api_key_iv").notNull(),
		apiKeyTag: text("api_key_tag").notNull(),
		apiKeyLast4: text("api_key_last4").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
		createdBy: text("created_by").notNull(),
		updatedBy: text("updated_by").notNull(),
	},
	(table) => [primaryKey({ columns: [table.orgId] })],
)

export type OrgOpenrouterSettingsRow = typeof orgOpenrouterSettings.$inferSelect
export type OrgOpenrouterSettingsInsert = typeof orgOpenrouterSettings.$inferInsert
