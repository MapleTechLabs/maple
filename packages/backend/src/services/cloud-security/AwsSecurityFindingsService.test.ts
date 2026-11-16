import * as Retry from "@distilled.cloud/aws/Retry"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { ENABLED_ORGANIZATION_FEATURE_FLAGS } from "@maple/domain/organization-feature-flags"
import { AwsAccountId, type AwsModule, OrgId, UserId } from "@maple/primitives"
import { Array as Arr, ConfigProvider, Effect, Layer, Schema, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/testing/test-pglite"
import { AwsConnectionService } from "../integrations/AwsConnectionService"
import { MAPLE_TEST_OIDC_KEY, makeFakeAws } from "../integrations/aws/fake-aws"
import { MAX_PAGES } from "./aws-security-readers"
import { AwsSecurityFindingsService, NOT_ENABLED_RECHECK_MS } from "./AwsSecurityFindingsService"
import { CloudSecurityStore } from "./CloudSecurityStore"
import { type FakeGuardDutyFinding, makeFakeAwsSecurity } from "./fake-aws-security"

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
const userId = Schema.decodeSync(UserId)("user_1")
const account = Schema.decodeSync(AwsAccountId)("111111111111")

const makeWorld = () => {
	const testDb = createTestDb(trackedDbs)
	const sts = makeFakeAws()
	const aws = makeFakeAwsSecurity(sts.client)
	const rolledOut = new Set<OrgId>([orgId])
	const layer = Layer.mergeAll(
		Layer.effect(AwsSecurityFindingsService, AwsSecurityFindingsService.make),
		Layer.effect(AwsConnectionService, AwsConnectionService.make),
	).pipe(
		Layer.provideMerge(CloudSecurityStore.layer),
		Layer.provide(
			Layer.succeed(OrganizationFeatureFlagsService, {
				flags: (org) =>
					Effect.sync(() => ({
						...ENABLED_ORGANIZATION_FEATURE_FLAGS,
						cloudSecurity: rolledOut.has(org),
					})),
			}),
		),
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(Layer.succeed(HttpClient.HttpClient, aws.client)),
		Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
	)
	return { testDb, sts, aws, rolledOut, layer }
}

type World = ReturnType<typeof makeWorld>

const connect = (world: World, granted: ReadonlyArray<AwsModule> = ["security"]) =>
	Effect.gen(function* () {
		const connections = yield* AwsConnectionService
		const created = yield* connections.create(orgId, userId, {
			accountId: account,
			modules: ["security"],
		})
		const setup = yield* connections.setup(orgId, created.id)
		world.sts.deploy(account, setup.cloudformationTemplate)
		yield* Effect.promise(() =>
			executeSql(world.testDb, "UPDATE aws_connections SET granted_modules = $2::jsonb WHERE id = $1", [
				created.id,
				JSON.stringify(granted),
			]),
		)
		return created
	})

/** One tick, without the SDK's backoff sleeps, which never end under the test clock. */
const poll = AwsSecurityFindingsService.use((service) => Retry.none(service.pollAll))

const findingRows = (world: World) =>
	Effect.promise(() =>
		world.testDb.pglite
			.query<{
				source: string
				region: string
				finding_id: string
				severity: string
				status: string
				resource_id: string
				occurrences: number
			}>(
				"SELECT source, region, finding_id, severity, status, resource_id, occurrences FROM cloud_security_findings ORDER BY source, finding_id",
			)
			.then((result) => result.rows),
	)

const sshBruteForce = (overrides: Partial<FakeGuardDutyFinding> = {}): FakeGuardDutyFinding => ({
	id: "gd-1",
	type: "UnauthorizedAccess:EC2/SSHBruteForce",
	title: "SSH brute force against i-0abc",
	severity: 8,
	updatedAtMs: Date.parse("2026-11-01T00:00:00Z"),
	count: 12,
	instanceId: "i-0abc",
	...overrides,
})

describe("AwsSecurityFindingsService", () => {
	it.effect("stores each service's findings per region and records where a service is off", () => {
		const world = makeWorld()
		world.aws.regions["us-east-1"] = {
			guardduty: [sshBruteForce()],
			inspector: [
				{
					arn: "arn:aws:inspector2:us-east-1:111111111111:finding/1",
					title: "CVE-2026-0001 - openssl",
					severity: "CRITICAL",
					status: "ACTIVE",
					updatedAtMs: Date.parse("2026-11-02T00:00:00Z"),
					cve: "CVE-2026-0001",
				},
			],
		}
		world.aws.regions["eu-west-1"] = {
			accessAnalyzer: [
				{
					id: "aa-1",
					findingType: "ExternalAccess",
					status: "ACTIVE",
					resource: "arn:aws:s3:::public-bucket",
					updatedAtMs: Date.parse("2026-11-03T00:00:00Z"),
				},
			],
		}
		return Effect.gen(function* () {
			const connection = yield* connect(world)
			const summary = yield* poll
			assert.deepStrictEqual(summary, { connections: 1, failedConnections: 0, reads: 8, findings: 3 })
			assert.deepStrictEqual(yield* findingRows(world), [
				{
					source: "access_analyzer",
					region: "eu-west-1",
					finding_id: "aa-1",
					severity: "high",
					status: "active",
					resource_id: "arn:aws:s3:::public-bucket",
					occurrences: 1,
				},
				{
					source: "guardduty",
					region: "us-east-1",
					finding_id: "gd-1",
					severity: "high",
					status: "active",
					resource_id: "i-0abc",
					occurrences: 12,
				},
				{
					source: "inspector",
					region: "us-east-1",
					finding_id: "arn:aws:inspector2:us-east-1:111111111111:finding/1",
					severity: "critical",
					status: "active",
					resource_id: "i-0inspected",
					occurrences: 1,
				},
			])
			const store = yield* CloudSecurityStore
			const states = yield* store.serviceStates(orgId, connection.id)
			const stateOf = (region: string, source: string) =>
				Arr.findFirst(states, (state) => state.region === region && state.source === source).pipe(
					(found) => (found._tag === "Some" ? found.value.state : "missing"),
				)
			assert.strictEqual(stateOf("us-east-1", "guardduty"), "enabled")
			assert.strictEqual(stateOf("us-east-1", "securityhub"), "not_enabled")
			assert.strictEqual(stateOf("eu-west-1", "guardduty"), "not_enabled")
			assert.strictEqual(stateOf("eu-west-1", "access_analyzer"), "enabled")
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("reads only what changed since the cursor and keeps the latest version", () => {
		const world = makeWorld()
		const region = { guardduty: [sshBruteForce()] }
		world.aws.regions["us-east-1"] = region
		return Effect.gen(function* () {
			yield* connect(world)
			yield* poll
			region.guardduty = [
				sshBruteForce({ archived: true, count: 30, updatedAtMs: Date.parse("2026-11-05T00:00:00Z") }),
			]
			world.aws.requests.length = 0
			yield* poll
			const listed = Arr.filter(
				world.aws.requests,
				(request) => request.service === "guardduty" && Str.endsWith("/findings")(request.path),
			)
			assert.deepStrictEqual(
				Arr.map(listed, (request) => request.body["findingCriteria"]),
				[{ criterion: { updatedAt: { greaterThanOrEqual: Date.parse("2026-11-01T00:00:00Z") } } }],
			)
			const [row] = yield* findingRows(world)
			assert.strictEqual(row?.status, "archived")
			assert.strictEqual(row?.occurrences, 30)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("leaves out Security Hub's copies of the other services and closes passed controls", () => {
		const world = makeWorld()
		const at = Date.parse("2026-11-01T00:00:00Z")
		world.aws.regions["us-east-1"] = {
			securityhub: [
				{
					id: "sh-control",
					productName: "Security Hub",
					generatorId: "S3.1",
					title: "S3 public access",
					label: "HIGH",
					updatedAtMs: at,
				},
				{
					id: "sh-passed",
					productName: "Security Hub",
					generatorId: "IAM.1",
					title: "Root MFA",
					label: "CRITICAL",
					updatedAtMs: at,
					compliance: "PASSED",
				},
				{
					id: "sh-gd-copy",
					productName: "GuardDuty",
					generatorId: "gd",
					title: "Copy",
					label: "HIGH",
					updatedAtMs: at,
				},
			],
		}
		return Effect.gen(function* () {
			yield* connect(world)
			yield* poll
			const rows = yield* findingRows(world)
			assert.deepStrictEqual(
				Arr.map(rows, (row) => [row.finding_id, row.status]),
				[
					["sh-control", "active"],
					["sh-passed", "resolved"],
				],
			)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("records a service the role may not read as denied and still reads the rest", () => {
		const world = makeWorld()
		world.aws.regions["us-east-1"] = { guardduty: [sshBruteForce()], securityhub: [] }
		world.aws.denied.add("securityhub")
		return Effect.gen(function* () {
			const connection = yield* connect(world)
			yield* poll
			const store = yield* CloudSecurityStore
			const hub = Arr.findFirst(
				yield* store.serviceStates(orgId, connection.id),
				(state) => state.source === "securityhub",
			)
			assert.strictEqual(hub._tag === "Some" ? hub.value.state : "missing", "denied")
			assert.include(hub._tag === "Some" ? (hub.value.lastError ?? "") : "", "SecurityHub.DescribeHub")
			assert.strictEqual((yield* findingRows(world)).length, 1)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("asks a service that is off again only after an hour", () => {
		const world = makeWorld()
		world.aws.regions["us-east-1"] = { guardduty: [] }
		return Effect.gen(function* () {
			yield* connect(world)
			yield* TestClock.setTime(Date.parse("2026-11-10T00:00:00Z"))
			yield* poll
			const hubCalls = () =>
				Arr.filter(world.aws.requests, (request) => request.service === "securityhub").length
			assert.strictEqual(hubCalls(), 1)
			yield* TestClock.adjust("10 minutes")
			yield* poll
			assert.strictEqual(hubCalls(), 1)
			yield* TestClock.adjust(NOT_ENABLED_RECHECK_MS)
			yield* poll
			assert.strictEqual(hubCalls(), 2)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("continues a long first read from where the last page left off", () => {
		const world = makeWorld()
		const start = Date.parse("2026-11-01T00:00:00Z")
		const total = MAX_PAGES * 50 + 10
		world.aws.regions["us-east-1"] = {
			guardduty: Arr.makeBy(total, (index) =>
				sshBruteForce({ id: `gd-${index}`, updatedAtMs: start + index * 1000 }),
			),
		}
		return Effect.gen(function* () {
			const connection = yield* connect(world)
			yield* poll
			assert.strictEqual((yield* findingRows(world)).length, MAX_PAGES * 50)
			const store = yield* CloudSecurityStore
			const [state] = Arr.filter(
				yield* store.serviceStates(orgId, connection.id),
				(row) => row.source === "guardduty",
			)
			assert.strictEqual(state?.cursorAt, start + (MAX_PAGES * 50 - 1) * 1000)
			assert.isNotNull(state?.lastError ?? null)
			yield* poll
			assert.strictEqual((yield* findingRows(world)).length, total)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("skips orgs outside the rollout and connections whose role does not grant security", () => {
		const world = makeWorld()
		world.aws.regions["us-east-1"] = { guardduty: [sshBruteForce()] }
		return Effect.gen(function* () {
			yield* connect(world, [])
			assert.deepStrictEqual(yield* poll, {
				connections: 0,
				failedConnections: 0,
				reads: 0,
				findings: 0,
			})
			yield* Effect.promise(() =>
				executeSql(
					world.testDb,
					"UPDATE aws_connections SET granted_modules = '[\"security\"]'::jsonb",
				),
			)
			world.rolledOut.clear()
			assert.strictEqual((yield* poll).connections, 0)
			assert.deepStrictEqual(world.aws.requests, [])
		}).pipe(Effect.provide(world.layer))
	})
})
