import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId, UserId } from "@maple/primitives"

// What the org's Cloudflare grant collects, one switch per feature of the catalog's `cloudflare`
// entry. A missing row collects everything. Kept across a disconnect, like the zone choices.
export const CloudflareFeatureSettings = PG.table("cloudflare_feature_settings", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		httpTrafficEnabled: PG.column(PG.bool, { name: "http_traffic_enabled", default: true }),
		firewallEnabled: PG.column(PG.bool, { name: "firewall_enabled", default: true }),
		dnsEnabled: PG.column(PG.bool, { name: "dns_enabled", default: true }),
		workersEnabled: PG.column(PG.bool, { name: "workers_enabled", default: true }),
		queuesEnabled: PG.column(PG.bool, { name: "queues_enabled", default: true }),
		durableObjectsEnabled: PG.column(PG.bool, { name: "durable_objects_enabled", default: true }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		updatedBy: PG.column(PG.nullable(PG.brand(PG.text, UserId)), { name: "updated_by" }),
	},
	primaryKey: ["orgId"],
	tenantColumn: "orgId",
})

export type CloudflareFeatureSettingsRow = PG.SelectRowOf<typeof CloudflareFeatureSettings>
