import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId } from "@maple/primitives"

// One row per org and UTC day whose storage Autumn has accepted. A day without one is billed
// again on the next metering tick, under the same idempotency key, until it is old enough to drop.
export const StorageBillingRuns = PG.table("storage_billing_runs", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		/** Start of the UTC day billed. */
		day: PG.timestamptzMillis,
		/** GB-months tracked to Autumn for the day. */
		gbMonths: PG.column(PG.float8, { name: "gb_months" }),
		billedAt: PG.column(PG.timestamptzMillis, { name: "billed_at", defaultExpr: "now()" }),
	},
	primaryKey: ["orgId", "day"],
	indexes: [PG.index("storage_billing_runs_day_idx", ["day"])],
	tenantColumn: "orgId",
})

export type StorageBillingRunRow = PG.SelectRowOf<typeof StorageBillingRuns>
