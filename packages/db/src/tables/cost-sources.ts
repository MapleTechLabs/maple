import * as PG from "@maple-dev/effect-orm/postgres"
import { CostProvider } from "@maple/domain/cost"
import { CostSourceId, OrgId } from "@maple/primitives"

// One row per provider connection an org's cloud cost is pulled from. The cost sync creates it
// when the connection supplies cost, turns it off while it does not, and removes it with the
// connection; its rows in `cost_daily` stay. The poll-state columns belong to the sync.
export const CostSources = PG.table("cost_sources", {
	columns: {
		id: PG.brand(PG.text, CostSourceId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		provider: PG.brand(PG.text, CostProvider),
		// The id of the provider's own connection row (`aws_connections.id` for aws). No foreign
		// key: the table differs per provider, so the sync removes rows whose connection is gone.
		connectionRef: PG.column(PG.text, { name: "connection_ref" }),
		// The provider's account, as the connection named it when the source was made.
		accountId: PG.column(PG.text, { name: "account_id" }),
		// False while the connection does not supply cost (not asked for, or not granted); the sync
		// skips it, its state and history stay. The sync sets it, and deletes the row with the connection.
		enabled: PG.column(PG.bool, { default: true }),
		// HEAD frontier: the newest UTC day (YYYY-MM-DD) pulled, usually today and still estimated.
		// Null until the first pull.
		watermarkDate: PG.column(PG.nullable(PG.text), { name: "watermark_date" }),
		// BACKFILL frontier: the oldest UTC day (YYYY-MM-DD) pulled, walking DOWN a month per step
		// toward the history floor. Null before the first pull seeds it.
		backfillDate: PG.column(PG.nullable(PG.text), { name: "backfill_date" }),
		// Last head or settle pull; the head is due again a day later.
		lastSyncedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_synced_at" }),
		// Last re-pull of the open months, which picks up what the provider restated.
		lastSettledAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_settled_at" }),
		lastError: PG.column(PG.nullable(PG.text), { name: "last_error" }),
		// The `CostProviderError` reason of `lastError`, "write" when the warehouse write failed, or
		// "budget" while the month's request budget holds the source.
		lastErrorReason: PG.column(PG.nullable(PG.text), { name: "last_error_reason" }),
		// Overlap guard: a tick claims the row by moving this past now; a tick that fails to claim skips it.
		leaseUntil: PG.column(PG.nullable(PG.timestamptzMillis), { name: "lease_until" }),
		// Backoff: the sync skips the row until then. Null when the last sync succeeded.
		nextAttemptAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "next_attempt_at" }),
		// Failed syncs since the last success; the sync's backoff doubles per failure.
		consecutiveFailures: PG.column(PG.int4, { name: "consecutive_failures", default: 0 }),
		// Billable provider API requests made in `requestsMonth` (YYYY-MM, UTC); a new month restarts the count.
		requestsMonth: PG.column(PG.nullable(PG.text), { name: "requests_month" }),
		requestsCount: PG.column(PG.int4, { name: "requests_count", default: 0 }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [PG.uniqueIndex("cost_sources_org_provider_ref_idx", ["orgId", "provider", "connectionRef"])],
	tenantColumn: "orgId",
})

export type CostSourceRow = PG.SelectRowOf<typeof CostSources>
