import type { ChatConnectorId, ChatWorkspaceId, OrgId } from "@maple/domain/primitives"
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

// One row per chat workspace linked to a Maple org — a server, a team, a tenant,
// whatever the platform calls it; this table knows none of them. The bot is an
// org-level actor: any member of a linked workspace can invoke it, and there is
// no chat-user ↔ Maple-user link, so this row is the whole binding.
//
// Deliberately absent, and what it would take to add each back:
//
//   - no credential columns. The connectors Maple ships authenticate with one
//     global bot credential the host supplies, so there is nothing per-workspace
//     to keep. A connector that mints a per-workspace token adds an encrypted
//     column then, following the encrypted-secret pattern the other workspace
//     integration in `packages/backend/src/services/integrations/` uses.
//   - no `revoked_at` / `revoked_reason`. Unlinking deletes the row; nothing
//     reads the history, and a deleted row cannot resolve a bot event.
//   - no `installed_by_user_id`. Nothing reads it — the install is already
//     audited (`chat_integration.install_started`) with the acting user.
//   - no `updated_at`. Nothing reads it either; `created_at` is what the
//     settings card shows.
//   - no one-workspace-per-org constraint. An org may link several workspaces
//     (a team server and a customer server), and nothing needs to pick one.
//
// `org_id` carries no foreign key: orgs live in Clerk, not Postgres. Org
// deletion is handled by the explicit `ORG_SCOPED_TABLES` purge list in
// `packages/backend/src/services/org/OrganizationService.ts` — this table must
// be listed there.

export const chatWorkspaces = pgTable(
	"chat_workspaces",
	{
		id: text("id").$type<ChatWorkspaceId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		/** The connector that owns this row (`ChatConnectorId`). */
		connector: text("connector").$type<ChatConnectorId>().notNull(),
		/** The platform's own id for the workspace — a guild/team/tenant id. */
		externalWorkspaceId: text("external_workspace_id").notNull(),
		/** Display name as the platform reported it at install time. */
		name: text("name").notNull(),
		/** Connector-defined settings, validated by the connector's own schema. */
		settings: jsonb("settings").$type<Record<string, string>>().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		// One chat workspace maps to exactly one org — the constraint that stops a
		// second org from linking a workspace someone else already connected, and
		// what makes the bot's `(connector, external id)` resolve unambiguous.
		uniqueIndex("chat_workspaces_connector_external_idx").on(table.connector, table.externalWorkspaceId),
		index("chat_workspaces_org_idx").on(table.orgId),
	],
)

export type ChatWorkspaceRow = typeof chatWorkspaces.$inferSelect
export type ChatWorkspaceInsert = typeof chatWorkspaces.$inferInsert
