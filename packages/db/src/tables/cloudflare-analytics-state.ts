import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId } from "@maple/domain/primitives"

// Poll-state for the Cloudflare GraphQL Analytics collector. One row per (org, dataset, zone):
// zone-scoped datasets (http_requests) get one row per discovered zone; account-scoped datasets
// (workers_invocations) use zoneId = "" . The table doubles as the org's zone cache: zone
// discovery reconciles rows on every poll tick (soft-disabling rows whose zone disappeared so a
// re-appearing zone resumes from its old watermark instead of re-backfilling).
export const CloudflareAnalyticsState = PG.table("cloudflare_analytics_state", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		// Cloudflare account the row belongs to (one of the org grant's accounts). "" only on
		// orphaned pre-multi-account rows whose org had no connection when the backfill ran.
		accountId: PG.column(PG.text, { name: "account_id", default: "" }),
		dataset: PG.text,
		// "" for account-scoped datasets, kept NOT NULL so the (org, dataset, zone) unique index
		// treats the account row like any other.
		zoneId: PG.column(PG.text, { name: "zone_id", default: "" }),
		zoneName: PG.column(PG.nullable(PG.text), { name: "zone_name" }),
		enabled: PG.column(PG.bool, { default: true }),
		// HEAD frontier: END of the newest 5-minute bucket ingested. The poll fetches the newest
		// window first (live-first) so a freshly-connected integration shows near-now data within one
		// tick; in steady state this is just the small [watermark, horizon] delta. Null until the
		// first head poll.
		watermarkAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "watermark_at" }),
		// BACKFILL frontier: OLDEST bucket boundary the background history fill has reached, walking
		// DOWN toward the 24h floor (further bounded by the plan's `notOlderThan`). Seeded to the first
		// head window's start on the first head poll; backfill is complete once it reaches the floor.
		// Split from watermarkAt so history fills in behind live data instead of delaying it.
		backfillAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "backfill_at" }),
		// Cached GraphQL dataset `settings` node (notOlderThan/maxDuration/availableFields), the
		// only authoritative per-plan limits source; refreshed ~daily.
		settingsJson: PG.column(PG.nullable(PG.text), { name: "settings_json" }),
		settingsFetchedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "settings_fetched_at" }),
		// False when the tenant's plan lacks the timing quantile fields (free plan); the poller
		// then omits the quantiles selection and only counters are emitted.
		quantilesAvailable: PG.column(PG.bool, { name: "quantiles_available", default: true }),
		// When zone discovery (REST listZones) last ran, set on the workers anchor row only.
		// Discovery runs on an hourly TTL; poll ticks in between reuse the known zone rows.
		discoveredAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "discovered_at" }),
		// JSON array of live Worker script names (REST listScripts), cached on the workers anchor
		// row alongside discoveredAt. Used to drop invocation groups for deleted scripts; null means
		// enumeration is unavailable (e.g. token lacks workers-scripts.read) → no filtering.
		liveScriptsJson: PG.column(PG.nullable(PG.text), { name: "live_scripts_json" }),
		lastSuccessAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_success_at" }),
		lastError: PG.column(PG.nullable(PG.text), { name: "last_error" }),
		lastErrorAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_error_at" }),
		// Overlap guard: a tick claims an org's rows by bumping this past now; a competing tick
		// that fails to claim skips the org.
		leaseUntil: PG.column(PG.nullable(PG.timestamptzMillis), { name: "lease_until" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("cf_analytics_state_org_account_dataset_zone_idx", [
			"orgId",
			"accountId",
			"dataset",
			"zoneId",
		]),
		PG.index("cf_analytics_state_org_idx", ["orgId"]),
	],
	tenantColumn: "orgId",
})

export type CloudflareAnalyticsStateRow = PG.SelectRowOf<typeof CloudflareAnalyticsState>
export type CloudflareAnalyticsStateInsert = PG.InsertRowOf<typeof CloudflareAnalyticsState>
