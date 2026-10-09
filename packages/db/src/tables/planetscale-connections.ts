import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId, ScrapeTargetId } from "@maple/domain/primitives"
import { Schema } from "effect"

/**
 * First-class PlanetScale integration state, one row per Maple org, created
 * when the OAuth grant is bound to a PlanetScale organization. The OAuth
 * tokens themselves live in `oauth_connections` (provider "planetscale");
 * this table holds the integration-owned state that table has no home for:
 * the org binding, the managed scrape target it auto-provisioned, the
 * per-connection webhook HMAC secret, and the API permissions detected at
 * binding time. An `oauth_connections` row with no row here means the grant
 * is pending org selection.
 */
export const PlanetscaleConnections = PG.table("planetscale_connections", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		/** PlanetScale organization slug the connection is bound to. */
		psOrganization: PG.column(PG.text, { name: "ps_organization" }),
		connectedByUserId: PG.column(PG.text, { name: "connected_by_user_id" }),
		/** The managed `scrape_targets` row this connection auto-provisioned. */
		scrapeTargetId: PG.column(PG.nullable(PG.brand(PG.text, ScrapeTargetId)), { name: "scrape_target_id" }),
		/** Per-connection HMAC secret for inbound PlanetScale webhooks. */
		webhookSecretCiphertext: PG.column(PG.nullable(PG.text), { name: "webhook_secret_ciphertext" }),
		webhookSecretIv: PG.column(PG.nullable(PG.text), { name: "webhook_secret_iv" }),
		webhookSecretTag: PG.column(PG.nullable(PG.text), { name: "webhook_secret_tag" }),
		/** API permissions probed at org-binding time (e.g. read_databases, read_metrics_endpoints). */
		detectedPermissionsJson: PG.column(PG.nullable(PG.jsonb(Schema.Record(Schema.String, Schema.Boolean))), {
			name: "detected_permissions_json",
		}),
		lastInventoryAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_inventory_at" }),
		lastInventoryError: PG.column(PG.nullable(PG.text), { name: "last_inventory_error" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [PG.uniqueIndex("planetscale_connections_org_idx", ["orgId"])],
	tenantColumn: "orgId",
})

export type PlanetScaleConnectionRow = PG.SelectRowOf<typeof PlanetscaleConnections>
export type PlanetScaleConnectionInsert = PG.InsertRowOf<typeof PlanetscaleConnections>
