import * as PG from "@maple-dev/effect-orm/postgres"
import { ChatConnectorId, ChatWorkspaceId, OrgId } from "@maple/domain/primitives"
import { Schema } from "effect"

// One row per chat workspace linked to a Maple org (a server, a team, a tenant,
// whatever the platform calls it; this table knows none of them). The bot is an
// org-level actor: any member of a linked workspace can invoke it, and there is
// no chat-user <-> Maple-user link, so this row is the whole binding.
//
// Deliberately absent, and what it would take to add each back:
//
//   - no `revoked_at` / `revoked_reason`. Unlinking deletes the row; nothing
//     reads the history, and a deleted row cannot resolve a bot event.
//   - no `installed_by_user_id`. Nothing reads it; the install is already
//     audited (`chat_integration.install_started`) with the acting user.
//   - no `updated_at`. Nothing reads it either; `created_at` is what the
//     settings card shows.
//   - no one-workspace-per-org constraint. An org may link several workspaces
//     (a team server and a customer server), and nothing needs to pick one.
//
// `org_id` carries no foreign key: orgs live in Clerk, not Postgres. Org
// deletion is handled by the explicit `ORG_SCOPED_TABLES` purge list in
// `packages/backend/src/services/org/OrganizationService.ts`; this table must
// be listed there.

export const ChatWorkspaces = PG.table("chat_workspaces", {
	columns: {
		id: PG.brand(PG.text, ChatWorkspaceId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		/** The connector that owns this row (`ChatConnectorId`). */
		connector: PG.brand(PG.text, ChatConnectorId),
		/** The platform's own id for the workspace: a guild/team/tenant id. */
		externalWorkspaceId: PG.column(PG.text, { name: "external_workspace_id" }),
		/** Display name as the platform reported it at install time. */
		name: PG.text,
		/** Connector-defined settings, validated by the connector's own schema. */
		settings: PG.jsonb(Schema.Record(Schema.String, Schema.String)),
		// The secret the connector's own install minted for THIS workspace, as one
		// AES-256-GCM envelope over a string only that connector reads back. Null
		// for a connector that authenticates with one deployment-wide credential,
		// which is why this is three nullable columns rather than a second table.
		// The AAD binds the envelope to `(org_id, connector, external_workspace_id)`
		// (`chat-workspace-credentials.ts`), so a row's ciphertext cannot be moved
		// onto another org's row by anyone holding only database write access.
		credentialsCiphertext: PG.column(PG.nullable(PG.text), { name: "credentials_ciphertext" }),
		credentialsIv: PG.column(PG.nullable(PG.text), { name: "credentials_iv" }),
		credentialsTag: PG.column(PG.nullable(PG.text), { name: "credentials_tag" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		// One chat workspace maps to exactly one org: the constraint that stops a
		// second org from linking a workspace someone else already connected, and
		// what makes the bot's `(connector, external id)` resolve unambiguous.
		PG.uniqueIndex("chat_workspaces_connector_external_idx", ["connector", "externalWorkspaceId"]),
		PG.index("chat_workspaces_org_idx", ["orgId"]),
	],
	tenantColumn: "orgId",
})

export type ChatWorkspaceRow = PG.SelectRowOf<typeof ChatWorkspaces>
