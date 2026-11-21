import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId } from "@maple/primitives"
import { CostConnections } from "./cost-connections"

/**
 * Morph serves only each member's spend so far this UTC month, so the cost sync keeps what it reads:
 * per member and day, the first and the last reading. A day's cost is its last reading less the
 * one before it. Deleting the Morph connection deletes its readings.
 */
export const MorphSpendReadings = PG.table("morph_spend_readings", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		connectionId: PG.column(PG.text, { name: "connection_id" }),
		/** The UTC month Morph said the spend covers, `YYYY-MM`. */
		month: PG.text,
		/** The UTC day the readings were taken, `YYYY-MM-DD`, inside `month`. */
		day: PG.text,
		memberId: PG.column(PG.text, { name: "member_id" }),
		/** The member's email when Morph gives one, else the id. */
		memberLabel: PG.column(PG.text, { name: "member_label" }),
		/** Month-to-date spend at the day's first reading, in millionths of a US dollar. */
		openingMicros: PG.column(PG.int8, { name: "opening_micros" }),
		/** Month-to-date spend at the day's last reading, in millionths of a US dollar. */
		closingMicros: PG.column(PG.int8, { name: "closing_micros" }),
		firstReadAt: PG.column(PG.timestamptzMillis, { name: "first_read_at" }),
		lastReadAt: PG.column(PG.timestamptzMillis, { name: "last_read_at" }),
	},
	primaryKey: ["connectionId", "month", "memberId", "day"],
	indexes: [PG.index("morph_spend_readings_org_idx", ["orgId"])],
	foreignKeys: [
		PG.foreignKey({
			columns: ["connectionId"],
			references: CostConnections,
			foreignColumns: ["id"],
			onDelete: "cascade",
		}),
	],
	tenantColumn: "orgId",
})

export type MorphSpendReadingRow = PG.SelectRowOf<typeof MorphSpendReadings>
