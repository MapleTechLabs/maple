import { afterEach, assert, describe, it } from "@effect/vitest"
import { Array as Arr, ConfigProvider, Effect, Layer, Result, Schema } from "effect"
import { HttpClient } from "effect/http"
import { AwsAccountId, AwsRegion, OrgId, UserId } from "@maple/primitives"
import { Env } from "@maple/backend/platform/Env"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { AwsConnectionService } from "../integrations/AwsConnectionService"
import { MAPLE_TEST_OIDC_KEY, makeFakeAws } from "../integrations/aws/fake-aws"
import { type CloudFindingWrite, CloudSecurityStore } from "./CloudSecurityStore"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const config = {
	PORT: "3472",
	TINYBIRD_HOST: "https://api.tinybird.co",
	TINYBIRD_TOKEN: "test-token",
	MAPLE_AUTH_MODE: "self_hosted",
	MAPLE_ROOT_PASSWORD: "test-root-password",
	MAPLE_DEFAULT_ORG_ID: "default",
	MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
	MAPLE_INGEST_PUBLIC_URL: "https://ingest.test/",
	MAPLE_API_BASE_URL: "https://api.maple.test/",
	MAPLE_AWS_OIDC_SIGNING_KEY: MAPLE_TEST_OIDC_KEY.privateKey,
}

const orgId = Schema.decodeSync(OrgId)("org_sec")
const otherOrgId = Schema.decodeSync(OrgId)("org_other")
const userId = Schema.decodeSync(UserId)("user_1")
const region = Schema.decodeSync(AwsRegion)("us-east-1")

const queryRows = <T>(db: TestDb, sql: string) => db.pglite.query<T>(sql).then((result) => result.rows)

const makeWorld = () => {
	const testDb = createTestDb(trackedDbs)
	const layer = Layer.mergeAll(
		CloudSecurityStore.layer,
		Layer.effect(AwsConnectionService, AwsConnectionService.make),
	).pipe(
		Layer.provide(OrganizationFeatureFlagsService.allEnabled),
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(Layer.succeed(HttpClient.HttpClient, makeFakeAws().client)),
		Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
	)
	return { testDb, layer }
}

const connect = (org: OrgId, account: string) =>
	AwsConnectionService.use((connections) =>
		connections.create(org, userId, {
			accountId: Schema.decodeSync(AwsAccountId)(account),
			modules: ["security"],
		}),
	)

const finding = (
	connection: {
		readonly id: CloudFindingWrite["connectionId"]
		readonly accountId: CloudFindingWrite["accountId"]
	},
	org: OrgId,
	overrides: Partial<CloudFindingWrite> = {},
): CloudFindingWrite => ({
	orgId: org,
	connectionId: connection.id,
	accountId: connection.accountId,
	region,
	source: "guardduty",
	findingId: "f-1",
	type: "UnauthorizedAccess:EC2/SSHBruteForce",
	title: "SSH brute force against i-0abc",
	description: null,
	severity: "medium",
	status: "active",
	resourceType: "Instance",
	resourceId: "i-0abc",
	resourceName: null,
	occurrences: 1,
	firstSeenAt: 1_000,
	lastSeenAt: 1_000,
	providerUpdatedAt: 1_000,
	detail: null,
	...overrides,
})

describe("CloudSecurityStore", () => {
	it.effect("keeps a finding at the latest version the service reported", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const store = yield* CloudSecurityStore
			const connection = yield* connect(orgId, "111111111111")
			yield* store.upsertFindings([finding(connection, orgId)], 10)
			yield* store.upsertFindings(
				[
					finding(connection, orgId, {
						occurrences: 7,
						lastSeenAt: 5_000,
						providerUpdatedAt: 5_000,
						severity: "high",
					}),
				],
				20,
			)
			const rows = yield* Effect.promise(() =>
				queryRows<{ occurrences: number; severity: string }>(
					world.testDb,
					"SELECT occurrences, severity FROM cloud_security_findings",
				),
			)
			assert.deepStrictEqual(rows, [{ occurrences: 7, severity: "high" }])
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("keeps the cursor when a poll records a state without one", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const store = yield* CloudSecurityStore
			const connection = yield* connect(orgId, "111111111111")
			const base = { orgId, connectionId: connection.id, region, source: "guardduty" as const }
			yield* store.recordServiceState({
				...base,
				state: "enabled",
				cursorAt: 4_000,
				windowMs: null,
				lastError: null,
				checkedAt: 1,
			})
			yield* store.recordServiceState({
				...base,
				state: "failing",
				cursorAt: null,
				windowMs: null,
				lastError: "throttled",
				checkedAt: 2,
			})
			const [state] = yield* store.serviceStates(orgId, connection.id)
			assert.strictEqual(state?.windowMs, null)
			assert.strictEqual(state?.state, "failing")
			assert.strictEqual(state?.cursorAt, 4_000)
			assert.strictEqual(state?.lastError, "throttled")
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("prunes only the org's findings closed before the cutoff", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const store = yield* CloudSecurityStore
			const mine = yield* connect(orgId, "111111111111")
			const theirs = yield* connect(otherOrgId, "222222222222")
			// A finding is stored while open; its closed version then replaces it.
			const open = [
				finding(mine, orgId, { findingId: "old-closed", providerUpdatedAt: 50 }),
				finding(mine, orgId, { findingId: "new-closed", providerUpdatedAt: 50 }),
				finding(theirs, otherOrgId, { findingId: "their-closed", providerUpdatedAt: 50 }),
			]
			yield* store.upsertFindings(
				[...open, finding(mine, orgId, { findingId: "old-active", providerUpdatedAt: 50 })],
				1,
			)
			// Closed at sync 100 (theirs too) and at sync 900: pruning counts from when Maple saw it close.
			yield* store.upsertFindings(
				[
					finding(mine, orgId, {
						findingId: "old-closed",
						status: "resolved",
						providerUpdatedAt: 60,
					}),
					finding(theirs, otherOrgId, {
						findingId: "their-closed",
						status: "resolved",
						providerUpdatedAt: 60,
					}),
				],
				100,
			)
			yield* store.upsertFindings(
				[
					finding(mine, orgId, {
						findingId: "new-closed",
						status: "archived",
						providerUpdatedAt: 60,
					}),
				],
				900,
			)
			assert.strictEqual(yield* store.pruneClosed(orgId, 500), 1)
			const left = yield* Effect.promise(() =>
				queryRows<{ finding_id: string }>(
					world.testDb,
					"SELECT finding_id FROM cloud_security_findings ORDER BY finding_id",
				),
			)
			assert.deepStrictEqual(
				Arr.map(left, (row) => row.finding_id),
				["new-closed", "old-active", "their-closed"],
			)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("drops a connection's findings and states with the connection", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const store = yield* CloudSecurityStore
			const connections = yield* AwsConnectionService
			const connection = yield* connect(orgId, "111111111111")
			yield* store.upsertFindings([finding(connection, orgId)], 1)
			yield* store.recordServiceState({
				orgId,
				connectionId: connection.id,
				region,
				source: "guardduty",
				state: "enabled",
				cursorAt: null,
				windowMs: null,
				lastError: null,
				checkedAt: 1,
			})
			yield* connections.delete(orgId, connection.id)
			assert.deepStrictEqual(yield* store.serviceStates(orgId, connection.id), [])
			const rows = yield* Effect.promise(() =>
				queryRows(world.testDb, "SELECT 1 FROM cloud_security_findings"),
			)
			assert.strictEqual(rows.length, 0)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("keeps a finding first seen closed out, and resolves the ones a read no longer names", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const store = yield* CloudSecurityStore
			const connection = yield* connect(orgId, "111111111111")
			yield* store.upsertFindings(
				[
					finding(connection, orgId, { findingId: "passed", status: "resolved" }),
					finding(connection, orgId, { findingId: "open-1" }),
					finding(connection, orgId, { findingId: "open-2" }),
				],
				1,
			)
			const feed = { orgId, connectionId: connection.id, region, source: "guardduty" as const }
			assert.strictEqual(yield* store.resolve(feed, { except: ["open-1"] }, 9), 1)
			const rows = yield* Effect.promise(() =>
				queryRows<{ finding_id: string; status: string }>(
					world.testDb,
					"SELECT finding_id, status FROM cloud_security_findings ORDER BY finding_id",
				),
			)
			assert.deepStrictEqual(rows, [
				{ finding_id: "open-1", status: "active" },
				{ finding_id: "open-2", status: "resolved" },
			])
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("moves a resolved finding still gone to the back of the recheck queue", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const store = yield* CloudSecurityStore
			const connection = yield* connect(orgId, "111111111111")
			const feed = { orgId, connectionId: connection.id, region, source: "guardduty" as const }
			yield* store.upsertFindings([finding(connection, orgId, { findingId: "gone" })], 1)
			yield* store.upsertFindings([finding(connection, orgId, { findingId: "other" })], 2)
			yield* store.resolve(feed, { only: ["gone"] }, 3)
			assert.deepStrictEqual(yield* store.staleIds(feed, 10, 1), ["other"])
			// Checked again and still gone: it waits behind the rows not checked since.
			yield* store.resolve(feed, { only: ["other"] }, 4)
			yield* store.resolve(feed, { only: ["gone"] }, 5)
			assert.deepStrictEqual(yield* store.staleIds(feed, 10, 2), ["other", "gone"])
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("never lets an older version of a finding replace a newer one", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const store = yield* CloudSecurityStore
			const connection = yield* connect(orgId, "111111111111")
			yield* store.upsertFindings([finding(connection, orgId, { providerUpdatedAt: 1_000 })], 1)
			yield* store.upsertFindings(
				[finding(connection, orgId, { status: "archived", providerUpdatedAt: 5_000 })],
				1,
			)
			yield* store.upsertFindings(
				[finding(connection, orgId, { status: "active", providerUpdatedAt: 4_000 })],
				2,
			)
			const rows = yield* Effect.promise(() =>
				queryRows<{ status: string }>(world.testDb, "SELECT status FROM cloud_security_findings"),
			)
			assert.deepStrictEqual(rows, [{ status: "archived" }])
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("keeps when a finding first closed across re-reads, and clears it on reopen", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const store = yield* CloudSecurityStore
			const connection = yield* connect(orgId, "111111111111")
			const closedAt = () =>
				Effect.promise(() =>
					queryRows<{ closed_at: string | null }>(
						world.testDb,
						"SELECT closed_at FROM cloud_security_findings",
					),
				)
			// Stored open, seen closed at sync 100, read again closed at sync 900.
			yield* store.upsertFindings([finding(connection, orgId, { providerUpdatedAt: 10 })], 1)
			yield* store.upsertFindings(
				[finding(connection, orgId, { status: "archived", providerUpdatedAt: 20 })],
				100,
			)
			yield* store.upsertFindings(
				[finding(connection, orgId, { status: "archived", providerUpdatedAt: 20 })],
				900,
			)
			const [first] = yield* closedAt()
			assert.strictEqual(
				first?.closed_at === null ? null : new Date(first?.closed_at ?? 0).getTime(),
				100,
			)
			yield* store.upsertFindings([finding(connection, orgId, { providerUpdatedAt: 30 })], 1000)
			const [reopened] = yield* closedAt()
			assert.strictEqual(reopened?.closed_at, null)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("stores the window size a state carries", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const store = yield* CloudSecurityStore
			const connection = yield* connect(orgId, "111111111111")
			yield* store.recordServiceState({
				orgId,
				connectionId: connection.id,
				region,
				source: "inspector",
				state: "enabled",
				cursorAt: 5_000,
				windowMs: 60_000,
				lastError: null,
				checkedAt: 1,
			})
			const [state] = yield* store.serviceStates(orgId, connection.id)
			assert.strictEqual(state?.windowMs, 60_000)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("keeps the newest of two versions of one finding in a single write", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const store = yield* CloudSecurityStore
			const connection = yield* connect(orgId, "111111111111")
			yield* store.upsertFindings(
				[
					finding(connection, orgId, { severity: "high", providerUpdatedAt: 9_000 }),
					finding(connection, orgId, { severity: "low", providerUpdatedAt: 1_000 }),
				],
				1,
			)
			const rows = yield* Effect.promise(() =>
				queryRows<{ severity: string }>(world.testDb, "SELECT severity FROM cloud_security_findings"),
			)
			assert.deepStrictEqual(rows, [{ severity: "high" }])
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("stamps a closed finding written without a close time with the sync", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const store = yield* CloudSecurityStore
			const connection = yield* connect(orgId, "111111111111")
			yield* store.upsertFindings([finding(connection, orgId, { providerUpdatedAt: 10 })], 1)
			yield* store.upsertFindings(
				[finding(connection, orgId, { status: "resolved", providerUpdatedAt: 20 })],
				5_000,
			)
			assert.strictEqual(yield* store.pruneClosed(orgId, 4_000), 0)
			assert.strictEqual(yield* store.pruneClosed(orgId, 6_000), 1)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("refuses a write that names another org's connection", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const store = yield* CloudSecurityStore
			const theirs = yield* connect(otherOrgId, "222222222222")
			const result = yield* Effect.result(store.upsertFindings([finding(theirs, orgId)], 1))
			assert.isTrue(Result.isFailure(result))
			const rows = yield* Effect.promise(() =>
				queryRows(world.testDb, "SELECT 1 FROM cloud_security_findings"),
			)
			assert.strictEqual(rows.length, 0)
		}).pipe(Effect.provide(world.layer))
	})
})
