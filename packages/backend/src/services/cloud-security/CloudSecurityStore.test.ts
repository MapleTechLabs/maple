import { afterEach, assert, describe, it } from "@effect/vitest"
import { Array as Arr, ConfigProvider, Effect, Layer, Option, Order, Result, Schema } from "effect"
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

	it.effect("pages findings that differ only by source without repeating one", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const store = yield* CloudSecurityStore
			const mine = yield* connect(orgId, "111111111111")
			const sources = ["guardduty", "securityhub", "inspector", "access_analyzer"] as const
			yield* store.upsertFindings(
				Arr.map(sources, (source) => finding(mine, orgId, { source, findingId: "same" })),
				1,
			)
			const seen = yield* Effect.forEach([0, 1, 2, 3], (offset) =>
				store
					.listFindings(orgId, { status: "active" }, { limit: 1, offset })
					.pipe(Effect.map((page) => page.rows[0]?.source)),
			)
			assert.deepStrictEqual(Arr.sort(seen, Order.String), Arr.sort(sources, Order.String))
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
					cursorAt: null,
					windowMs: null,
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

	it.effect("knows a region once the poller recorded a state there, for that connection only", () => {
		const world = makeWorld()
		const elsewhere = Schema.decodeSync(AwsRegion)("eu-west-1")
		return Effect.gen(function* () {
			const store = yield* CloudSecurityStore
			const first = yield* connect(orgId, "111111111111")
			const second = yield* connect(orgId, "333333333333")
			assert.isFalse(yield* store.knowsRegion(orgId, first.id, region))
			// A service found off still counts: the poller reads the region.
			yield* store.recordServiceState({
				orgId,
				connectionId: first.id,
				region,
				source: "securityhub",
				state: "not_enabled",
				cursorAt: null,
				windowMs: null,
				lastError: null,
				checkedAt: 1,
			})
			assert.isTrue(yield* store.knowsRegion(orgId, first.id, region))
			assert.isFalse(yield* store.knowsRegion(orgId, first.id, elsewhere))
			assert.isFalse(yield* store.knowsRegion(orgId, second.id, region))
			assert.isFalse(yield* store.knowsRegion(otherOrgId, first.id, region))
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

	it.effect("leaves a finding an event stored during a read out of what the read resolves", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const store = yield* CloudSecurityStore
			const connection = yield* connect(orgId, "111111111111")
			const feed = { orgId, connectionId: connection.id, region, source: "guardduty" as const }
			yield* store.upsertFindings([finding(connection, orgId, { findingId: "old" })], 1)
			// The read started at 10; an event stored "pushed" at 12, after the listing passed it.
			yield* store.upsertFindings([finding(connection, orgId, { findingId: "pushed" })], 12)
			assert.strictEqual(yield* store.resolve(feed, { except: [] }, 10), 1)
			// A recheck by id that found it gone, before the event: the event's version stays open.
			assert.strictEqual(yield* store.resolve(feed, { only: ["pushed"] }, 10), 0)
			const rows = yield* Effect.promise(() =>
				queryRows<{ finding_id: string; status: string }>(
					world.testDb,
					"SELECT finding_id, status FROM cloud_security_findings ORDER BY finding_id",
				),
			)
			assert.deepStrictEqual(rows, [
				{ finding_id: "old", status: "resolved" },
				{ finding_id: "pushed", status: "active" },
			])
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
