import { createClient } from "@libsql/client"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { orgRecommendationIssues } from "../schema"
import * as schema from "../schema"

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle")

describe("org_recommendation_issues migration", () => {
	it("creates the table and round-trips an issue row on a fresh database", async () => {
		const client = createClient({ url: ":memory:" })
		const db = drizzle(client, { schema })
		await migrate(db, { migrationsFolder })

		await db.insert(orgRecommendationIssues).values({
			id: "issue-1",
			orgId: "org_a",
			number: 1,
			recommendationKey: "rename:http.status_code",
			kind: "rename",
			sourceKey: "http.status_code",
			canonicalKey: "http.response.status_code",
			status: "open",
			usageCount: 42,
		})

		const rows = await db
			.select()
			.from(orgRecommendationIssues)
			.where(eq(orgRecommendationIssues.orgId, "org_a"))

		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			number: 1,
			recommendationKey: "rename:http.status_code",
			kind: "rename",
			status: "open",
			usageCount: 42,
			canonicalKey: "http.response.status_code",
		})
		// defaults applied
		expect(rows[0]!.openedAt).toBeGreaterThan(0)
		expect(rows[0]!.resolvedAt).toBeNull()

		client.close()
	})

	it("enforces one issue per (org, recommendationKey)", async () => {
		const client = createClient({ url: ":memory:" })
		const db = drizzle(client, { schema })
		await migrate(db, { migrationsFolder })

		const row = {
			orgId: "org_a",
			number: 1,
			recommendationKey: "rename:http.status_code",
			kind: "rename",
			sourceKey: "http.status_code",
			canonicalKey: "http.response.status_code",
			status: "open",
		}
		await db.insert(orgRecommendationIssues).values({ id: "issue-1", ...row })
		await expect(
			db.insert(orgRecommendationIssues).values({ id: "issue-2", ...row }),
		).rejects.toThrow()

		client.close()
	})
})
