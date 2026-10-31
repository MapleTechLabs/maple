import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId, UserId } from "@maple/domain/primitives"
import { Schema } from "effect"

// Which zones of a Cloudflare account the customer collects: `zoneOverrides[zoneId] ?? watchNewZones`,
// and every zone when the row is missing. Separate from the poller-owned state `enabled` flag.
export const CloudflareZoneSettings = PG.table("cloudflare_zone_settings", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		accountId: PG.column(PG.text, { name: "account_id" }),
		watchNewZones: PG.column(PG.bool, { name: "watch_new_zones", default: true }),
		zoneOverrides: PG.column(PG.jsonb(Schema.Record(Schema.String, Schema.Boolean)), {
			name: "zone_overrides",
			default: {},
		}),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		updatedBy: PG.column(PG.nullable(PG.brand(PG.text, UserId)), { name: "updated_by" }),
	},
	primaryKey: ["orgId", "accountId"],
	tenantColumn: "orgId",
})

export type CloudflareZoneSettingsRow = PG.SelectRowOf<typeof CloudflareZoneSettings>
