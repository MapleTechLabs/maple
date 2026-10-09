import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId, UserId } from "@maple/domain/primitives"

export const OAuthConnections = PG.table("oauth_connections", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		provider: PG.text,
		externalUserId: PG.column(PG.text, { name: "external_user_id" }),
		externalUserEmail: PG.column(PG.nullable(PG.text), { name: "external_user_email" }),
		// Provider-agnostic display label for the connected principal (e.g. a Cloudflare account
		// name). Kept separate from externalUserEmail so that column only ever holds real emails.
		externalAccountName: PG.column(PG.nullable(PG.text), { name: "external_account_name" }),
		// JSON array of every external principal the grant covers ([{ id, name }]) for providers
		// whose single OAuth grant may span several (Cloudflare accounts). Null when the grant
		// covers only the principal in externalUserId.
		grantedAccountsJson: PG.column(PG.nullable(PG.text), { name: "granted_accounts_json" }),
		connectedByUserId: PG.column(PG.brand(PG.text, UserId), { name: "connected_by_user_id" }),
		scope: PG.column(PG.text, { default: "" }),
		accessTokenCiphertext: PG.column(PG.text, { name: "access_token_ciphertext" }),
		accessTokenIv: PG.column(PG.text, { name: "access_token_iv" }),
		accessTokenTag: PG.column(PG.text, { name: "access_token_tag" }),
		refreshTokenCiphertext: PG.column(PG.nullable(PG.text), { name: "refresh_token_ciphertext" }),
		refreshTokenIv: PG.column(PG.nullable(PG.text), { name: "refresh_token_iv" }),
		refreshTokenTag: PG.column(PG.nullable(PG.text), { name: "refresh_token_tag" }),
		expiresAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "expires_at" }),
		// Set when the provider rejects the token as revoked (IntegrationsRevokedError):
		// pollers skip revoked connections until a reconnect clears this.
		revokedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "revoked_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("oauth_connections_org_provider_idx", ["orgId", "provider"]),
		PG.index("oauth_connections_org_idx", ["orgId"]),
	],
	tenantColumn: "orgId",
})

export const OAuthAuthStates = PG.table("oauth_auth_states", {
	columns: {
		state: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		provider: PG.text,
		initiatedByUserId: PG.column(PG.brand(PG.text, UserId), { name: "initiated_by_user_id" }),
		redirectUri: PG.column(PG.text, { name: "redirect_uri" }),
		returnTo: PG.column(PG.nullable(PG.text), { name: "return_to" }),
		// PKCE code verifier (RFC 7636). Set for providers that use the Authorization Code + PKCE
		// flow (e.g. Cloudflare public clients, which carry no client secret); null otherwise.
		codeVerifier: PG.column(PG.nullable(PG.text), { name: "code_verifier" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		expiresAt: PG.column(PG.timestamptzMillis, { name: "expires_at" }),
	},
	primaryKey: ["state"],
	indexes: [PG.index("oauth_auth_states_expires_idx", ["expiresAt"])],
	tenantColumn: "orgId",
})

export type OAuthConnectionRow = PG.SelectRowOf<typeof OAuthConnections>
export type OAuthConnectionInsert = PG.InsertRowOf<typeof OAuthConnections>
export type OAuthAuthStateRow = PG.SelectRowOf<typeof OAuthAuthStates>
export type OAuthAuthStateInsert = PG.InsertRowOf<typeof OAuthAuthStates>
