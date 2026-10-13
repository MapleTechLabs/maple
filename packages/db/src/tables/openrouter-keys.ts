import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId, UserId } from "@maple/domain/primitives"

/**
 * The org's own OpenRouter API key (AES-GCM, AAD-bound to the org), one per org. AI turns run on it
 * instead of Maple's key while the org holds the `openrouter_byok` add-on.
 */
export const OrgOpenRouterKeys = PG.table("org_openrouter_keys", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		keyCiphertext: PG.column(PG.text, { name: "key_ciphertext" }),
		keyIv: PG.column(PG.text, { name: "key_iv" }),
		keyTag: PG.column(PG.text, { name: "key_tag" }),
		/** The key's last four characters, so the settings page can say which key is in use. */
		keyHint: PG.column(PG.text, { name: "key_hint" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		updatedBy: PG.column(PG.brand(PG.text, UserId), { name: "updated_by" }),
	},
	primaryKey: ["orgId"],
	tenantColumn: "orgId",
})

export type OrgOpenRouterKeyRow = PG.SelectRowOf<typeof OrgOpenRouterKeys>
