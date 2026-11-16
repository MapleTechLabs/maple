import { afterEach, assert, describe, it } from "@effect/vitest"
import { Array as Arr, ConfigProvider, Effect, Layer, Option, Order, Schema } from "effect"
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
			assert.strictEqual(state?.state, "failing")
			assert.strictEqual(state?.cursorAt, 4_000)
			assert.strictEqual(state?.lastError, "throttled")
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("prunes only the org's closed findings older than the cutoff", () => {
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
			yield* store.upsertFindings(open, 1)
			yield* store.upsertFindings(
				[
					finding(mine, orgId, {
						findingId: "old-closed",
						status: "resolved",
						providerUpdatedAt: 100,
					}),
					finding(mine, orgId, {
						findingId: "new-closed",
						status: "archived",
						providerUpdatedAt: 900,
					}),
					finding(mine, orgId, { findingId: "old-active", providerUpdatedAt: 100 }),
					finding(theirs, otherOrgId, {
						findingId: "their-closed",
						status: "resolved",
						providerUpdatedAt: 100,
					}),
				],
				1,
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

	it.effect("lists the org's findings by severity, then the newest sighting", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const store = yield* CloudSecurityStore
			const mine = yield* connect(orgId, "111111111111")
			const theirs = yield* connect(otherOrgId, "222222222222")
			yield* store.upsertFindings(
				[
					finding(mine, orgId, { findingId: "low-new", severity: "low", lastSeenAt: 9_000 }),
					finding(mine, orgId, { findingId: "crit-old", severity: "critical", lastSeenAt: 1_000 }),
					finding(mine, orgId, { findingId: "high-new", severity: "high", lastSeenAt: 8_000 }),
					finding(mine, orgId, { findingId: "high-old", severity: "high", lastSeenAt: 2_000 }),
					finding(mine, orgId, { findingId: "closed", severity: "critical", status: "resolved" }),
					finding(theirs, otherOrgId, { findingId: "theirs", severity: "critical" }),
				],
				1,
			)
			const first = yield* store.listFindings(orgId, { status: "active" }, { limit: 3, offset: 0 })
			assert.deepStrictEqual(
				Arr.map(first.rows, (row) => row.findingId),
				["crit-old", "high-new", "high-old"],
			)
			assert.isTrue(first.hasMore)
			const second = yield* store.listFindings(orgId, { status: "active" }, { limit: 3, offset: 3 })
			assert.deepStrictEqual(
				Arr.map(second.rows, (row) => row.findingId),
				["low-new"],
			)
			assert.isFalse(second.hasMore)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect(
		"narrows the list by severity, source, region and a search over title, type and resource",
		() => {
			const world = makeWorld()
			return Effect.gen(function* () {
				const store = yield* CloudSecurityStore
				const connection = yield* connect(orgId, "111111111111")
				const euWest = Schema.decodeSync(AwsRegion)("eu-west-1")
				yield* store.upsertFindings(
					[
						finding(connection, orgId, { findingId: "ssh", severity: "high" }),
						finding(connection, orgId, {
							findingId: "bucket",
							source: "securityhub",
							type: "S3.8",
							title: "S3 bucket allows public access",
							resourceId: "arn:aws:s3:::assets_100%",
							severity: "critical",
						}),
						finding(connection, orgId, { findingId: "eu", region: euWest, resourceId: "i-0eu" }),
					],
					1,
				)
				const ids = (rows: { readonly rows: ReadonlyArray<{ readonly findingId: string }> }) =>
					Arr.map(rows.rows, (row) => row.findingId)
				const page = { limit: 50, offset: 0 }
				assert.deepStrictEqual(
					ids(yield* store.listFindings(orgId, { status: "active", severities: ["high"] }, page)),
					["ssh"],
				)
				assert.deepStrictEqual(
					ids(
						yield* store.listFindings(
							orgId,
							{ status: "active", sources: ["securityhub"] },
							page,
						),
					),
					["bucket"],
				)
				assert.deepStrictEqual(
					ids(yield* store.listFindings(orgId, { status: "active", region: euWest }, page)),
					["eu"],
				)
				assert.deepStrictEqual(
					ids(yield* store.listFindings(orgId, { status: "active", search: "s3.8" }, page)),
					["bucket"],
				)
				// `%` in the search is literal, not a wildcard.
				assert.deepStrictEqual(
					ids(yield* store.listFindings(orgId, { status: "active", search: "100%" }, page)),
					["bucket"],
				)
				assert.deepStrictEqual(
					ids(yield* store.listFindings(orgId, { status: "active", search: "i-0E" }, page)),
					["eu"],
				)
			}).pipe(Effect.provide(world.layer))
		},
	)

	it.effect("finds one finding by its key, only inside the org", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const store = yield* CloudSecurityStore
			const connection = yield* connect(orgId, "111111111111")
			yield* store.upsertFindings([finding(connection, orgId, { detail: { Service: "guardduty" } })], 1)
			const key = {
				connectionId: connection.id,
				region,
				source: "guardduty" as const,
				findingId: "f-1",
			}
			const found = yield* store.getFinding(orgId, key)
			assert.deepStrictEqual(
				Option.map(found, (row) => row.detail),
				Option.some({ Service: "guardduty" }),
			)
			assert.isTrue(Option.isNone(yield* store.getFinding(otherOrgId, key)))
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("counts active findings by severity and source", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const store = yield* CloudSecurityStore
			const connection = yield* connect(orgId, "111111111111")
			yield* store.upsertFindings(
				[
					finding(connection, orgId, { findingId: "a", severity: "critical" }),
					finding(connection, orgId, { findingId: "b", severity: "critical", source: "inspector" }),
					finding(connection, orgId, { findingId: "c", severity: "low" }),
					finding(connection, orgId, { findingId: "d", severity: "high", status: "archived" }),
				],
				1,
			)
			const summary = yield* store.summary(orgId)
			assert.strictEqual(summary.total, 3)
			assert.deepStrictEqual(summary.bySeverity, { critical: 2, high: 0, medium: 0, low: 1, info: 0 })
			assert.deepStrictEqual(summary.bySource, {
				guardduty: 2,
				securityhub: 0,
				inspector: 1,
				access_analyzer: 0,
			})
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("reads service states across every connection of the org, and no other", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const store = yield* CloudSecurityStore
			const first = yield* connect(orgId, "111111111111")
			const second = yield* connect(orgId, "333333333333")
			const theirs = yield* connect(otherOrgId, "222222222222")
			const state = (org: OrgId, connectionId: CloudFindingWrite["connectionId"]) =>
				store.recordServiceState({
					orgId: org,
					connectionId,
					region,
					source: "guardduty",
					state: "enabled",
					lastError: null,
					checkedAt: 1,
				})
			yield* state(orgId, first.id)
			yield* state(orgId, second.id)
			yield* state(otherOrgId, theirs.id)
			const states = yield* store.orgServiceStates(orgId)
			assert.deepStrictEqual(
				Arr.sort(
					Arr.map(states, (row) => row.connectionId),
					Order.String,
				),
				Arr.sort([first.id, second.id], Order.String),
			)
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
})
