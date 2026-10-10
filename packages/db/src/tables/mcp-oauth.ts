import * as PG from "@maple-dev/effect-orm/postgres"
import { ApiKeyId, OrgId, UserId } from "@maple/domain/primitives"
import { Schema } from "effect"

const StringList = Schema.Array(Schema.String)

export const McpOAuthClients = PG.table("mcp_oauth_clients", {
	columns: {
		clientId: PG.column(PG.text, { name: "client_id" }),
		clientName: PG.column(PG.text, { name: "client_name" }),
		redirectUris: PG.column(PG.jsonb(StringList), { name: "redirect_uris" }),
		clientUri: PG.column(PG.nullable(PG.text), { name: "client_uri" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
	},
	primaryKey: ["clientId"],
})

export const McpOAuthAuthorizations = PG.table("mcp_oauth_authorizations", {
	columns: {
		requestIdHash: PG.column(PG.text, { name: "request_id_hash" }),
		clientId: PG.column(PG.text, { name: "client_id" }),
		clientName: PG.column(PG.text, { name: "client_name" }),
		redirectUri: PG.column(PG.text, { name: "redirect_uri" }),
		state: PG.nullable(PG.text),
		resource: PG.text,
		scopes: PG.jsonb(StringList),
		codeChallenge: PG.column(PG.text, { name: "code_challenge" }),
		authorizationCodeHash: PG.column(PG.nullable(PG.text), { name: "authorization_code_hash" }),
		approvedOrgId: PG.column(PG.nullable(PG.brand(PG.text, OrgId)), { name: "approved_org_id" }),
		approvedUserId: PG.column(PG.nullable(PG.brand(PG.text, UserId)), { name: "approved_user_id" }),
		approvedRoles: PG.column(PG.nullable(PG.jsonb(StringList)), { name: "approved_roles" }),
		approvedUserEmail: PG.column(PG.nullable(PG.text), { name: "approved_user_email" }),
		approvedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "approved_at" }),
		deniedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "denied_at" }),
		usedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "used_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		expiresAt: PG.column(PG.timestamptzMillis, { name: "expires_at" }),
	},
	primaryKey: ["requestIdHash"],
	indexes: [
		PG.uniqueIndex("mcp_oauth_authorizations_code_unique", ["authorizationCodeHash"]),
		PG.index("mcp_oauth_authorizations_expires_idx", ["expiresAt"]),
	],
})

export const McpOAuthRefreshTokens = PG.table("mcp_oauth_refresh_tokens", {
	columns: {
		id: PG.text,
		tokenHash: PG.column(PG.text, { name: "token_hash" }),
		familyId: PG.column(PG.text, { name: "family_id" }),
		clientId: PG.column(PG.text, { name: "client_id" }),
		resource: PG.text,
		scopes: PG.jsonb(StringList),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		userId: PG.column(PG.brand(PG.text, UserId), { name: "user_id" }),
		roles: PG.jsonb(StringList),
		userEmail: PG.column(PG.nullable(PG.text), { name: "user_email" }),
		accessKeyId: PG.column(PG.brand(PG.text, ApiKeyId), { name: "access_key_id" }),
		replacedById: PG.column(PG.nullable(PG.text), { name: "replaced_by_id" }),
		revokedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "revoked_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		expiresAt: PG.column(PG.timestamptzMillis, { name: "expires_at" }),
		/**
		 * When the whole grant dies, regardless of how often it rotates. Carried
		 * unchanged across rotations; `expires_at` alone resets on every refresh,
		 * which made an MCP grant effectively permanent. Null on rows written
		 * before the column existed.
		 */
		familyExpiresAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "family_expires_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("mcp_oauth_refresh_tokens_hash_unique", ["tokenHash"]),
		PG.index("mcp_oauth_refresh_tokens_family_idx", ["familyId"]),
		PG.index("mcp_oauth_refresh_tokens_expires_idx", ["expiresAt"]),
	],
	tenantColumn: "orgId",
})

export type McpOAuthClientRow = PG.SelectRowOf<typeof McpOAuthClients>
export type McpOAuthAuthorizationRow = PG.SelectRowOf<typeof McpOAuthAuthorizations>
export type McpOAuthRefreshTokenRow = PG.SelectRowOf<typeof McpOAuthRefreshTokens>
