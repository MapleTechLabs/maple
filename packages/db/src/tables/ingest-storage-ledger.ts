import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId } from "@maple/primitives"

// Billable bytes the gateway metered, per org, billed signal, UTC day and retention stamp.
// Storage is the sum of the days still inside their stamp; rows past the longest period are pruned.
export const IngestStorageLedger = PG.table("ingest_storage_ledger", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		/** The Autumn ingest feature the bytes were billed under: logs, traces, metrics or profiles. */
		signal: PG.text,
		/** Start of the UTC day the bytes were ingested. */
		day: PG.timestamptzMillis,
		retentionDays: PG.column(PG.int4, { name: "retention_days" }),
		bytes: PG.column(PG.int8, { default: 0 }),
	},
	primaryKey: ["orgId", "signal", "day", "retentionDays"],
	indexes: [PG.index("ingest_storage_ledger_day_idx", ["day"])],
	tenantColumn: "orgId",
})

export type IngestStorageLedgerRow = PG.SelectRowOf<typeof IngestStorageLedger>
