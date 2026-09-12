import type { OrgId } from "@maple/domain"
import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

// Reconciliation ledger for the GA4 collector — the record of what has already been emitted to
// the warehouse, so a re-poll can emit the DIFFERENCE rather than a duplicate.
//
// WHY THIS EXISTS: `metrics_sum` is a plain MergeTree with no dedupe, and GA4 revises past hours
// for ~48h. Writing the re-polled value again would leave two rows at the same timestamp and
// every reducer would read wrong — `sum` double-counts, `avg` blends stale with fresh, `max`
// breaks on a downward revision. Instead each hour is emitted as a DELTA-temporality sum of
// `newValue - lastEmitted`, which makes `sum(Value)` per bucket exactly the current GA4 truth and
// turns a downward revision into a negative delta.
//
// SHAPE: one row per (org, property, dataset, bucket) holding a JSON map of seriesHash → last
// emitted value — NOT one row per series. A single property is then ~48h x 6 datasets = ~288 rows
// instead of ~9k; the per-series spelling would put ~930k rows on the PlanetScale primary at 100
// properties, and we have already paid for main-branch bloat once.
//
// LIFETIME: rows are pruned once their bucket falls behind the owning state row's
// `frozenThroughAt` — the hour is final by then, so there is nothing left to reconcile against.
export const googleAnalyticsLedger = pgTable(
	"google_analytics_ledger",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		propertyId: text("property_id").notNull(),
		dataset: text("dataset").notNull(),
		// START of the hour bucket these emissions belong to (UTC), matching the metric row's
		// `TimeUnix`. GA4's `dateHour` dimension is hour-resolution, so this is always hour-aligned.
		bucketAt: timestamp("bucket_at", { withTimezone: true, mode: "date" }).notNull(),
		// JSON object: seriesHash → cumulative value already emitted for that series in this bucket.
		// The series hash covers the metric name plus the sorted dimension tuple, so two series that
		// differ only in, say, `country` never collide. Absent key = nothing emitted yet, so the
		// first emission is the raw value.
		emittedJson: text("emitted_json").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("ga_ledger_org_property_dataset_bucket_idx").on(
			table.orgId,
			table.propertyId,
			table.dataset,
			table.bucketAt,
		),
		// Drives the prune sweep, which deletes by (org, property, dataset) below a bucket boundary.
		index("ga_ledger_org_bucket_idx").on(table.orgId, table.bucketAt),
	],
)

export type GoogleAnalyticsLedgerRow = typeof googleAnalyticsLedger.$inferSelect
export type GoogleAnalyticsLedgerInsert = typeof googleAnalyticsLedger.$inferInsert
