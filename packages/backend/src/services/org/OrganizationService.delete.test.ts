import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import { OrganizationForbiddenError, OrgId, RoleName } from "@maple/domain/http"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { countOrgRows, ORG_A, ORG_B, seedOrgRow } from "@maple/backend/platform/test-two-orgs"
import { AutumnClient } from "@maple/backend/services/billing/autumn-http"
import { OrganizationRegionService } from "./OrganizationRegionService"
import { ORG_DELETE_REGISTRY, OrganizationService } from "./OrganizationService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

// The region service is irrelevant to delete; `servesAll` spares it the edge cache.
const makeLayer = (testDb: TestDb) =>
	Layer.effect(OrganizationService, OrganizationService.make).pipe(
		Layer.provide(Layer.mergeAll(AutumnClient.layer, OrganizationRegionService.servesAll)),
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
	...ORG_DELETE_REGISTRY.orgScoped.map((table) => ({ name: table.ddl.table.name, column: "org_id" })),
	...ORG_DELETE_REGISTRY.approvedOrgScoped.map((table) => ({
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
	).pipe(Effect.map((entries) => Object.fromEntries(entries)))

const everyTableAt = (count: number) => Object.fromEntries(purgedTables.map((table) => [table.name, count]))

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
})
