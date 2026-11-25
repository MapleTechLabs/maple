import * as Policy from "@maple/domain/policy"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Array as Arr, ConfigProvider, Effect, Exit, Layer, Schema } from "effect"
import { HttpClient } from "effect/http"
import {
	DISABLED_ORGANIZATION_FEATURE_FLAGS,
	ENABLED_ORGANIZATION_FEATURE_FLAGS,
	type OrganizationFeatureFlags,
} from "@maple/domain/organization-feature-flags"
import { RoleName, type TenantContext, WarehouseUpstreamError } from "@maple/domain/http"
import { AwsAccountId, AwsRegion, OrgId, UserId } from "@maple/primitives"
import { CH } from "@maple/query-engine"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { Env } from "@maple/backend/platform/Env"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { AwsConnectionService } from "../integrations/AwsConnectionService"
import { MAPLE_TEST_OIDC_KEY, makeFakeAws } from "../integrations/aws/fake-aws"
import { affectedServicesOf, CloudSecurityReadService } from "./CloudSecurityReadService"
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
const userId = Schema.decodeSync(UserId)("user_1")
const region = Schema.decodeSync(AwsRegion)("us-east-1")
const tenant: TenantContext = {
	orgId,
	userId,
	roles: [Schema.decodeSync(RoleName)("org:admin")],
	permissions: Policy.grantsOf([Schema.decodeSync(RoleName)("org:admin")]),
	authMode: "self_hosted",
}

type Warehouse = "answers" | "fails" | "capped"

const makeWorld = (flags: OrganizationFeatureFlags, warehouse: Warehouse = "answers") => {
	const testDb = createTestDb(trackedDbs)
	const reads: Array<string> = []
	const warehouseStub = makeWarehouseServiceStub({
		compiledQuery: (_tenant, compiled) => {
			const query = compiledQueryOf(compiled)
			reads.push(query.sql)
			return warehouse === "fails"
				? Effect.fail(
						new WarehouseUpstreamError({
							message: "HTTP 503",
							pipeName: "cloudResourceServices",
						}),
					)
				: warehouse === "capped"
					? query
							.decodeRows(
								Arr.makeBy(CH.CLOUD_RESOURCE_SERVICES_MAX_ROWS + 1, (index) => ({
									match: matchTag("host.id", "", "i-0abc1234def567890"),
									service: `service-${index}`,
									requests: "1",
								})),
							)
							.pipe(Effect.orDie)
					: query
							.decodeRows([
								{
									match: matchTag("host.id", "", "i-0abc1234def567890"),
									service: "checkout-api",
									requests: "1200",
								},
								{
									match: matchTag("host.id", "", "i-0abc1234def567890"),
									service: "cart",
									requests: "40",
								},
								{
									match: matchTag("faas.name", "111111111111/us-east-1", "checkout-fn"),
									service: "payments",
									requests: "9",
								},
							])
							.pipe(Effect.orDie)
		},
	})
	const layer = Layer.effect(CloudSecurityReadService, CloudSecurityReadService.make).pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				CloudSecurityStore.layer,
				Layer.effect(AwsConnectionService, AwsConnectionService.make),
			),
		),
		Layer.provide(Layer.succeed(WarehouseQueryService, warehouseStub)),
		Layer.provide(OrganizationFeatureFlagsService.fixed(flags)),
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(Layer.succeed(HttpClient.HttpClient, makeFakeAws().client)),
		Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
	)
	return { testDb, layer, reads }
}

const connect = (modules: ReadonlyArray<"security" | "metrics">) =>
	AwsConnectionService.use((connections) =>
		connections.create(orgId, userId, {
			accountId: Schema.decodeSync(AwsAccountId)("111111111111"),
			modules,
		}),
	)

const finding = (
	connection: {
		readonly id: CloudFindingWrite["connectionId"]
		readonly accountId: CloudFindingWrite["accountId"]
	},
	overrides: Partial<CloudFindingWrite> = {},
): CloudFindingWrite => ({
	orgId,
	connectionId: connection.id,
	accountId: connection.accountId,
	region,
	source: "guardduty",
	findingId: "f-1",
	type: "UnauthorizedAccess:EC2/SSHBruteForce",
	title: "SSH brute force against i-0abc",
	description: "An EC2 instance is being probed.",
	severity: "high",
	status: "active",
	resourceType: "Instance",
	resourceId: "i-0abc1234def567890",
	resourceName: null,
	occurrences: 3,
	firstSeenAt: 1_000,
	lastSeenAt: 2_000,
	providerUpdatedAt: 2_000,
	detail: { Service: { Count: 3 } },
	...overrides,
})

const matchTag = (key: string, scope: string, value: string) => `${key}\u001f${scope}\u001f${value}`

describe("affectedServicesOf", () => {
	it("counts a resource's services once across its ARN and name, busiest first, on the right attribute", () => {
		const services = affectedServicesOf(
			{
				resourceId: "arn:aws:lambda:us-east-1:111111111111:function:checkout-fn",
				resourceType: "AwsLambdaFunction",
				accountId: "111111111111",
				region: "us-east-1",
			},
			[
				{
					match: matchTag("faas.name", "111111111111/us-east-1", "checkout-fn"),
					service: "payments",
					requests: 9,
				},
				{
					match: matchTag(
						"cloud.resource_id",
						"",
						"arn:aws:lambda:us-east-1:111111111111:function:checkout-fn",
					),
					service: "payments",
					requests: 1,
				},
				{
					match: matchTag("faas.name", "111111111111/us-east-1", "checkout-fn"),
					service: "checkout-api",
					requests: 50,
				},
				// The same name on another kind of resource: a cluster called checkout-fn.
				{
					match: matchTag("k8s.cluster.name", "111111111111/us-east-1", "checkout-fn"),
					service: "orders",
					requests: 400,
				},
				// The same function name in another account.
				{
					match: matchTag("faas.name", "222222222222/us-east-1", "checkout-fn"),
					service: "intruder",
					requests: 700,
				},
				{
					match: matchTag("host.id", "", "i-0abc1234def567890"),
					service: "cart",
					requests: 999,
				},
			],
		)
		assert.deepStrictEqual(services, [
			{ service: "checkout-api", requests: 50 },
			// The same span counted under the ARN (1) and the name (9): the most, not the sum.
			{ service: "payments", requests: 9 },
		])
	})
})

describe("CloudSecurityReadService", () => {
	it.effect("refuses an org outside the cloudSecurity rollout", () => {
		const world = makeWorld(DISABLED_ORGANIZATION_FEATURE_FLAGS)
		return Effect.gen(function* () {
			const reads = yield* CloudSecurityReadService
			const exit = yield* Effect.exit(reads.overview(tenant))
			assert.isTrue(Exit.isFailure(exit))
			const listed = yield* Effect.flip(reads.listFindings(tenant, {}))
			assert.strictEqual(listed._tag, "@maple/http/errors/CloudSecurityDisabledError")
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("lists findings with the services that carried their resource", () => {
		const world = makeWorld(ENABLED_ORGANIZATION_FEATURE_FLAGS)
		return Effect.gen(function* () {
			const store = yield* CloudSecurityStore
			const reads = yield* CloudSecurityReadService
			const connection = yield* connect(["security"])
			yield* store.upsertFindings(
				[
					finding(connection),
					finding(connection, { findingId: "f-2", resourceId: "bucket-x", severity: "low" }),
				],
				5,
			)
			const page = yield* reads.listFindings(tenant, {})
			assert.isTrue(page.telemetryMatched)
			assert.strictEqual(page.nextOffset, null)
			assert.deepStrictEqual(
				Arr.map(page.findings, (row) => [row.findingId, row.affectedServices]),
				[
					[
						"f-1",
						[
							{ service: "checkout-api", requests: 1200 },
							{ service: "cart", requests: 40 },
						],
					],
					["f-2", []],
				],
			)
			assert.include(page.findings[0]?.consoleUrl ?? "", "guardduty/home?region=us-east-1")
			assert.lengthOf(world.reads, 1)
			assert.include(world.reads[0] ?? "", "'org_sec'")
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("asks for a function name once per account and region it is named in", () => {
		const world = makeWorld(ENABLED_ORGANIZATION_FEATURE_FLAGS)
		return Effect.gen(function* () {
			const store = yield* CloudSecurityStore
			const reads = yield* CloudSecurityReadService
			const connection = yield* connect(["security"])
			const lambda = { resourceType: "Lambda", resourceId: "checkout-fn" }
			yield* store.upsertFindings(
				[
					finding(connection, { ...lambda, findingId: "f-east" }),
					finding(connection, {
						...lambda,
						findingId: "f-west",
						region: Schema.decodeSync(AwsRegion)("eu-west-1"),
					}),
				],
				5,
			)
			yield* reads.listFindings(tenant, {})
			const sql = world.reads[0] ?? ""
			assert.include(sql, "['cloud.region'] IN ('', 'us-east-1')")
			assert.include(sql, "['cloud.region'] IN ('', 'eu-west-1')")
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("still lists findings, flagged unmatched, when the warehouse fails", () => {
		const world = makeWorld(ENABLED_ORGANIZATION_FEATURE_FLAGS, "fails")
		return Effect.gen(function* () {
			const store = yield* CloudSecurityStore
			const reads = yield* CloudSecurityReadService
			const connection = yield* connect(["security"])
			yield* store.upsertFindings([finding(connection)], 5)
			const page = yield* reads.listFindings(tenant, {})
			assert.isFalse(page.telemetryMatched)
			assert.deepStrictEqual(page.findings[0]?.affectedServices, [])
		}).pipe(Effect.provide(world.layer))
	})

	it.effect(
		"flags a capped telemetry answer unmatched, since a resource may have lost its services",
		() => {
			const world = makeWorld(ENABLED_ORGANIZATION_FEATURE_FLAGS, "capped")
			return Effect.gen(function* () {
				const store = yield* CloudSecurityStore
				const reads = yield* CloudSecurityReadService
				const connection = yield* connect(["security"])
				yield* store.upsertFindings([finding(connection)], 5)
				const page = yield* reads.listFindings(tenant, {})
				assert.isFalse(page.telemetryMatched)
			}).pipe(Effect.provide(world.layer))
		},
	)

	it.effect("reads no telemetry for an empty page", () => {
		const world = makeWorld(ENABLED_ORGANIZATION_FEATURE_FLAGS)
		return Effect.gen(function* () {
			const reads = yield* CloudSecurityReadService
			const page = yield* reads.listFindings(tenant, {})
			assert.deepStrictEqual(page.findings, [])
			assert.lengthOf(world.reads, 0)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect(
		"says whether each connection asks for the security module and whether the role grants it",
		() => {
			const world = makeWorld(ENABLED_ORGANIZATION_FEATURE_FLAGS)
			return Effect.gen(function* () {
				const reads = yield* CloudSecurityReadService
				const store = yield* CloudSecurityStore
				const connection = yield* connect(["security"])
				yield* store.recordServiceState({
					orgId,
					connectionId: connection.id,
					region,
					source: "inspector",
					state: "not_enabled",
					cursorAt: null,
					windowMs: null,
					lastError: null,
					checkedAt: 7,
				})
				const before = yield* reads.overview(tenant)
				assert.deepStrictEqual(
					Arr.map(before.connections, (c) => c.module),
					["requested"],
				)
				assert.deepStrictEqual(
					Arr.map(before.services, (s) => [s.accountId, s.source, s.state]),
					[["111111111111", "inspector", "not_enabled"]],
				)
				yield* Effect.promise(() =>
					world.testDb.pglite.query(
						`UPDATE aws_connections SET granted_modules = '["security"]'::jsonb`,
					),
				)
				const after = yield* reads.overview(tenant)
				assert.deepStrictEqual(
					Arr.map(after.connections, (c) => c.module),
					["granted"],
				)
			}).pipe(Effect.provide(world.layer))
		},
	)

	it.effect("answers not found for a finding outside the org's store", () => {
		const world = makeWorld(ENABLED_ORGANIZATION_FEATURE_FLAGS)
		return Effect.gen(function* () {
			const reads = yield* CloudSecurityReadService
			const connection = yield* connect(["security"])
			const error = yield* Effect.flip(
				reads.finding(tenant, {
					connectionId: connection.id,
					region,
					source: "guardduty",
					findingId: "missing",
				}),
			)
			assert.strictEqual(error._tag, "@maple/http/errors/CloudFindingNotFoundError")
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("returns one finding with its detail and affected services", () => {
		const world = makeWorld(ENABLED_ORGANIZATION_FEATURE_FLAGS)
		return Effect.gen(function* () {
			const store = yield* CloudSecurityStore
			const reads = yield* CloudSecurityReadService
			const connection = yield* connect(["security"])
			yield* store.upsertFindings([finding(connection)], 5)
			const { finding: detail } = yield* reads.finding(tenant, {
				connectionId: connection.id,
				region,
				source: "guardduty",
				findingId: "f-1",
			})
			assert.deepStrictEqual(detail.detail, { Service: { Count: 3 } })
			assert.strictEqual(detail.affectedServices[0]?.service, "checkout-api")
		}).pipe(Effect.provide(world.layer))
	})
})
