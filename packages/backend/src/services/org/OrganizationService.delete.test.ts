import { randomUUID } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Exit, Layer, Option, Schema, Array as Arr, Record as Rec } from "effect"
import { FetchHttpClient } from "effect/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { ErrorIssueVerifications } from "@maple/db/tables"
import { OrganizationForbiddenError, OrgId, RoleName } from "@maple/domain/http"
import { ErrorIssueId, ErrorIssuePullRequestId, ErrorIssueVerificationId } from "@maple/domain/primitives"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import { countOrgRows, ORG_A, ORG_B, seedOrgRow } from "@maple/backend/platform/test-two-orgs"
import { AutumnClient } from "@maple/backend/services/billing/autumn-http"
import { OrganizationRegionService } from "./OrganizationRegionService"
import { ORG_DELETE_REGISTRY, OrganizationService } from "./OrganizationService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

// The region service is irrelevant to delete; `servesAll` spares it the edge cache.
const makeLayer = (testDb: TestDb) =>
	Layer.effect(OrganizationService, OrganizationService.make).pipe(
		Layer.provide(
			Layer.mergeAll(AutumnClient.layer, OrganizationRegionService.servesAll, FetchHttpClient.layer),
		),
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({
					PORT: "3474",
					MCP_PORT: "3475",
					TINYBIRD_HOST: "https://api.tinybird.co",
					TINYBIRD_TOKEN: "test-token",
					// Self-hosted: no Clerk, so delete touches nothing but Postgres.
					MAPLE_AUTH_MODE: "self_hosted",
					MAPLE_ROOT_PASSWORD: "test-root-password",
					MAPLE_DEFAULT_ORG_ID: "default",
					MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
					MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
				}),
			),
		),
	)

const role = Schema.decodeUnknownSync(RoleName)

/** Every purged table with the column that ties its rows to an org. */
const purgedTables = [
	...Arr.map(ORG_DELETE_REGISTRY.orgScoped, (table) => ({ name: table.ddl.table.name, column: "org_id" })),
	...Arr.map(ORG_DELETE_REGISTRY.approvedOrgScoped, (table) => ({
		name: table.ddl.table.name,
		column: "approved_org_id",
	})),
]

/** One row per purged table for each org; returns per-table counts for both. */
const seedBothOrgs = (testDb: TestDb) =>
	Effect.forEach(
		purgedTables,
		(table) =>
			Effect.all([
				seedOrgRow(testDb, table.name, table.column, ORG_A),
				seedOrgRow(testDb, table.name, table.column, ORG_B),
			]),
		{ discard: true },
	)

const countsFor = (testDb: TestDb, orgId: OrgId) =>
	Effect.forEach(purgedTables, (table) =>
		countOrgRows(testDb, table.name, table.column, orgId).pipe(
			Effect.map((count) => [table.name, count] as const),
		),
	).pipe(Effect.map((entries) => Rec.fromEntries(entries)))

const everyTableAt = (count: number) => Rec.fromEntries(Arr.map(purgedTables, (table) => [table.name, count]))

describe("OrganizationService.delete", () => {
	it.effect("purges every registered table for the deleted org and leaves the other org intact", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			// An empty registry would make every assertion below vacuous.
			assert.isAbove(purgedTables.length, 0)
			yield* seedBothOrgs(testDb)
			// The seed must actually land in every table, or "B is intact" proves nothing.
			assert.deepStrictEqual(yield* countsFor(testDb, ORG_A), everyTableAt(1))
			assert.deepStrictEqual(yield* countsFor(testDb, ORG_B), everyTableAt(1))

			const organizations = yield* OrganizationService
			yield* organizations.delete(ORG_A, [role("org:admin")])

			assert.deepStrictEqual(yield* countsFor(testDb, ORG_A), everyTableAt(0))
			assert.deepStrictEqual(yield* countsFor(testDb, ORG_B), everyTableAt(1))
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("refuses a non-admin and deletes nothing", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* seedBothOrgs(testDb)
			const organizations = yield* OrganizationService

			const exit = yield* Effect.exit(organizations.delete(ORG_A, [role("org:member")]))

			assert.isTrue(Exit.isFailure(exit))
			assert.instanceOf(Option.getOrUndefined(Exit.findErrorOption(exit)), OrganizationForbiddenError)
			assert.deepStrictEqual(yield* countsFor(testDb, ORG_A), everyTableAt(1))
			assert.deepStrictEqual(yield* countsFor(testDb, ORG_B), everyTableAt(1))
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("refuses to delete an org other orgs are billed through", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					"INSERT INTO org_billing_links (org_id, billing_org_id, linked_by, created_at) VALUES ($1, $2, 'user_a', now())",
					[ORG_B, ORG_A],
				),
			)
			const organizations = yield* OrganizationService

			const exit = yield* Effect.exit(organizations.delete(ORG_A, [role("org:admin")]))
			assert.instanceOf(Option.getOrUndefined(Exit.findErrorOption(exit)), OrganizationForbiddenError)

			// The member itself can still go, and takes its link with it.
			yield* organizations.delete(ORG_B, [role("org:admin")])
			assert.strictEqual(yield* countOrgRows(testDb, "org_billing_links", "billing_org_id", ORG_A), 0)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("leaves the verification tick nothing due for the deleted org", () => {
		const testDb = createTestDb(trackedDbs)
		const NOW_MS = Date.UTC(2026, 6, 6, 9, 0, 0)
		const waiting = (orgId: OrgId) => ({
			id: ErrorIssueVerificationId.make(randomUUID()),
			orgId,
			issueId: ErrorIssueId.make(randomUUID()),
			pullRequestId: ErrorIssuePullRequestId.make(randomUUID()),
			mergedAt: NOW_MS - 7_200_000,
			verifyAfter: NOW_MS - 3_600_000,
			createdAt: NOW_MS - 7_200_000,
			updatedAt: NOW_MS - 7_200_000,
		})
		return Effect.gen(function* () {
			const database = yield* Database
			yield* database.execute((db) =>
				db.run(PG.insertInto(ErrorIssueVerifications).values([waiting(ORG_A), waiting(ORG_B)])),
			)
			const organizations = yield* OrganizationService
			yield* organizations.delete(ORG_A, [role("org:admin")])

			// What the tick selects: every org's waiting rows whose window has closed.
			const due = yield* database.execute((db) =>
				db.run(
					PG.from(ErrorIssueVerifications)
						.select("orgId")
						.where(($) => [$.status.eq("waiting"), $.verifyAfter.lte(NOW_MS)]),
				),
			)
			assert.deepStrictEqual(
				Arr.map(due, (row) => row.orgId),
				[ORG_B],
			)
		}).pipe(Effect.provide(Layer.merge(makeLayer(testDb), testDb.layer)))
	})
})
