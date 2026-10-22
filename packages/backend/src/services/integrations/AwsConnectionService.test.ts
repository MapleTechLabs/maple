import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient } from "effect/http"
import { hashIngestKey } from "@maple/db"
import { AwsAccountId, AwsRegion, OrgId, UserId } from "@maple/domain/primitives"
import { Env } from "@maple/backend/platform/Env"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import { AwsConnectionService } from "./AwsConnectionService"
import { MAPLE_TEST_OIDC_KEY, makeFakeAws, OTHER_TEST_OIDC_KEY, type FakeAws } from "./aws/fake-aws"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const API_BASE_URL = "https://api.maple.test"

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
	MAPLE_API_BASE_URL: `${API_BASE_URL}/`,
}

const mapleAws = { MAPLE_AWS_OIDC_SIGNING_KEY: MAPLE_TEST_OIDC_KEY.privateKey }

const makeLayer = (testDb: TestDb, aws: FakeAws, config: Record<string, string> = mapleAws) =>
	Layer.effect(AwsConnectionService, AwsConnectionService.make).pipe(
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(Layer.succeed(HttpClient.HttpClient, aws.client)),
		Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ...baseConfig, ...config }))),
	)

const orgId = Schema.decodeUnknownSync(OrgId)("org_aws")
const otherOrgId = Schema.decodeUnknownSync(OrgId)("org_other")
const userId = Schema.decodeUnknownSync(UserId)("user_1")
const account = Schema.decodeUnknownSync(AwsAccountId)("123456789012")

interface SourceRow {
	readonly platform: string
	readonly kind: string
	readonly last_poll_ok_at: string | null
	readonly last_poll_error: string | null
	readonly disconnected_at: string | null
}

const sourceOf = (testDb: TestDb, connectionId: string) =>
	Effect.promise(() =>
		queryFirstRow<SourceRow>(
			testDb,
			`SELECT s.platform, s.kind, s.last_poll_ok_at, s.last_poll_error, s.disconnected_at
			 FROM sources s JOIN aws_connections c ON c.source_id = s.id WHERE c.id = $1`,
			[connectionId],
		),
	)

/** Checks run seconds apart: the service answers a check within 5s of the last with that one. */
const later = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	TestClock.adjust("10 seconds").pipe(Effect.andThen(effect))

const countSources = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<{ count: number }>(
			testDb,
			"SELECT count(*)::int AS count FROM sources WHERE platform = 'aws'",
		),
	).pipe(Effect.map((row) => row?.count))

describe("AwsConnectionService", () => {
	it.effect("connects an account once the stack it renders is deployed", () => {
		const testDb = createTestDb(trackedDbs)
		const aws = makeFakeAws()
		return Effect.gen(function* () {
			const service = yield* AwsConnectionService
			const created = yield* service.create(orgId, userId, { accountId: account, modules: [] })
			assert.strictEqual(created.oidcIssuer, `${API_BASE_URL}/oidc/aws`)
			assert.strictEqual(created.oidcSubject, `aws-connection:${created.id}`)
			assert.match(created.roleArn, /^arn:aws:iam::123456789012:role\/MapleIntegration-[0-9a-f]{24}$/)
			assert.isNull(created.verifiedAt)

			// Before the stack exists the check explains what to do, and the source stays pending.
			const early = yield* later(service.check(orgId, created.id))
			assert.isNull(early.verifiedAt)
			assert.include(early.lastCheckError ?? "", "Run the setup script")
			const pending = yield* sourceOf(testDb, created.id)
			assert.strictEqual(pending?.platform, "aws")
			assert.isNull(pending?.last_poll_ok_at)
			assert.isNull(pending?.last_poll_error)

			const setup = yield* service.setup(orgId, created.id)
			assert.include(setup.setupScript, setup.stackName)
			aws.deploy(account, setup.cloudformationTemplate)

			const checked = yield* later(service.check(orgId, created.id))
			assert.isNotNull(checked.verifiedAt)
			assert.isNull(checked.lastCheckError)
			assert.strictEqual(checked.templateVersion, 2)
			assert.deepStrictEqual(checked.grantedModules, [])
			assert.isFalse(checked.setupOutdated)
			const healthy = yield* sourceOf(testDb, created.id)
			assert.isNotNull(healthy?.last_poll_ok_at)
			assert.deepStrictEqual(aws.calls.slice(-3).sort(), [
				"AssumeRoleWithWebIdentity",
				"GetRole",
				"ListAttachedRolePolicies",
			])
		}).pipe(Effect.provide(makeLayer(testDb, aws)))
	})

	it.effect("never lets one connection's token assume another's role", () => {
		const testDb = createTestDb(trackedDbs)
		const aws = makeFakeAws()
		return Effect.gen(function* () {
			const service = yield* AwsConnectionService
			const mine = yield* service.create(orgId, userId, { accountId: account, modules: [] })
			const theirs = yield* service.create(otherOrgId, userId, { accountId: account, modules: [] })
			aws.deploy(account, (yield* service.setup(orgId, mine.id)).cloudformationTemplate)
			// Their role, deployed exactly as rendered except for trusting my subject: the mismatch
			// alone must be what refuses it.
			const template = (yield* service.setup(otherOrgId, theirs.id)).cloudformationTemplate
			assert.include(template, `"${theirs.oidcSubject}"`)
			aws.deploy(account, template.replaceAll(`"${theirs.oidcSubject}"`, `"${mine.oidcSubject}"`))
			const checked = yield* later(service.check(otherOrgId, theirs.id))
			assert.isNull(checked.verifiedAt)
			// The same role trusting their own id verifies: nothing else was wrong with it.
			aws.deploy(account, template)
			const verified = yield* later(service.check(otherOrgId, theirs.id))
			assert.isNotNull(verified.verifiedAt)
		}).pipe(Effect.provide(makeLayer(testDb, aws)))
	})

	it.effect("reports a deleted stack as a disconnected source", () => {
		const testDb = createTestDb(trackedDbs)
		const aws = makeFakeAws()
		return Effect.gen(function* () {
			const service = yield* AwsConnectionService
			const created = yield* service.create(orgId, userId, { accountId: account, modules: [] })
			aws.deploy(account, (yield* service.setup(orgId, created.id)).cloudformationTemplate)
			yield* later(service.check(orgId, created.id))
			aws.deleteStacks(account)
			const checked = yield* later(service.check(orgId, created.id))
			assert.include(checked.lastCheckError ?? "", "can no longer assume the role")
			const source = yield* sourceOf(testDb, created.id)
			assert.isNotNull(source?.disconnected_at)
		}).pipe(Effect.provide(makeLayer(testDb, aws)))
	})

	it.effect("keeps a role pending while the account has no OIDC provider for Maple", () => {
		const testDb = createTestDb(trackedDbs)
		const aws = makeFakeAws()
		return Effect.gen(function* () {
			const service = yield* AwsConnectionService
			const created = yield* service.create(orgId, userId, { accountId: account, modules: [] })
			const template = (yield* service.setup(orgId, created.id)).cloudformationTemplate
			aws.deploy(account, template, { createsProvider: false })
			const pending = yield* later(service.check(orgId, created.id))
			assert.isNull(pending.verifiedAt)
			assert.include(pending.lastCheckError ?? "", "Run the setup script")
			assert.isNull((yield* sourceOf(testDb, created.id))?.last_poll_error)
			// The console default creates it with the stack; the role verifies once it exists.
			aws.deploy(account, template)
			assert.isNotNull((yield* later(service.check(orgId, created.id))).verifiedAt)
		}).pipe(Effect.provide(makeLayer(testDb, aws)))
	})

	it.effect("blames Maple, not the customer, when AWS cannot verify Maple's token", () => {
		const testDb = createTestDb(trackedDbs)
		const aws = makeFakeAws(OTHER_TEST_OIDC_KEY.publicKey)
		return Effect.gen(function* () {
			const service = yield* AwsConnectionService
			const created = yield* service.create(orgId, userId, { accountId: account, modules: [] })
			const checked = yield* later(service.check(orgId, created.id))
			assert.include(checked.lastCheckError ?? "", "Maple's identity token")
		}).pipe(Effect.provide(makeLayer(testDb, aws)))
	})

	it.effect("refuses a second connection for the same account and leaves no source behind", () => {
		const testDb = createTestDb(trackedDbs)
		const aws = makeFakeAws()
		return Effect.gen(function* () {
			const service = yield* AwsConnectionService
			yield* service.create(orgId, userId, { accountId: account, modules: [] })
			const error = yield* Effect.flip(
				service.create(orgId, userId, { accountId: account, modules: [] }),
			)
			assert.strictEqual(error._tag, "@maple/http/errors/AwsAccountAlreadyConnectedError")
			assert.strictEqual(yield* countSources(testDb), 1)
		}).pipe(Effect.provide(makeLayer(testDb, aws)))
	})

	it.effect("refuses modules Maple does not read yet", () => {
		const testDb = createTestDb(trackedDbs)
		const aws = makeFakeAws()
		return Effect.gen(function* () {
			const service = yield* AwsConnectionService
			const error = yield* Effect.flip(
				service.create(orgId, userId, { accountId: account, modules: ["security"] }),
			)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
			assert.strictEqual(yield* countSources(testDb), 0)
		}).pipe(Effect.provide(makeLayer(testDb, aws)))
	})

	it.effect("updates a connection's modules only within its own org", () => {
		const testDb = createTestDb(trackedDbs)
		const aws = makeFakeAws()
		return Effect.gen(function* () {
			const service = yield* AwsConnectionService
			const created = yield* service.create(orgId, userId, { accountId: account, modules: [] })
			const unchanged = yield* service.update(orgId, created.id, {})
			assert.deepStrictEqual(unchanged.modules, [])
			const refused = yield* Effect.flip(service.update(orgId, created.id, { modules: ["cost"] }))
			assert.strictEqual(refused._tag, "@maple/http/errors/IntegrationsValidationError")
			const foreign = yield* Effect.flip(service.update(otherOrgId, created.id, { modules: [] }))
			assert.strictEqual(foreign._tag, "@maple/http/errors/IntegrationsNotFoundError")
			const unpatched = yield* Effect.flip(service.update(otherOrgId, created.id, {}))
			assert.strictEqual(unpatched._tag, "@maple/http/errors/IntegrationsNotFoundError")
		}).pipe(Effect.provide(makeLayer(testDb, aws)))
	})

	it.effect("streams metrics with a secret only this connection's row can verify", () => {
		const testDb = createTestDb(trackedDbs)
		const aws = makeFakeAws()
		const regions = ["us-east-1", "eu-central-1"].map((region) =>
			Schema.decodeUnknownSync(AwsRegion)(region),
		)
		const streamSecretHash = (id: string) =>
			Effect.promise(() =>
				queryFirstRow<{ stream_secret_hash: string | null }>(
					testDb,
					"SELECT stream_secret_hash FROM aws_connections WHERE id = $1",
					[id],
				),
			).pipe(Effect.map((row) => row?.stream_secret_hash))
		const accessKeyOf = (script: string) => /AccessKey=(maple_aws_[\w-]+)/u.exec(script)?.[1]
		return Effect.gen(function* () {
			const service = yield* AwsConnectionService
			const created = yield* service.create(orgId, userId, {
				accountId: account,
				modules: [],
				metricStream: { regions, namespaces: ["AWS/ECS", "AWS/ApplicationELB"] },
			})
			const setup = yield* service.setup(orgId, created.id)
			const accessKey = accessKeyOf(setup.setupScript)
			assert.isDefined(accessKey)
			assert.strictEqual(
				yield* streamSecretHash(created.id),
				hashIngestKey(accessKey!, "maple-test-lookup-secret"),
			)
			assert.include(setup.setupScript, "for region in us-east-1 eu-central-1; do")

			const template = JSON.parse(setup.metricsCloudformationTemplate ?? "{}")
			assert.deepStrictEqual(template.Resources.MetricStream.Properties.IncludeFilters, [
				{ Namespace: "AWS/ECS" },
				{ Namespace: "AWS/ApplicationELB" },
			])
			assert.strictEqual(template.Resources.MetricStream.Properties.OutputFormat, "opentelemetry1.0")
			const endpoint =
				template.Resources.DeliveryStream.Properties.HttpEndpointDestinationConfiguration
					.EndpointConfiguration
			assert.strictEqual(endpoint.Url, `https://ingest.test/v1/firehose/aws/${created.id}`)
			// The secret is a parameter the script passes, never part of the template.
			assert.deepStrictEqual(endpoint.AccessKey, { Ref: "AccessKey" })
			assert.isTrue(template.Parameters.AccessKey.NoEcho)
			assert.notInclude(setup.metricsCloudformationTemplate ?? "", accessKey!)

			// Turning the stream off leaves a setup that only removes its stacks.
			const off = yield* service.update(orgId, created.id, { metricStream: null })
			assert.isNull(off.metricStream)
			const removed = yield* service.setup(orgId, created.id)
			assert.isNull(removed.metricsStackName)
			assert.isUndefined(accessKeyOf(removed.setupScript))
			assert.include(removed.setupScript, "describe-regions")
			// The old secret stops matching; turning the stream back on deploys a new one.
			assert.isNull(yield* streamSecretHash(created.id))
			yield* service.update(orgId, created.id, {
				metricStream: { regions, namespaces: ["AWS/ECS"] },
			})
			const again = accessKeyOf((yield* service.setup(orgId, created.id)).setupScript)
			assert.isDefined(again)
			assert.notStrictEqual(again, accessKey)
			assert.strictEqual(
				yield* streamSecretHash(created.id),
				hashIngestKey(again!, "maple-test-lookup-secret"),
			)
		}).pipe(Effect.provide(makeLayer(testDb, aws)))
	})

	it.effect("mints a stream secret once for a connection made before streams", () => {
		const testDb = createTestDb(trackedDbs)
		const aws = makeFakeAws()
		const region = Schema.decodeUnknownSync(AwsRegion)("us-east-1")
		return Effect.gen(function* () {
			const service = yield* AwsConnectionService
			const created = yield* service.create(orgId, userId, { accountId: account, modules: [] })
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`UPDATE aws_connections SET stream_secret_ciphertext = NULL, stream_secret_iv = NULL,
					 stream_secret_tag = NULL, stream_secret_hash = NULL WHERE id = $1`,
					[created.id],
				),
			)
			yield* service.update(orgId, created.id, {
				metricStream: { regions: [region], namespaces: ["AWS/Lambda"] },
			})
			const first = yield* service.setup(orgId, created.id)
			const again = yield* service.setup(orgId, created.id)
			const keyOf = (script: string) => /AccessKey=(maple_aws_[\w-]+)/u.exec(script)?.[1]
			assert.isDefined(keyOf(first.setupScript))
			assert.strictEqual(keyOf(again.setupScript), keyOf(first.setupScript))
		}).pipe(Effect.provide(makeLayer(testDb, aws)))
	})

	it.effect("is unavailable without a usable OIDC signing key", () => {
		const testDb = createTestDb(trackedDbs)
		const aws = makeFakeAws()
		return Effect.gen(function* () {
			const service = yield* AwsConnectionService
			assert.isFalse((yield* service.status(orgId)).available)
			const error = yield* Effect.flip(
				service.create(orgId, userId, { accountId: account, modules: [] }),
			)
			assert.strictEqual(error._tag, "@maple/http/errors/AwsIntegrationUnavailableError")
			assert.deepStrictEqual(yield* service.checkDue(), { due: 0, checked: 0, failures: 0 })
		}).pipe(Effect.provide(makeLayer(testDb, aws, { MAPLE_AWS_OIDC_SIGNING_KEY: "not a key" })))
	})

	it.effect("sweeps each connection once an hour and skips paused sources", () => {
		const testDb = createTestDb(trackedDbs)
		const aws = makeFakeAws()
		return Effect.gen(function* () {
			const service = yield* AwsConnectionService
			const active = yield* service.create(orgId, userId, { accountId: account, modules: [] })
			const paused = yield* service.create(otherOrgId, userId, { accountId: account, modules: [] })
			aws.deploy(account, (yield* service.setup(orgId, active.id)).cloudformationTemplate)
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					"UPDATE sources SET paused_at = now() WHERE id = (SELECT source_id FROM aws_connections WHERE id = $1)",
					[paused.id],
				),
			)

			const first = yield* service.checkDue()
			assert.deepStrictEqual(first, { due: 1, checked: 1, failures: 0 })
			const [checked] = (yield* service.status(orgId)).connections
			assert.isNotNull(checked?.verifiedAt)

			// Checked moments ago: nothing is due, and the paused one is never claimed.
			const second = yield* service.checkDue()
			assert.deepStrictEqual(second, { due: 0, checked: 0, failures: 0 })
		}).pipe(Effect.provide(makeLayer(testDb, aws)))
	})

	it.effect("deletes the connection with its source and hands back the stack's cleanup", () => {
		const testDb = createTestDb(trackedDbs)
		const aws = makeFakeAws()
		return Effect.gen(function* () {
			const service = yield* AwsConnectionService
			const created = yield* service.create(orgId, userId, { accountId: account, modules: [] })
			const { stackName } = yield* service.setup(orgId, created.id)
			const deleted = yield* service.delete(orgId, created.id)
			assert.include(deleted.cleanupScript, `delete-stack --region us-east-1 --stack-name ${stackName}`)
			assert.strictEqual(yield* countSources(testDb), 0)
			const error = yield* Effect.flip(service.check(orgId, created.id))
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsNotFoundError")
		}).pipe(Effect.provide(makeLayer(testDb, aws)))
	})

	it.effect("two overlapping sweeps check each connection once", () => {
		const testDb = createTestDb(trackedDbs)
		const aws = makeFakeAws()
		return Effect.gen(function* () {
			const service = yield* AwsConnectionService
			const created = yield* service.create(orgId, userId, { accountId: account, modules: [] })
			aws.deploy(account, (yield* service.setup(orgId, created.id)).cloudformationTemplate)
			const [a, b] = yield* Effect.all([service.checkDue(), service.checkDue()], { concurrency: 2 })
			assert.strictEqual((a?.checked ?? 0) + (b?.checked ?? 0), 1)
			assert.strictEqual(aws.calls.filter((call) => call === "AssumeRoleWithWebIdentity").length, 1)
		}).pipe(Effect.provide(makeLayer(testDb, aws)))
	})

	it.effect("an AWS outage after setup is recorded without failing the source", () => {
		const testDb = createTestDb(trackedDbs)
		const aws = makeFakeAws()
		return Effect.gen(function* () {
			const service = yield* AwsConnectionService
			const created = yield* service.create(orgId, userId, { accountId: account, modules: [] })
			aws.deploy(account, (yield* service.setup(orgId, created.id)).cloudformationTemplate)
			yield* later(service.check(orgId, created.id))
			aws.failWith = { status: 400, code: "InvalidParameterValue" }
			const checked = yield* later(service.check(orgId, created.id))
			assert.include(checked.lastCheckError ?? "", "AssumeRole")
			const source = yield* sourceOf(testDb, created.id)
			assert.isNull(source?.last_poll_error)
			assert.isNull(source?.disconnected_at)
		}).pipe(Effect.provide(makeLayer(testDb, aws)))
	})

	it.effect("a check within seconds of a good one answers with it; a pending one always asks", () => {
		const testDb = createTestDb(trackedDbs)
		const aws = makeFakeAws()
		return Effect.gen(function* () {
			const service = yield* AwsConnectionService
			const created = yield* service.create(orgId, userId, { accountId: account, modules: [] })
			yield* later(service.check(orgId, created.id))
			// Still pending: the stack may have been deployed a second ago.
			aws.deploy(account, (yield* service.setup(orgId, created.id)).cloudformationTemplate)
			const verified = yield* service.check(orgId, created.id)
			assert.isNotNull(verified.verifiedAt)
			const calls = aws.calls.length
			yield* service.check(orgId, created.id)
			assert.strictEqual(aws.calls.length, calls)
		}).pipe(Effect.provide(makeLayer(testDb, aws)))
	})

	it.effect("one sweep checks every due connection, past a single batch", () => {
		const testDb = createTestDb(trackedDbs)
		const aws = makeFakeAws()
		return Effect.gen(function* () {
			const service = yield* AwsConnectionService
			// More than one batch of 100, each in its own account.
			yield* Effect.forEach(
				Array.from({ length: 101 }, (_, index) => index),
				(index) =>
					service.create(orgId, userId, {
						accountId: Schema.decodeUnknownSync(AwsAccountId)(String(100000000000 + index)),
						modules: [],
					}),
				{ concurrency: 10 },
			)
			const sweep = yield* service.checkDue()
			assert.deepStrictEqual(sweep, { due: 101, checked: 101, failures: 101 })
			assert.deepStrictEqual(yield* service.checkDue(), { due: 0, checked: 0, failures: 0 })
		}).pipe(Effect.provide(makeLayer(testDb, aws)))
	})

	it.effect("a sweep checks a never-checked connection ahead of stale ones", () => {
		const testDb = createTestDb(trackedDbs)
		const aws = makeFakeAws()
		const accountOf = (digits: string) => Schema.decodeUnknownSync(AwsAccountId)(digits)
		return Effect.gen(function* () {
			const service = yield* AwsConnectionService
			const stale = yield* Effect.forEach(["111111111111", "222222222222"], (digits) =>
				service.create(orgId, userId, { accountId: accountOf(digits), modules: [] }),
			)
			yield* Effect.forEach(stale, (connection) => later(service.check(orgId, connection.id)))
			yield* TestClock.adjust("2 hours")
			const fresh = yield* service.create(orgId, userId, {
				accountId: accountOf("333333333333"),
				modules: [],
			})
			aws.assumed.length = 0
			yield* service.checkDue()
			// Two checks run at a time: the new connection is in the first pair, not behind both stale ones.
			assert.include(aws.assumed.slice(0, 2), fresh.roleArn)
			assert.lengthOf(aws.assumed, 3)
		}).pipe(Effect.provide(makeLayer(testDb, aws)))
	})

	it.effect("a slow AWS stops a sweep at its budget; the connections it left come due again", () => {
		const testDb = createTestDb(trackedDbs)
		const aws = makeFakeAws()
		return Effect.gen(function* () {
			const service = yield* AwsConnectionService
			yield* Effect.forEach(
				Array.from({ length: 80 }, (_, index) => index),
				(index) =>
					service.create(orgId, userId, {
						accountId: Schema.decodeUnknownSync(AwsAccountId)(String(100000000000 + index)),
						modules: [],
					}),
				{ concurrency: 10 },
			)
			// Each check takes 9s, under the SDK's timers: 80 checks two at a time outlast the budget.
			aws.beforeEachCall = TestClock.adjust("9 seconds")
			const first = yield* service.checkDue()
			assert.strictEqual(first.due, 80)
			assert.isAbove(first.checked, 0)
			assert.isBelow(first.checked, 80)
			// At most once per check: a call that sees other calls' 9s jumps can time out unassumed.
			assert.isAtMost(aws.assumed.length, first.checked)
			aws.beforeEachCall = Effect.void
			yield* TestClock.adjust("1 hour")
			assert.strictEqual((yield* service.checkDue()).checked, 80)
		}).pipe(Effect.provide(makeLayer(testDb, aws)))
	})
})
