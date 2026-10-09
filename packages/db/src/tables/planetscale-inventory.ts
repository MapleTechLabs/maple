import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId } from "@maple/domain/primitives"
import { Schema } from "effect"

/**
 * Poll-state for the PlanetScale management-API poller, mirroring
 * `cloudflare_analytics_state`. One row per `(org, dataset, databaseId)`:
 *
 *  - `inventory` uses `databaseId = ""`: the org-wide anchor row that also
 *    carries the tick-overlap lease.
 *  - `deploy_requests` uses the PlanetScale database id; `watermarkAt` tracks
 *    the newest `updated_at` already fanned into `planetscale_events`.
 *  - `insights` is branch-scoped, so its key is `"{databaseId}:{branchName}"`;
 *    query insights are reported per branch and one row per database would
 *    collapse them.
 *
 * There is deliberately no `backfillAt`: unlike Cloudflare analytics, none of
 * these datasets walks history downward.
 */
export const PlanetscalePollState = PG.table("planetscale_poll_state", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		dataset: PG.text,
		// "" for the org-wide inventory anchor row, kept NOT NULL so the unique
		// index treats it like any other row.
		databaseId: PG.column(PG.text, { name: "database_id", default: "" }),
		enabled: PG.column(PG.bool, { default: true }),
		/** Frontier of ingested data (insights dataset); null until the first poll. */
		watermarkAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "watermark_at" }),
		lastSuccessAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_success_at" }),
		lastError: PG.column(PG.nullable(PG.text), { name: "last_error" }),
		lastErrorAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_error_at" }),
		// Overlap guard: a tick claims an org by bumping this past now; a competing
		// tick that fails to claim skips the org.
		leaseUntil: PG.column(PG.nullable(PG.timestamptzMillis), { name: "lease_until" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("planetscale_poll_state_org_dataset_db_idx", ["orgId", "dataset", "databaseId"]),
		PG.index("planetscale_poll_state_org_idx", ["orgId"]),
	],
	tenantColumn: "orgId",
})

export type PlanetScalePollStateRow = PG.SelectRowOf<typeof PlanetscalePollState>
export type PlanetScalePollStateInsert = PG.InsertRowOf<typeof PlanetscalePollState>

/** One branch of a PlanetScale database, stored inline on the database row. */
export const PlanetScaleBranchInfo = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	production: Schema.Boolean,
	ready: Schema.Boolean,
})
export type PlanetScaleBranchInfo = typeof PlanetScaleBranchInfo.Type

/**
 * The org's PlanetScale database inventory, refreshed hourly from the
 * management API. Consumed by the service map (branding + metric overlay
 * matching) and the /infra/planetscale page. Rows whose database disappeared
 * upstream are soft-deleted (`deletedAt`) so a re-appearing database keeps its
 * identity instead of re-registering.
 */
export const PlanetscaleDatabases = PG.table("planetscale_databases", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		/** PlanetScale's database id. */
		databaseId: PG.column(PG.text, { name: "database_id" }),
		name: PG.text,
		/** Product kind: "mysql" (Vitess) or "postgresql". */
		kind: PG.column(PG.text, { default: "mysql" }),
		state: PG.nullable(PG.text),
		region: PG.nullable(PG.text),
		plan: PG.nullable(PG.text),
		branchesJson: PG.column(PG.nullable(PG.jsonb(Schema.Array(PlanetScaleBranchInfo))), { name: "branches_json" }),
		deletedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "deleted_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("planetscale_databases_org_db_idx", ["orgId", "databaseId"]),
		PG.index("planetscale_databases_org_idx", ["orgId"]),
	],
	tenantColumn: "orgId",
})

export type PlanetScaleDatabaseRow = PG.SelectRowOf<typeof PlanetscaleDatabases>
export type PlanetScaleDatabaseInsert = PG.InsertRowOf<typeof PlanetscaleDatabases>

/**
 * The PlanetScale lifecycle timeline: deploy-request state transitions and
 * branch lifecycle events, which the charts render as markers and the drill-in
 * renders as an activity feed.
 *
 * Two convergent sources write here (the webhook queue (live) and the
 * deploy-request REST backfill (history, and orgs that connected after the
 * fact)), so idempotency is the load-bearing requirement, not volume. The
 * dedupe index plus `onConflictDoNothing` makes queue redelivery and repeated
 * backfills no-ops. That is also why this is Postgres and not the warehouse:
 * ClickHouse would need ReplacingMergeTree + FINAL to say the same thing, for a
 * dataset of tens of rows per org per day whose only read is "the last N for
 * database X in [start, end]".
 *
 * Health events (OOM, storage, anomaly) land here *as well as* creating their
 * `kind="integration"` issue, so the timeline is the whole story.
 *
 * Not a generic annotation store: that needs a source registry, cross-source
 * ordering and per-source ACLs, and has no second consumer yet. Extract one
 * when a second provider (Cloudflare deploys, GitHub releases) arrives.
 * `service_releases_timeline` is the other marker source and stays separate
 * because it is trace-derived rather than delivered.
 */
export const PlanetscaleEvents = PG.table("planetscale_events", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		/** PlanetScale's database id when resolvable; "" for webhooks that carry only the name. */
		databaseId: PG.column(PG.text, { name: "database_id", default: "" }),
		databaseName: PG.column(PG.text, { name: "database_name" }),
		branchName: PG.column(PG.text, { name: "branch_name", default: "" }),
		/** "deploy_request" | "branch" | "database" | "cluster" | "keyspace" */
		category: PG.text,
		/** Raw PlanetScale event string, e.g. "deploy_request.schema_applied". */
		eventType: PG.column(PG.text, { name: "event_type" }),
		/** Normalized lifecycle state; null for events that aren't state transitions. */
		state: PG.nullable(PG.text),
		/** Upstream identity: deploy-request number, branch id. "" when the event has none. */
		externalId: PG.column(PG.text, { name: "external_id", default: "" }),
		title: PG.text,
		/** "webhook" | "backfill" */
		source: PG.text,
		actorLogin: PG.column(PG.nullable(PG.text), { name: "actor_login" }),
		url: PG.nullable(PG.text),
		payloadJson: PG.column(PG.nullable(PG.jsonb(Schema.Record(Schema.String, Schema.Unknown))), {
			name: "payload_json",
		}),
		/**
		 * Truncated to whole seconds. PlanetScale's webhook `timestamp` is epoch
		 * SECONDS while the REST backfill carries millisecond precision; without
		 * truncation the same transition inserts twice under the dedupe index.
		 */
		occurredAt: PG.column(PG.timestamptzMillis, { name: "occurred_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("planetscale_events_dedupe_idx", ["orgId", "databaseName", "eventType", "externalId", "occurredAt"]),
		PG.index("planetscale_events_org_db_time_idx", ["orgId", "databaseName", "occurredAt"]),
		PG.index("planetscale_events_org_time_idx", ["orgId", "occurredAt"]),
	],
	tenantColumn: "orgId",
})

export type PlanetScaleEventRow = PG.SelectRowOf<typeof PlanetscaleEvents>
export type PlanetScaleEventInsert = PG.InsertRowOf<typeof PlanetscaleEvents>

/**
 * Exactly-once guard for issue mutations driven by an at-least-once queue.
 * The receipt is inserted in the same transaction as the issue update, so a
 * crash before commit leaves both absent and a retry can safely finish them.
 */
export const PlanetscaleIssueReceipts = PG.table("planetscale_issue_receipts", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		eventId: PG.column(PG.text, { name: "event_id" }),
		processedAt: PG.column(PG.timestamptzMillis, { name: "processed_at" }),
	},
	primaryKey: { columns: ["orgId", "eventId"], name: "planetscale_issue_receipts_org_id_event_id_pk" },
	indexes: [PG.index("planetscale_issue_receipts_processed_at_idx", ["processedAt"])],
	tenantColumn: "orgId",
})

export type PlanetScaleIssueReceiptRow = PG.SelectRowOf<typeof PlanetscaleIssueReceipts>
