import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core"

// Per-org billing dunning state for the ingest gateway's "stop ingestion once
// 3 days overdue and never paid" policy. Written exclusively by the Autumn
// webhook receiver (`overdue_since`, on the `billing.updated` past_due signal)
// and the daily reconcile cron (`suspended_at`, once overdue ≥3d and the org
// has never paid an invoice). The ingest gateway reads this table during key
// resolution and 402s when `suspended_at IS NOT NULL`. A row with a null
// `suspended_at` is an org that is overdue but not yet suspended.
export const orgBillingSuspensions = pgTable(
	"org_billing_suspensions",
	{
		orgId: text("org_id").notNull(),
		// When Autumn first reported the subscription as past_due — the overdue clock.
		overdueSince: timestamp("overdue_since", { withTimezone: true, mode: "date" }).notNull(),
		// Set once the cron promotes the org to suspended (overdue ≥3d + never paid).
		// Null = overdue-only. This column is the gateway's enforcement flag.
		suspendedAt: timestamp("suspended_at", { withTimezone: true, mode: "date" }),
		// The unpaid Stripe invoice id captured at suspension time (audit only).
		overdueInvoiceId: text("overdue_invoice_id"),
		reason: text("reason"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [primaryKey({ columns: [table.orgId] })],
)

export type OrgBillingSuspensionRow = typeof orgBillingSuspensions.$inferSelect
export type OrgBillingSuspensionInsert = typeof orgBillingSuspensions.$inferInsert
