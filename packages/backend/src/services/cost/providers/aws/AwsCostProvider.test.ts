import * as Retry from "@distilled.cloud/aws/Retry"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Number as Num, Schema, Array as Arr } from "effect"
import { HttpClient } from "effect/http"
import { AwsAccountId, OrgId, UserId } from "@maple/primitives"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { AwsConnectionService } from "../../../integrations/AwsConnectionService"
import { MAPLE_TEST_OIDC_KEY, makeFakeAws } from "../../../integrations/aws/fake-aws"
import type { CostPullSource } from "../../CostProvider"
import { AwsCostProvider } from "./AwsCostProvider"
import { FIXTURE_ITEMS, FIXTURE_WINDOW } from "./cost-fixture"
import { makeFakeCostExplorer } from "./fake-cost-explorer"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const baseConfig = {
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
}

const mapleAws = { MAPLE_AWS_OIDC_SIGNING_KEY: MAPLE_TEST_OIDC_KEY.privateKey }

const orgId = Schema.decodeSync(OrgId)("org_cost")
const otherOrgId = Schema.decodeSync(OrgId)("org_other")
const userId = Schema.decodeSync(UserId)("user_1")
const account = Schema.decodeSync(AwsAccountId)("000000000000")

/** A fake STS and IAM, with a Cost Explorer for the fixture account in front of it. */
const makeWorld = (config: Record<string, string> = mapleAws) => {
	const testDb = createTestDb(trackedDbs)
	const aws = makeFakeAws()
	const costExplorer = makeFakeCostExplorer(aws.client, FIXTURE_ITEMS)
	const layer = Layer.mergeAll(
		Layer.effect(AwsCostProvider, AwsCostProvider.make),
		Layer.effect(AwsConnectionService, AwsConnectionService.make),
	).pipe(
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(Layer.succeed(HttpClient.HttpClient, costExplorer.client)),
		Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ...baseConfig, ...config }))),
	)
	return { aws, costExplorer, layer }
}

type World = ReturnType<typeof makeWorld>

/** A connection of `orgId`. `deployed` runs the customer's stack, which is what creates the role. */
const connect = (world: World, deployed = true) =>
	Effect.gen(function* () {
		const connections = yield* AwsConnectionService
		const created = yield* connections.create(orgId, userId, { accountId: account, modules: [] })
		if (deployed) {
			const setup = yield* connections.setup(orgId, created.id)
			world.aws.deploy(account, setup.cloudformationTemplate)
		}
		return created
	})

/** A pull without the SDK's backoff sleeps, which never end under the test clock. */
const pull = (source: CostPullSource) =>
	Effect.gen(function* () {
		const provider = yield* AwsCostProvider
		return yield* Retry.none(provider.pull(source, FIXTURE_WINDOW))
	})

describe("AwsCostProvider", () => {
	it.effect("pulls a connected account's cost with a session of its role", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const connection = yield* connect(world)
			const pulled = yield* pull({ orgId, connectionRef: connection.id })

			assert.strictEqual(pulled.requests, 4)
			assert.lengthOf(world.costExplorer.requests, 4)
			assert.closeTo(
				Num.sumAll(Arr.map(pulled.rows, (row) => row.billedCost)),
				Num.sumAll(Arr.map(FIXTURE_ITEMS, (item) => item.cost)),
				1e-9,
			)
			assert.isTrue(
				Arr.every(pulled.rows, (row) => row.accountId === account && row.basis === "billed"),
			)
			// One assumption of this connection's role, and no read of the role itself.
			assert.deepStrictEqual(world.aws.assumed, [connection.roleArn])
			assert.deepStrictEqual(world.aws.calls, ["AssumeRoleWithWebIdentity"])
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("does not find a connection of another org", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const connection = yield* connect(world)
			const error = yield* Effect.flip(pull({ orgId: otherOrgId, connectionRef: connection.id }))
			assert.strictEqual(error.reason, "auth")
			assert.strictEqual(error.provider, "aws")
			assert.strictEqual(error.requests, 0)
			// Nothing was asked of AWS on the other org's behalf.
			assert.lengthOf(world.aws.assumed, 0)
			assert.lengthOf(world.costExplorer.requests, 0)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("does not find a connection that is gone, or a ref that is no connection id", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const connection = yield* connect(world)
			const connections = yield* AwsConnectionService
			yield* connections.delete(orgId, connection.id)
			const gone = yield* Effect.flip(pull({ orgId, connectionRef: connection.id }))
			const malformed = yield* Effect.flip(pull({ orgId, connectionRef: "not-a-connection" }))
			assert.deepStrictEqual([gone.reason, malformed.reason], ["auth", "auth"])
			assert.lengthOf(world.aws.assumed, 0)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("reports a role that cannot be assumed as an auth failure, before any billed request", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const connection = yield* connect(world, false)
			const error = yield* Effect.flip(pull({ orgId, connectionRef: connection.id }))
			assert.strictEqual(error.reason, "auth")
			assert.strictEqual(error.requests, 0)
			assert.deepStrictEqual(world.aws.assumed, [connection.roleArn])
			assert.lengthOf(world.costExplorer.requests, 0)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("reports a throttled STS as rate limited", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const connection = yield* connect(world)
			world.aws.failWith = { status: 400, code: "Throttling" }
			const error = yield* Effect.flip(pull({ orgId, connectionRef: connection.id }))
			assert.strictEqual(error.reason, "rate_limited")
			assert.strictEqual(error.requests, 0)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("reports a role without the cost policy as not ready, counting the refused request", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const connection = yield* connect(world)
			world.costExplorer.failWith = () => "AccessDeniedException"
			const error = yield* Effect.flip(pull({ orgId, connectionRef: connection.id }))
			assert.strictEqual(error.reason, "not_ready")
			assert.strictEqual(error.requests, 1)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("cannot act for any connection without Maple's signing key", () => {
		const world = makeWorld({})
		return Effect.gen(function* () {
			const error = yield* Effect.flip(
				pull({ orgId, connectionRef: "0190a5f0-0000-7000-8000-000000000000" }),
			)
			assert.strictEqual(error.reason, "auth")
			assert.strictEqual(error.requests, 0)
			assert.lengthOf(world.aws.calls, 0)
		}).pipe(Effect.provide(world.layer))
	})
})
