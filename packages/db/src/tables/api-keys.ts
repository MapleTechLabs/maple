import * as PG from "@maple-dev/effect-orm/postgres"
import { ApiKeyKind } from "@maple/domain/http"
import { ApiKeyId, OrgId, UserId } from "@maple/domain/primitives"
import { Schema } from "effect"

export const ApiKeys = PG.table("api_keys", {
	columns: {
		id: PG.brand(PG.text, ApiKeyId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		name: PG.text,
		description: PG.nullable(PG.text),
		keyHash: PG.column(PG.text, { name: "key_hash" }),
		keyPrefix: PG.column(PG.text, { name: "key_prefix" }),
		revoked: PG.column(PG.bool, { default: false }),
		revokedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "revoked_at" }),
		lastUsedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_used_at" }),
		expiresAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "expires_at" }),
		metadataJson: PG.column(PG.nullable(PG.jsonb()), { name: "metadata_json" }),
		// v2 scope strings ("<family>:read"/"<family>:write"/"*"); null = legacy full access.
		scopes: PG.nullable(PG.jsonb(Schema.Array(Schema.String))),
		// `standard` is a human-minted org key; `mcp` is only valid for the MCP
		// server; `device` is minted *for* a device by a signed-in app, with the
		// server choosing its scopes, TTL, and roles; see ApiKeysService.
		kind: PG.column(PG.brand(PG.text, ApiKeyKind), { default: "standard" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		createdBy: PG.column(PG.brand(PG.text, UserId), { name: "created_by" }),
		createdByEmail: PG.column(PG.nullable(PG.text), { name: "created_by_email" }),
	},
	primaryKey: ["id"],
	indexes: [PG.uniqueIndex("api_keys_key_hash_unique", ["keyHash"]), PG.index("api_keys_org_id_idx", ["orgId"])],
	tenantColumn: "orgId",
})

export type ApiKeyRow = PG.SelectRowOf<typeof ApiKeys>
export type ApiKeyInsert = PG.InsertRowOf<typeof ApiKeys>
