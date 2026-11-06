import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId } from "@maple/domain/primitives"

/**
 * The org's Cloudflare Hyperdrive config inventory, refreshed by the analytics
 * poller's hourly discovery pass. Consumed by the service map to resolve which
 * origin database (e.g. a PlanetScale database) sits behind the collapsed
 * Hyperdrive node. Rows whose config disappeared upstream are soft-deleted
 * (`deletedAt`), mirroring `planetscale_databases`.
 */
export const CloudflareHyperdriveConfigs = PG.table("cloudflare_hyperdrive_configs", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		/** Cloudflare account the config was discovered on; null on pre-multi-account rows. */
		accountId: PG.column(PG.nullable(PG.text), { name: "account_id" }),
		/** Cloudflare's 32-hex Hyperdrive config id (what `db.namespace` collapses from). */
		configId: PG.column(PG.text, { name: "config_id" }),
		name: PG.text,
		/** Origin host; null for the VPC-origin variant (no public host). */
		originHost: PG.column(PG.nullable(PG.text), { name: "origin_host" }),
		/** Origin port; null for the Access-client and VPC variants. */
		originPort: PG.column(PG.nullable(PG.int4), { name: "origin_port" }),
		/** Origin scheme: "mysql" | "postgres" | "postgresql". */
		originScheme: PG.column(PG.text, { name: "origin_scheme" }),
		originDatabase: PG.column(PG.text, { name: "origin_database" }),
		originUser: PG.column(PG.nullable(PG.text), { name: "origin_user" }),
		deletedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "deleted_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("cloudflare_hyperdrive_configs_org_config_idx", ["orgId", "configId"]),
		PG.index("cloudflare_hyperdrive_configs_org_idx", ["orgId"]),
	],
	tenantColumn: "orgId",
})

export type CloudflareHyperdriveConfigRow = PG.SelectRowOf<typeof CloudflareHyperdriveConfigs>
export type CloudflareHyperdriveConfigInsert = PG.InsertRowOf<typeof CloudflareHyperdriveConfigs>
