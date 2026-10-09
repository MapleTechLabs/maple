import * as PG from "@maple-dev/effect-orm/postgres"
import { ApiKeyId, OrgId, UserId } from "@maple/domain/primitives"
import { Schema } from "effect"

export const CliDeviceAuthorizations = PG.table("cli_device_authorizations", {
	columns: {
		deviceCodeHash: PG.column(PG.text, { name: "device_code_hash" }),
		userCodeHash: PG.column(PG.text, { name: "user_code_hash" }),
		deviceName: PG.column(PG.text, { name: "device_name" }),
		approvedOrgId: PG.column(PG.nullable(PG.brand(PG.text, OrgId)), { name: "approved_org_id" }),
		approvedUserId: PG.column(PG.nullable(PG.brand(PG.text, UserId)), { name: "approved_user_id" }),
		approvedRoles: PG.column(PG.nullable(PG.jsonb(Schema.Array(Schema.String))), { name: "approved_roles" }),
		approvedUserEmail: PG.column(PG.nullable(PG.text), { name: "approved_user_email" }),
		apiKeyId: PG.column(PG.nullable(PG.brand(PG.text, ApiKeyId)), { name: "api_key_id" }),
		tokenCiphertext: PG.column(PG.nullable(PG.text), { name: "token_ciphertext" }),
		tokenIv: PG.column(PG.nullable(PG.text), { name: "token_iv" }),
		tokenTag: PG.column(PG.nullable(PG.text), { name: "token_tag" }),
		approvedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "approved_at" }),
		deniedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "denied_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		expiresAt: PG.column(PG.timestamptzMillis, { name: "expires_at" }),
	},
	primaryKey: ["deviceCodeHash"],
	indexes: [
		PG.uniqueIndex("cli_device_authorizations_user_code_unique", ["userCodeHash"]),
		PG.index("cli_device_authorizations_expires_idx", ["expiresAt"]),
	],
})

export type CliDeviceAuthorizationRow = PG.SelectRowOf<typeof CliDeviceAuthorizations>
