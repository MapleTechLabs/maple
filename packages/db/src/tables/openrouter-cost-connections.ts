import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId, UserId } from "@maple/primitives"

/**
 * The OpenRouter management key an org's OpenRouter spend is read with (AES-GCM, bound to the
 * org), one per org. It is not the key AI turns run on (`org_openrouter_keys`): a management key
 * cannot make completions. `cost_sources.connection_ref` holds `id`, which a replaced key keeps.
 */
export const OpenRouterCostConnections = PG.table("openrouter_cost_connections", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		keyCiphertext: PG.column(PG.text, { name: "key_ciphertext" }),
		keyIv: PG.column(PG.text, { name: "key_iv" }),
		keyTag: PG.column(PG.text, { name: "key_tag" }),
		/** The key as OpenRouter masks it (`sk-or-v1-abc...xyz`). */
		keyLabel: PG.column(PG.text, { name: "key_label" }),
		/**
		 * The OpenRouter account the key belongs to: its organization, or the user of a personal
		 * account. A replacement key must name the same one, so one source never mixes two accounts.
		 */
		accountId: PG.column(PG.text, { name: "account_id" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		updatedBy: PG.column(PG.brand(PG.text, UserId), { name: "updated_by" }),
	},
	primaryKey: ["id"],
	indexes: [PG.uniqueIndex("openrouter_cost_connections_org_idx", ["orgId"])],
	tenantColumn: "orgId",
})

export type OpenRouterCostConnectionRow = PG.SelectRowOf<typeof OpenRouterCostConnections>
