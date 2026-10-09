import { randomUUID } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import * as PG from "@maple-dev/effect-orm/postgres"
import { ErrorIssues, ErrorIssueStates, OrgClickHouseSettings } from "@maple/db/tables"
import { ErrorIssueId, OrgId } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { selectDistinctOrgIds } from "@maple/backend/platform/distinct-org-ids"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"

const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asIssueId = Schema.decodeUnknownSync(ErrorIssueId)

const issueRow = (org: string, suffix: string) => ({
	id: asIssueId(randomUUID()),
	orgId: asOrgId(org),
	fingerprintHash: `fp_${org}_${suffix}`,
	serviceName: "checkout-api",
	exceptionType: "TimeoutError",
	exceptionMessage: "upstream timed out",
	topFrame: "",
	firstSeenAt: 0,
	lastSeenAt: 0,
	createdAt: 0,
	updatedAt: 0,
})

describe("selectDistinctOrgIds", () => {
	it.effect("returns the same set as SELECT DISTINCT, in ascending order", () =>
		Effect.gen(function* () {
			const db = createTestDb(createdDbs)
			const database = yield* Database.pipe(Effect.provide(db.layer))

			// Duplicates per org are the point: a loose index scan must emit each
			// org exactly once no matter how many rows it owns.
			yield* database.execute((client) =>
				client.orm.run(
					PG.insertInto(ErrorIssues).values([
						issueRow("org_c", "1"),
						issueRow("org_a", "1"),
						issueRow("org_a", "2"),
						issueRow("org_a", "3"),
						issueRow("org_b", "1"),
						issueRow("org_b", "2"),
					]),
				),
			)

			const loose = yield* database.execute((client) => selectDistinctOrgIds(client.orm, ErrorIssues))
			const baseline = yield* database.execute((client) =>
				client.orm.run(PG.from(ErrorIssues).select("orgId").distinct()),
			)

			assert.deepStrictEqual([...loose], ["org_a", "org_b", "org_c"])
			assert.deepStrictEqual([...loose].sort(), baseline.map((row) => row.orgId).sort())
		}),
	)

	it.effect("returns an empty list for an empty table", () =>
		Effect.gen(function* () {
			const db = createTestDb(createdDbs)
			const database = yield* Database.pipe(Effect.provide(db.layer))

			const loose = yield* database.execute((client) => selectDistinctOrgIds(client.orm, ErrorIssues))
			assert.deepStrictEqual([...loose], [])
		}),
	)

	it.effect("walks a composite primary key and a single-column primary key", () =>
		Effect.gen(function* () {
			const db = createTestDb(createdDbs)
			const database = yield* Database.pipe(Effect.provide(db.layer))

			yield* database.execute((client) =>
				Effect.gen(function* () {
					yield* client.orm.run(
						PG.insertInto(ErrorIssueStates).values([
							{ orgId: asOrgId("org_b"), issueId: asIssueId(randomUUID()), updatedAt: 0 },
							{ orgId: asOrgId("org_b"), issueId: asIssueId(randomUUID()), updatedAt: 0 },
							{ orgId: asOrgId("org_a"), issueId: asIssueId(randomUUID()), updatedAt: 0 },
						]),
					)
					yield* client.orm.run(
						PG.insertInto(OrgClickHouseSettings).values(
							["org_z", "org_y"].map((orgId) => ({
								orgId: asOrgId(orgId),
								chUrl: "https://ch.example",
								chUser: "default",
								chDatabase: "maple",
								syncStatus: "connected",
								createdAt: 0,
								updatedAt: 0,
								createdBy: "test",
								updatedBy: "test",
							})),
						),
					)
				}),
			)

			const states = yield* database.execute((client) =>
				selectDistinctOrgIds(client.orm, ErrorIssueStates),
			)
			const settings = yield* database.execute((client) =>
				selectDistinctOrgIds(client.orm, OrgClickHouseSettings),
			)

			assert.deepStrictEqual([...states], ["org_a", "org_b"])
			assert.deepStrictEqual([...settings], ["org_y", "org_z"])
		}),
	)
})
