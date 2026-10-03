import type { OrgId } from "@maple/domain"
import { boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

// Poll-state for the GA4 Data API collector. One row per (org, property, dataset): every
// dataset in the DATASETS registry gets its own row per discovered property, so a dataset that
// falls behind (or that GA4 rejects for one property) does not hold up the others.
//
// The table doubles as the org's property cache. Property discovery (Admin API
// `accountSummaries.list`) reconciles rows on an hourly TTL, soft-disabling rows whose property
// disappeared so a re-appearing property resumes from its old watermark instead of re-backfilling.
//
// DISCOVERY ANCHOR: discovery is grant-wide, not per-property, so it cannot live on a property
// row (there may be none yet on a fresh connect). The anchor is the reserved row with
// propertyId = "" and dataset = "__discovery__" — it holds `discoveredAt` and nothing else, and
// is skipped by every poll pass.
export const googleAnalyticsState = pgTable(
	"google_analytics_state",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		// Bare GA4 property id ("123456789"), not the API's "properties/123456789" resource name —
		// the resource prefix is re-added at the call site so this stays usable as a label.
		// "" only on the discovery anchor row.
		propertyId: text("property_id").notNull().default(""),
		// GA4 property display name, and the account summary it came from. Cached for the
		// integration card and for the metric rows' resource attributes.
		propertyName: text("property_name"),
		accountName: text("account_name"),
		// IANA reporting timezone of the property ("America/Los_Angeles"), from the Admin API's
		// `properties.get`. Load-bearing, not decoration: GA4's `dateHour` dimension is expressed in
		// THIS zone, so without it every bucket lands at the wrong UTC instant for any property not
		// set to UTC — silently, and off by a whole number of hours. Fetched lazily once per
		// property (accountSummaries does not carry it) and cached here; null means "not resolved
		// yet", and the property is not polled until it is.
		timeZone: text("time_zone"),
		dataset: text("dataset").notNull(),
		enabled: boolean("enabled").notNull().default(true),
		// HEAD frontier: END of the newest hour bucket ingested. The poll fetches the newest window
		// first so a freshly-connected property shows data within one tick. Null until the first poll.
		watermarkAt: timestamp("watermark_at", { withTimezone: true, mode: "date" }),
		// BACKFILL frontier: OLDEST hour boundary the history fill has reached, walking DOWN toward
		// the backfill floor. Seeded to the first head window's start; complete once it hits the floor.
		backfillAt: timestamp("backfill_at", { withTimezone: true, mode: "date" }),
		// RESTATEMENT frontier, and the reason this table is not just Cloudflare's. GA4 keeps
		// revising `dateHour` rows for ~48h after the fact, so an hour is only final once it falls
		// behind this boundary: hours ending at or before it are frozen, never re-polled, and their
		// reconciliation ledger rows are pruned. Everything between here and `watermarkAt` is
		// re-polled each tick and emitted as a delta against the ledger.
		frozenThroughAt: timestamp("frozen_through_at", { withTimezone: true, mode: "date" }),
		// When property discovery (Admin API accountSummaries.list) last ran — set on the discovery
		// anchor row only. Poll ticks in between reuse the known property rows.
		discoveredAt: timestamp("discovered_at", { withTimezone: true, mode: "date" }),
		lastSuccessAt: timestamp("last_success_at", { withTimezone: true, mode: "date" }),
		lastError: text("last_error"),
		lastErrorAt: timestamp("last_error_at", { withTimezone: true, mode: "date" }),
		// Overlap guard: a tick claims an org's rows by bumping this past now; a competing tick that
		// fails to claim skips the org. Deliberately NOT cleared on a GA4 quota rejection — it is
		// held through the backoff so the next tick skips instead of re-depleting the property's
		// token budget.
		leaseUntil: timestamp("lease_until", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("ga_analytics_state_org_property_dataset_idx").on(
			table.orgId,
			table.propertyId,
			table.dataset,
		),
		index("ga_analytics_state_org_idx").on(table.orgId),
	],
)

export type GoogleAnalyticsStateRow = typeof googleAnalyticsState.$inferSelect
export type GoogleAnalyticsStateInsert = typeof googleAnalyticsState.$inferInsert
