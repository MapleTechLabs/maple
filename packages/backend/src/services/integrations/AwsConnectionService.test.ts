import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient } from "effect/http"
import { AwsAccountId, OrgId, UserId } from "@maple/domain/primitives"
import { Env } from "@maple/backend/platform/Env"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import { AwsConnectionService } from "./AwsConnectionService"
import { MAPLE_ACCESS_KEY_ID, MAPLE_PRINCIPAL_ARN, makeFakeAws, type FakeAws } from "./aws/fake-aws"

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
}

const mapleAws = {
	MAPLE_AWS_PRINCIPAL_ARN: MAPLE_PRINCIPAL_ARN,
	MAPLE_AWS_ACCESS_KEY_ID: MAPLE_ACCESS_KEY_ID,
	MAPLE_AWS_SECRET_ACCESS_KEY: "maple-test-secret",
}

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
			assert.match(created.externalId, /^[0-9a-f]{32}$/)
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
			assert.strictEqual(checked.templateVersion, 1)
			assert.deepStrictEqual(checked.grantedModules, [])
			assert.isFalse(checked.setupOutdated)
			const healthy = yield* sourceOf(testDb, created.id)
			assert.isNotNull(healthy?.last_poll_ok_at)
			assert.deepStrictEqual(aws.calls.slice(-3).sort(), [
				"AssumeRole",
				"GetRole",
				"ListAttachedRolePolicies",
			])
		}).pipe(Effect.provide(makeLayer(testDb, aws)))
	})

	it.effect("never lets one connection's external id verify another's role", () => {
		const testDb = createTestDb(trackedDbs)
		const aws = makeFakeAws()
		return Effect.gen(function* () {
			const service = yield* AwsConnectionService
			const mine = yield* service.create(orgId, userId, { accountId: account, modules: [] })
			const theirs = yield* service.create(otherOrgId, userId, { accountId: account, modules: [] })
			aws.deploy(account, (yield* service.setup(orgId, mine.id)).cloudformationTemplate)
			// Their role, deployed exactly as rendered except for trusting my external id: the
			// mismatch alone must be what refuses it.
			const template = (yield* service.setup(otherOrgId, theirs.id)).cloudformationTemplate
			assert.include(template, theirs.externalId)
			aws.deploy(account, template.replaceAll(theirs.externalId, mine.externalId))
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

	it.effect("blames Maple, not the customer, when AWS rejects Maple's own key", () => {
		const testDb = createTestDb(trackedDbs)
		const aws = makeFakeAws("AKIASOMEOTHERKEY0001")
		return Effect.gen(function* () {
			const service = yield* AwsConnectionService
			const created = yield* service.create(orgId, userId, { accountId: account, modules: [] })
			const checked = yield* later(service.check(orgId, created.id))
			assert.include(checked.lastCheckError ?? "", "Maple's own credentials")
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

	it.effect("is unavailable without Maple's AWS identity", () => {
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
		}).pipe(Effect.provide(makeLayer(testDb, aws, { MAPLE_AWS_PRINCIPAL_ARN: MAPLE_PRINCIPAL_ARN })))
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
			assert.strictEqual(aws.calls.filter((call) => call === "AssumeRole").length, 1)
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
			assert.strictEqual(aws.assumed.length, first.checked)
			aws.beforeEachCall = Effect.void
			yield* TestClock.adjust("1 hour")
			assert.strictEqual((yield* service.checkDue()).checked, 80)
		}).pipe(Effect.provide(makeLayer(testDb, aws)))
	})
})
