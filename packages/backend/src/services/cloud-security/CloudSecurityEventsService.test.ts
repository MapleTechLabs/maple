import { afterEach, assert, describe, it } from "@effect/vitest"
import { Array as Arr, ConfigProvider, Effect, Layer, Option, Schema } from "effect"
import { HttpClient } from "effect/http"
import { AwsAccountId, AwsRegion, OrgId, UserId } from "@maple/primitives"
import { Env } from "@maple/backend/platform/Env"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { AwsConnectionService } from "../integrations/AwsConnectionService"
import { MAPLE_TEST_OIDC_KEY, makeFakeAws } from "../integrations/aws/fake-aws"
import { CloudSecurityEventsService } from "./CloudSecurityEventsService"
import { CloudSecurityStore } from "./CloudSecurityStore"

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
const ACCOUNT = "111111111111"
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const decodeTemplate = Schema.decodeUnknownSync(
	Schema.fromJsonString(
		Schema.Struct({
			Resources: Schema.Record(
				Schema.String,
				Schema.Struct({ Properties: Schema.Record(Schema.String, Schema.Unknown) }),
			),
		}),
	),
)

const makeWorld = (
	flags: Layer.Layer<OrganizationFeatureFlagsService> = OrganizationFeatureFlagsService.allEnabled,
) => {
	const testDb = createTestDb(trackedDbs)
	const layer = Layer.mergeAll(
		Layer.effect(CloudSecurityEventsService, CloudSecurityEventsService.make),
		Layer.effect(AwsConnectionService, AwsConnectionService.make),
	).pipe(
		Layer.provideMerge(CloudSecurityStore.layer),
		Layer.provide(flags),
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(Layer.succeed(HttpClient.HttpClient, makeFakeAws().client)),
		Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
	)
	return { testDb, layer }
}

const connect = (modules: ReadonlyArray<"security" | "cost"> = ["security"], account = ACCOUNT) =>
	AwsConnectionService.use((connections) =>
		connections.create(orgId, userId, {
			accountId: Schema.decodeSync(AwsAccountId)(account),
			modules: [...modules],
		}),
	)

const guardDutyEvent = (accountId = ACCOUNT) =>
	encodeJson({
		version: "0",
		"detail-type": "GuardDuty Finding",
		source: "aws.guardduty",
		account: ACCOUNT,
		region: "us-east-1",
		detail: {
			accountId,
			id: "gd-1",
			type: "UnauthorizedAccess:EC2/SSHBruteForce",
			severity: 8,
			updatedAt: "2026-11-16T12:00:00Z",
			resource: { resourceType: "Instance", instanceDetails: { instanceId: "i-0abc" } },
			service: { archived: false, count: 2 },
		},
	})

describe("CloudSecurityEventsService", () => {
	it.effect("stores a finding a connection's key delivers, under that connection", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const events = yield* CloudSecurityEventsService
			const store = yield* CloudSecurityStore
			const connection = yield* connect()
			const key = yield* events.eventsKey(connection.id)
			const receipt = yield* events.receive(connection.id, key, guardDutyEvent())
			assert.deepStrictEqual(receipt, {
				outcome: "stored",
				reason: null,
				orgId,
				findings: 1,
				skipped: 0,
			})
			const page = yield* store.listFindings(orgId, { status: "active" }, { limit: 10, offset: 0 })
			assert.deepStrictEqual(
				Arr.map(page.rows, (row) => [
					row.connectionId,
					row.region,
					row.source,
					row.findingId,
					row.severity,
				]),
				[[connection.id, region, "guardduty", "gd-1", "high"]],
			)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("refuses another connection's key and an unknown connection, storing nothing", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const events = yield* CloudSecurityEventsService
			const store = yield* CloudSecurityStore
			const first = yield* connect()
			const second = yield* connect(["security"], "333333333333")
			const secondKey = yield* events.eventsKey(second.id)
			const wrongKey = yield* Effect.flip(events.receive(first.id, secondKey, guardDutyEvent()))
			assert.strictEqual(wrongKey.reason, "bad_key")
			const noKey = yield* Effect.flip(events.receive(first.id, undefined, guardDutyEvent()))
			assert.strictEqual(noKey.reason, "bad_key")
			const unknown = yield* Effect.flip(
				events.receive("not-a-connection", secondKey, guardDutyEvent()),
			)
			assert.strictEqual(unknown.reason, "unknown_connection")
			const page = yield* store.listFindings(orgId, { status: "active" }, { limit: 10, offset: 0 })
			assert.strictEqual(page.rows.length, 0)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect(
		"acknowledges without storing: another account's finding, a stray event, the module off",
		() => {
			const world = makeWorld()
			return Effect.gen(function* () {
				const events = yield* CloudSecurityEventsService
				const store = yield* CloudSecurityStore
				const connection = yield* connect()
				const key = yield* events.eventsKey(connection.id)
				const member = yield* events.receive(connection.id, key, guardDutyEvent("222222222222"))
				assert.deepStrictEqual([member.outcome, member.findings, member.skipped], ["stored", 0, 1])
				const stray = yield* events.receive(
					connection.id,
					key,
					encodeJson({
						source: "aws.ec2",
						"detail-type": "EC2 Instance State-change Notification",
						region: "us-east-1",
						detail: {},
					}),
				)
				assert.strictEqual(stray.reason, "not_a_finding_event")
				const costOnly = yield* connect(["cost"], "444444444444")
				const off = yield* events.receive(
					costOnly.id,
					yield* events.eventsKey(costOnly.id),
					guardDutyEvent(),
				)
				assert.strictEqual(off.reason, "module_off")
				const malformed = yield* Effect.flip(events.receive(connection.id, key, "{not json"))
				assert.strictEqual(malformed.reason, "malformed")
				const page = yield* store.listFindings(orgId, { status: "active" }, { limit: 10, offset: 0 })
				assert.strictEqual(page.rows.length, 0)
			}).pipe(Effect.provide(world.layer))
		},
	)

	it.effect("accepts the key and endpoint the setup hands a security connection's stack", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const events = yield* CloudSecurityEventsService
			const connections = yield* AwsConnectionService
			const connection = yield* connect()
			const setup = yield* connections.setup(orgId, connection.id)
			const key = Option.getOrThrow(
				Option.fromNullishOr(/"EventsKey=([^"]+)"/u.exec(setup.setupScript)?.[1]),
			)
			const template = decodeTemplate(setup.cloudformationTemplate)
			assert.strictEqual(
				template.Resources.EventsDestination?.Properties.InvocationEndpoint,
				`https://api.maple.test/api/integrations/aws/events/${connection.id}`,
			)
			const receipt = yield* events.receive(connection.id, key, guardDutyEvent())
			assert.strictEqual(receipt.outcome, "stored")
			// A connection without the module gets no events stack at all.
			const costOnly = yield* connect(["cost"], "444444444444")
			const costSetup = yield* connections.setup(orgId, costOnly.id)
			assert.notInclude(costSetup.setupScript, "EventsKey=")
			assert.isUndefined(decodeTemplate(costSetup.cloudformationTemplate).Resources.EventsDestination)
		}).pipe(Effect.provide(world.layer))
	})
})
