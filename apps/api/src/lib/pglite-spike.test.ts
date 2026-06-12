import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import { eq, sql } from "drizzle-orm"
import { boolean, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { afterAll, describe, expect, it } from "vitest"

const spikeTable = pgTable("spike_rows", {
	id: text("id").primaryKey(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
	enabled: boolean("enabled").notNull().default(true),
	payloadJson: jsonb("payload_json").$type<{ kind: string; values: ReadonlyArray<number> }>(),
	tagsJson: jsonb("tags_json").$type<ReadonlyArray<string>>(),
})

const pglite = new PGlite()
const db = drizzle(pglite, { schema: { spikeTable } })

afterAll(async () => {
	await pglite.close()
})

describe("pglite spike", () => {
	it("applies DDL and round-trips timestamptz/jsonb/boolean", async () => {
		await pglite.exec(`
			CREATE TABLE spike_rows (
				id text PRIMARY KEY,
				created_at timestamptz NOT NULL DEFAULT now(),
				enabled boolean NOT NULL DEFAULT true,
				payload_json jsonb,
				tags_json jsonb
			);
		`)

		const when = new Date("2026-06-13T12:34:56.789Z")
		await db.insert(spikeTable).values({
			id: "a",
			createdAt: when,
			enabled: false,
			payloadJson: { kind: "test", values: [1, 2, 3] },
			tagsJson: ["x", "y"],
		})

		const row = await db.query.spikeTable.findFirst({ where: eq(spikeTable.id, "a") })
		expect(row).toBeDefined()
		expect(row!.createdAt.getTime()).toBe(when.getTime())
		expect(row!.enabled).toBe(false)
		// jsonb must come back as a real object — a string here means double-stringify
		expect(row!.payloadJson).toEqual({ kind: "test", values: [1, 2, 3] })
		expect(row!.tagsJson).toEqual(["x", "y"])

		// raw read confirms storage is real jsonb, not a quoted string
		const raw = await pglite.query<{ t: string }>(
			"SELECT jsonb_typeof(payload_json) AS t FROM spike_rows WHERE id = $1",
			["a"],
		)
		expect(raw.rows[0]?.t).toBe("object")
	})

	it("supports defaults, transactions, and >100 bound params", async () => {
		await db.transaction(async (tx) => {
			await tx.insert(spikeTable).values({ id: "b", payloadJson: null, tagsJson: null })
			await tx
				.insert(spikeTable)
				.values(
					Array.from({ length: 60 }, (_, i) => ({
						id: `bulk-${i}`,
						payloadJson: { kind: "bulk", values: [i] },
						tagsJson: [],
					})),
				)
		})

		const row = await db.query.spikeTable.findFirst({ where: eq(spikeTable.id, "b") })
		expect(row!.enabled).toBe(true)
		expect(row!.createdAt).toBeInstanceOf(Date)

		const count = await db
			.select({ n: sql<number>`count(*)::int` })
			.from(spikeTable)
		expect(count[0]!.n).toBe(62)
	})
})
