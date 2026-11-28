import { createHmac } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Array as Arr, ConfigProvider, Effect, Layer, Option, Schema } from "effect"
import { HttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { type AwsConnectionId, AwsAccountId, AwsRegion, OrgId, UserId } from "@maple/primitives"
import { Env } from "@maple/backend/platform/Env"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/testing/test-pglite"
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
/** The tests' "now": every event is dated before it unless a test says otherwise. */
const NOW = Date.parse("2026-11-17T00:00:00Z")
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

type World = ReturnType<typeof makeWorld>

/** A connection as it is right after its stack was made: no check has assumed its role yet. */
const register = (modules: ReadonlyArray<"security" | "cost"> = ["security"], account = ACCOUNT) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW)
		const connections = yield* AwsConnectionService
		return yield* connections.create(orgId, userId, {
			accountId: Schema.decodeSync(AwsAccountId)(account),
			modules: [...modules],
		})
	})

/** Marks a connection checked, and `regions` read by the poller once. */
const verify = (world: World, connectionId: AwsConnectionId, regions: ReadonlyArray<AwsRegion> = [region]) =>
	Effect.gen(function* () {
		yield* Effect.promise(() =>
			executeSql(world.testDb, "UPDATE aws_connections SET verified_at = now() WHERE id = $1", [
				connectionId,
			]),
		)
		const store = yield* CloudSecurityStore
		yield* Effect.forEach(regions, (polled) =>
			store.recordServiceState({
				orgId,
				provider: "aws" as const,
				connectionId,
				region: polled,
				source: "guardduty",
				state: "enabled",
				cursorAt: null,
				windowMs: null,
				lastError: null,
				checkedAt: 1,
			}),
		)
	})

/** A connection whose role was checked and whose home region the poller reads. */
const connect = (
	world: World,
	modules: ReadonlyArray<"security" | "cost"> = ["security"],
	account = ACCOUNT,
) =>
	Effect.gen(function* () {
		const connection = yield* register(modules, account)
		yield* verify(world, connection.id)
		return connection
	})

/** One delivery, as the route makes it: the key first, then the body. */
const deliver = (connectionId: string, key: string | undefined, body: string) =>
	CloudSecurityEventsService.use((events) =>
		Effect.flatMap(events.authenticate(connectionId, key), (sender) => events.accept(sender, body)),
	)

/** Why a delivery was refused. */
const refusal = (connectionId: string, key: string | undefined, body: string) =>
	deliver(connectionId, key, body).pipe(
		Effect.flip,
		Effect.map((error) =>
			error._tag === "@maple/backend/cloud-security/CloudSecurityEventRejected"
				? error.reason
				: error._tag,
		),
	)

/** The key the setup script hands the stack. */
const setupKey = (connectionId: AwsConnectionId) =>
	AwsConnectionService.use((connections) =>
		Effect.map(connections.setup(orgId, connectionId), (setup) =>
			Option.getOrThrow(Option.fromNullishOr(/"EventsKey=([^"]+)"/u.exec(setup.setupScript)?.[1])),
		),
	)

const guardDutyEvent = (
	accountId = ACCOUNT,
	overrides: { readonly region?: string; readonly updatedAt?: string } = {},
) =>
	encodeJson({
		version: "0",
		"detail-type": "GuardDuty Finding",
		source: "aws.guardduty",
		account: ACCOUNT,
		region: overrides.region ?? "us-east-1",
		detail: {
			accountId,
			id: "gd-1",
			type: "UnauthorizedAccess:EC2/SSHBruteForce",
			severity: 8,
			updatedAt: overrides.updatedAt ?? "2026-11-16T12:00:00Z",
			resource: { resourceType: "Instance", instanceDetails: { instanceId: "i-0abc" } },
			service: { archived: false, count: 2 },
		},
	})

const activeIds = CloudSecurityStore.use((store) =>
	Effect.map(store.listFindings(orgId, { status: "active" }, { limit: 10, offset: 0 }), (page) =>
		Arr.map(page.rows, (row) => row.findingId),
	),
)

describe("CloudSecurityEventsService", () => {
	it.effect("stores a finding a connection's key delivers, under that connection", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const events = yield* CloudSecurityEventsService
			const store = yield* CloudSecurityStore
			const connection = yield* connect(world)
			const key = yield* events.eventsKey(connection.id)
			const receipt = yield* deliver(connection.id, key, guardDutyEvent())
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

	it.effect("closes a stored Access Analyzer finding when its deletion event arrives", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const events = yield* CloudSecurityEventsService
			const store = yield* CloudSecurityStore
			const connection = yield* connect(world)
			const key = yield* events.eventsKey(connection.id)
			const accessEvent = (detail: Record<string, unknown>) =>
				encodeJson({
					source: "aws.access-analyzer",
					"detail-type": "Access Analyzer Finding",
					region: "us-east-1",
					detail: {
						id: "aa-1",
						status: "ACTIVE",
						resourceType: "AWS::S3::Bucket",
						resource: "arn:aws:s3:::my-bucket",
						accountId: ACCOUNT,
						...detail,
					},
				})
			yield* deliver(connection.id, key, accessEvent({ updatedAt: "2026-11-16T01:00:00Z" }))
			const statusOf = (status: "active" | "resolved") =>
				Effect.map(store.listFindings(orgId, { status }, { limit: 10, offset: 0 }), (page) =>
					Arr.map(page.rows, (row) => row.findingId),
				)
			assert.deepStrictEqual(yield* statusOf("active"), ["aa-1"])
			// AWS keeps the last status on a deletion and sets `isDeleted`.
			yield* deliver(
				connection.id,
				key,
				accessEvent({ updatedAt: "2026-11-16T02:00:00Z", isDeleted: true }),
			)
			assert.deepStrictEqual(yield* statusOf("active"), [])
			assert.deepStrictEqual(yield* statusOf("resolved"), ["aa-1"])
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("marks the feed an event arrived for, so the poller can slow down for it", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const events = yield* CloudSecurityEventsService
			const store = yield* CloudSecurityStore
			const connection = yield* connect(world)
			// The poller's first read made the feed's state; the event marks only that feed.
			yield* Effect.forEach(["guardduty", "securityhub"] as const, (source) =>
				store.recordServiceState({
					orgId,
					provider: "aws" as const,
					connectionId: connection.id,
					region,
					source,
					state: "enabled",
					cursorAt: null,
					windowMs: null,
					lastError: null,
					checkedAt: 1,
				}),
			)
			yield* deliver(connection.id, yield* events.eventsKey(connection.id), guardDutyEvent())
			const states = yield* store.serviceStates(orgId, connection.id)
			const pushedAt = (source: string) =>
				Arr.findFirst(states, (state) => state.source === source).pipe(
					Option.map((state) => state.pushedAt),
					Option.getOrNull,
				)
			assert.isNotNull(pushedAt("guardduty"))
			assert.isNull(pushedAt("securityhub"))
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("refuses another connection's key and an unknown connection, storing nothing", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const events = yield* CloudSecurityEventsService
			const store = yield* CloudSecurityStore
			const first = yield* connect(world)
			const second = yield* connect(world, ["security"], "333333333333")
			const secondKey = yield* events.eventsKey(second.id)
			const wrongKey = yield* refusal(first.id, secondKey, guardDutyEvent())
			assert.strictEqual(wrongKey, "bad_key")
			const noKey = yield* refusal(first.id, undefined, guardDutyEvent())
			assert.strictEqual(noKey, "bad_key")
			const unknown = yield* refusal("not-a-connection", secondKey, guardDutyEvent())
			assert.strictEqual(unknown, "unknown_connection")
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
				const connection = yield* connect(world)
				const key = yield* events.eventsKey(connection.id)
				const member = yield* deliver(connection.id, key, guardDutyEvent("222222222222"))
				assert.deepStrictEqual([member.outcome, member.findings, member.skipped], ["stored", 0, 1])
				const stray = yield* deliver(
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
				const costOnly = yield* connect(world, ["cost"], "444444444444")
				const off = yield* deliver(
					costOnly.id,
					yield* events.eventsKey(costOnly.id),
					guardDutyEvent(),
				)
				assert.strictEqual(off.reason, "module_off")
				const malformed = yield* refusal(connection.id, key, "{not json")
				assert.strictEqual(malformed, "malformed")
				const page = yield* store.listFindings(orgId, { status: "active" }, { limit: 10, offset: 0 })
				assert.strictEqual(page.rows.length, 0)
			}).pipe(Effect.provide(world.layer))
		},
	)

	it.effect("accepts the key and endpoint the setup hands a security connection's stack", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const connections = yield* AwsConnectionService
			const connection = yield* connect(world)
			const setup = yield* connections.setup(orgId, connection.id)
			const key = Option.getOrThrow(
				Option.fromNullishOr(/"EventsKey=([^"]+)"/u.exec(setup.setupScript)?.[1]),
			)
			const template = decodeTemplate(setup.cloudformationTemplate)
			assert.strictEqual(
				template.Resources.EventsDestination?.Properties.InvocationEndpoint,
				`https://api.maple.test/api/integrations/aws/events/${connection.id}`,
			)
			const receipt = yield* deliver(connection.id, key, guardDutyEvent())
			assert.strictEqual(receipt.outcome, "stored")
			// A connection without the module gets no events stack at all.
			const costOnly = yield* connect(world, ["cost"], "444444444444")
			const costSetup = yield* connections.setup(orgId, costOnly.id)
			assert.notInclude(costSetup.setupScript, "EventsKey=")
			assert.isUndefined(decodeTemplate(costSetup.cloudformationTemplate).Resources.EventsDestination)
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("lets the poller correct a finding an event dated far ahead", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const store = yield* CloudSecurityStore
			const connection = yield* connect(world)
			const key = yield* setupKey(connection.id)
			yield* deliver(connection.id, key, guardDutyEvent(ACCOUNT, { updatedAt: "2999-01-01T00:00:00Z" }))
			assert.deepStrictEqual(yield* activeIds, ["gd-1"])
			// A minute later the poller reads the finding archived, at its real update time.
			yield* store.upsertFindings(
				[
					{
						orgId,
						provider: "aws" as const,
						connectionId: connection.id,
						accountId: connection.accountId,
						region,
						source: "guardduty",
						findingId: "gd-1",
						type: "UnauthorizedAccess:EC2/SSHBruteForce",
						title: "SSH brute force",
						description: null,
						severity: "high",
						status: "archived",
						resourceType: "Instance",
						resourceId: "i-0abc",
						resourceName: null,
						occurrences: 2,
						firstSeenAt: NOW,
						lastSeenAt: NOW,
						providerUpdatedAt: NOW + 30_000,
						detail: null,
					},
				],
				NOW + 60_000,
			)
			assert.deepStrictEqual(yield* activeIds, [])
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("acknowledges without storing an event for a region the poller has not read", () => {
		const world = makeWorld()
		const elsewhere = Schema.decodeSync(AwsRegion)("ap-south-2")
		return Effect.gen(function* () {
			const connection = yield* connect(world)
			const key = yield* setupKey(connection.id)
			const event = guardDutyEvent(ACCOUNT, { region: elsewhere })
			const early = yield* deliver(connection.id, key, event)
			assert.deepStrictEqual([early.outcome, early.reason], ["ignored", "unknown_region"])
			assert.deepStrictEqual(yield* activeIds, [])
			// Once the poller reads the region, it reconciles what events store there.
			yield* verify(world, connection.id, [elsewhere])
			assert.strictEqual((yield* deliver(connection.id, key, event)).outcome, "stored")
			assert.deepStrictEqual(yield* activeIds, ["gd-1"])
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("acknowledges without storing until a check has assumed the connection's role", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const connection = yield* register()
			const key = yield* setupKey(connection.id)
			const early = yield* deliver(connection.id, key, guardDutyEvent())
			assert.deepStrictEqual([early.outcome, early.reason], ["ignored", "not_verified"])
			assert.deepStrictEqual(yield* activeIds, [])
			yield* verify(world, connection.id)
			assert.strictEqual((yield* deliver(connection.id, key, guardDutyEvent())).outcome, "stored")
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("still accepts the key a stack deployed before salts holds", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const connection = yield* connect(world)
			const salted = yield* setupKey(connection.id)
			yield* Effect.promise(() =>
				executeSql(world.testDb, "UPDATE aws_connections SET events_key_salt = NULL WHERE id = $1", [
					connection.id,
				]),
			)
			// The key those stacks were deployed with, from the connection id alone.
			const deployed = `maple_awsev_${createHmac("sha256", config.MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY)
				.update(`aws-security-events/v1:${connection.id}`, "utf8")
				.digest("base64url")}`
			assert.strictEqual(yield* setupKey(connection.id), deployed)
			assert.strictEqual((yield* deliver(connection.id, deployed, guardDutyEvent())).outcome, "stored")
			const refused = yield* refusal(connection.id, salted, guardDutyEvent())
			assert.strictEqual(refused, "bad_key")
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("refuses the old key once the key is rotated, and accepts the new one", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const connections = yield* AwsConnectionService
			const connection = yield* connect(world)
			const before = yield* setupKey(connection.id)
			assert.strictEqual((yield* deliver(connection.id, before, guardDutyEvent())).outcome, "stored")
			yield* connections.rotateEventsKey(orgId, connection.id)
			const after = yield* setupKey(connection.id)
			assert.notStrictEqual(after, before)
			const refused = yield* refusal(connection.id, before, guardDutyEvent())
			assert.strictEqual(refused, "bad_key")
			assert.strictEqual((yield* deliver(connection.id, after, guardDutyEvent())).outcome, "stored")
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("hands out a new key when the security module is turned off and on again", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			const connections = yield* AwsConnectionService
			const connection = yield* connect(world)
			const before = yield* setupKey(connection.id)
			yield* connections.update(orgId, connection.id, { modules: [] })
			// The stack left deployed is refused at once, not only acknowledged.
			const off = yield* refusal(connection.id, before, guardDutyEvent())
			assert.strictEqual(off, "bad_key")
			yield* connections.update(orgId, connection.id, { modules: ["security"] })
			const after = yield* setupKey(connection.id)
			assert.notStrictEqual(after, before)
			const stale = yield* refusal(connection.id, before, guardDutyEvent())
			assert.strictEqual(stale, "bad_key")
			assert.strictEqual((yield* deliver(connection.id, after, guardDutyEvent())).outcome, "stored")
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("tells a wrong key nothing about which connections exist", () => {
		const world = makeWorld()
		const gone = "018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8"
		return Effect.gen(function* () {
			const connection = yield* connect(world)
			const key = yield* setupKey(connection.id)
			const stranger = yield* refusal(gone, key, guardDutyEvent())
			assert.strictEqual(stranger, "bad_key")
			const wrong = yield* refusal(connection.id, "maple_awsev_wrong", guardDutyEvent())
			assert.strictEqual(wrong, "bad_key")
		}).pipe(Effect.provide(world.layer))
	})
})
