import { createClient } from "@libsql/client"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { orgClickHouseSettings } from "../schema"
import * as schema from "../schema"
import { migrateClickHouseSchemaVersionRekey } from "./0025-clickhouse-schema-version-rekey"

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle")

const OLD_REVISION = "019c3db4cf690e3748b302098cae4c9213d18c55355db9fc68ea44982c7a980a"

const seedRow = (orgId: string, schemaVersion: string | null) => ({
	orgId,
	chUrl: "https://ch.example",
	chUser: "default",
	chDatabase: "default",
	syncStatus: "connected",
	schemaVersion,
	createdAt: 1,
	updatedAt: 1,
	createdBy: "u",
	updatedBy: "u",
})

const freshDb = async () => {
	const client = createClient({ url: ":memory:" })
	const db = drizzle(client, { schema })
	await migrate(db, { migrationsFolder })
	return { client, db }
}

const schemaVersionOf = async (
	db: Awaited<ReturnType<typeof freshDb>>["db"],
	orgId: string,
): Promise<string | null> => {
	const rows = await db.select().from(orgClickHouseSettings).where(eq(orgClickHouseSettings.orgId, orgId))
	return rows[0]?.schemaVersion ?? null
}

describe("migrateClickHouseSchemaVersionRekey", () => {
	it("re-keys only the cutover project revision to the migration version", async () => {
		const { client, db } = await freshDb()
		await db
			.insert(orgClickHouseSettings)
			.values([
				seedRow("org_ready_old", OLD_REVISION),
				seedRow("org_stale", "4d5d918315933608d316aa8d6e6b57948f15a3fdca2fa6226aa271553f0b0520"),
				seedRow("org_already_new", "4"),
				seedRow("org_never_applied", null),
			])

		await migrateClickHouseSchemaVersionRekey(db)

		// The org that was "ready" under the old hash carries forward as ready.
		expect(await schemaVersionOf(db, "org_ready_old")).toBe("4")
		// A stale/older revision is NOT blindly translated — we can't prove its CH is
		// at migration 4 from D1 alone; it self-heals via schemaDiff instead.
		expect(await schemaVersionOf(db, "org_stale")).toBe(
			"4d5d918315933608d316aa8d6e6b57948f15a3fdca2fa6226aa271553f0b0520",
		)
		// Already-new and never-applied rows are untouched.
		expect(await schemaVersionOf(db, "org_already_new")).toBe("4")
		expect(await schemaVersionOf(db, "org_never_applied")).toBeNull()

		client.close()
	})

	it("is guarded — a second run does not re-translate", async () => {
		const { client, db } = await freshDb()
		await db.insert(orgClickHouseSettings).values([seedRow("org_ready_old", OLD_REVISION)])

		await migrateClickHouseSchemaVersionRekey(db)
		expect(await schemaVersionOf(db, "org_ready_old")).toBe("4")

		// Drift the value back to the old revision after the migration recorded itself;
		// the `_maple_data_migrations` guard means the second run is a no-op.
		await db
			.update(orgClickHouseSettings)
			.set({ schemaVersion: OLD_REVISION })
			.where(eq(orgClickHouseSettings.orgId, "org_ready_old"))
		await migrateClickHouseSchemaVersionRekey(db)
		expect(await schemaVersionOf(db, "org_ready_old")).toBe(OLD_REVISION)

		client.close()
	})
})
