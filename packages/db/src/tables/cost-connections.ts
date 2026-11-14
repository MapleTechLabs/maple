import * as PG from "@maple-dev/effect-orm/postgres"
import { CostProvider } from "@maple/domain/cost"
import { OrgId, UserId } from "@maple/primitives"

/**
 * A credential an org pasted so Maple can read one provider's spend (AES-GCM, bound to the org and
 * the provider), one per provider and org. `cost_sources.connection_ref` holds `id`, which a
 * replaced credential keeps. OpenRouter predates this table and keeps its own.
 */
export const CostConnections = PG.table("cost_connections", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		provider: PG.brand(PG.text, CostProvider),
		secretCiphertext: PG.column(PG.text, { name: "secret_ciphertext" }),
		secretIv: PG.column(PG.text, { name: "secret_iv" }),
		secretTag: PG.column(PG.text, { name: "secret_tag" }),
		/**
		 * The provider's account the credential reads. A replacement must name the same one, so one
		 * source never mixes two accounts.
		 */
		accountId: PG.column(PG.text, { name: "account_id" }),
		/** The account as the provider names it, for people. */
		accountLabel: PG.column(PG.text, { name: "account_label" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		updatedBy: PG.column(PG.brand(PG.text, UserId), { name: "updated_by" }),
	},
	primaryKey: ["id"],
	indexes: [PG.uniqueIndex("cost_connections_org_provider_idx", ["orgId", "provider"])],
	tenantColumn: "orgId",
})

export type CostConnectionRow = PG.SelectRowOf<typeof CostConnections>
