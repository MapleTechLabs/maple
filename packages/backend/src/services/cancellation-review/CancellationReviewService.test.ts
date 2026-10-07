import { afterEach, assert, describe, it } from "@effect/vitest"
import {
	CancellationAssessment,
	DailySpendResponse,
	DailyVolume,
	OrgId,
	OrganizationWrongRegionError,
} from "@maple/domain/http"
import { ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Env } from "@maple/backend/platform/Env"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import { AutumnClient } from "@maple/backend/services/billing/autumn-http"
import { DailySpendService } from "@maple/backend/services/billing/DailySpendService"
import { OnboardingService } from "@maple/backend/services/org/OnboardingService"
import { OrganizationRegionService } from "@maple/backend/services/org/OrganizationRegionService"
import { OrganizationService } from "@maple/backend/services/org/OrganizationService"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
import { SupportSlackClient, SupportSlackRefusedError } from "@maple/backend/services/support/SupportSlackClient"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { CancellationAssessor } from "./CancellationAssessor"
import type { CancellationReviewJob } from "./CancellationReviewQueue"
import { CancellationReviewService } from "./CancellationReviewService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_leaving")
const OWN_ORG = Schema.decodeUnknownSync(OrgId)("org_maple")
const CANCELED_AT = Date.parse("2026-10-07T15:30:00Z")
const DAY_MS = 86_400_000

const job: CancellationReviewJob = {
	kind: "cancellation-review",
	orgId: ORG,
	planId: "startup",
	phase: "scheduled",
	startedAt: CANCELED_AT - 240 * DAY_MS,
	canceledAt: CANCELED_AT,
	expiresAt: CANCELED_AT + 12 * DAY_MS,
	trial: false,
	pastDue: false,
	receivedAt: CANCELED_AT + 1_000,
}

interface World {
	channel: string | null
	wrongRegion: boolean
	addOn: boolean
	/** What Autumn says the org's `startup` subscription is now. */
	planStatus: "active" | "expired"
	slackFails: boolean
	warehouseDown: boolean
	posts: Array<Record<string, unknown>>
}

const freshWorld = (): World => ({
	channel: "C_CANCELLATIONS",
	wrongRegion: false,
	addOn: false,
	planStatus: "active",
	slackFails: false,
	warehouseDown: false,
	posts: [],
})

const day = (daysAgo: number, logsGB: number) =>
	new DailyVolume({
		date: new Date(CANCELED_AT - daysAgo * DAY_MS).toISOString().slice(0, 10),
		logsGB,
		tracesGB: 0,
		metricsGB: 0,
		browserSessions: 0,
	})

const stubs = (world: World) =>
	Layer.mergeAll(
		Layer.succeed(OrganizationRegionService, {
			region: "us",
			ensureServedHere: (orgId) =>
				world.wrongRegion
					? Effect.fail(
							new OrganizationWrongRegionError({
								message: "lives in the EU",
								orgId,
								orgRegion: "eu",
								region: "us",
							}),
						)
					: Effect.void,
		}),
		Layer.mock(OrganizationService)({
			retrieve: (orgId) =>
				Effect.succeed({
					id: orgId,
					name: "Acme Inc.",
					slug: "acme",
					imageUrl: null,
					createdAtMs: CANCELED_AT - 300 * DAY_MS,
				}),
		}),
		Layer.mock(OrgMembersService)({
			listMembers: () =>
				Effect.succeed([
					{ userId: "user_1", email: "a@acme.test", name: null, imageUrl: null },
					{ userId: "user_2", email: "b@acme.test", name: null, imageUrl: null },
				]),
		}),
		Layer.succeed(DailySpendService, {
			get: () =>
				Effect.succeed(
					new DailySpendResponse({
						// 42 GB the month before, then a trickle that stopped 24 days ago.
						days: [day(45, 42), day(24, 3)],
						cycleStart: 0,
						cycleEnd: 0,
					}),
				),
		}),
		Layer.succeed(
			WarehouseQueryService,
			makeWarehouseServiceStub({
				compiledQuery: () =>
					world.warehouseDown
						? Effect.die(new Error("warehouse down"))
						: Effect.succeed([
								{ bucket: "2026-09-17 00:00:00", groupName: "", value: 3, eventCount: 40 },
							] as ReadonlyArray<never>),
			}),
		),
		Layer.mock(OrgIngestKeysService)({
			resolveIngestKey: () =>
				Effect.succeed(Option.some({ orgId: OWN_ORG, keyType: "private" as const, keyId: "key_1" })),
		}),
		Layer.mock(AutumnClient)({
			getOrCreateCustomer: () =>
				Effect.succeed({
					statusCode: 200,
					response: {
						id: ORG,
						subscriptions: [{ planId: "startup", status: world.planStatus, addOn: world.addOn }],
						balances: {},
						invoices: [
							{ status: "paid", total: 39, currency: "usd", createdAt: 2 },
							{ status: "paid", total: 39, currency: "usd", createdAt: 1 },
						],
					},
				}),
		}),
		Layer.succeed(CancellationAssessor, {
			assess: () =>
				Effect.succeed(
					new CancellationAssessment({
						reason: "stopped_sending",
						reasonConfidence: 0.9,
						winBack: 0.2,
						model: "test-model",
					}),
				),
		}),
		Layer.succeed(SupportSlackClient, {
			configured: true,
			teamUserIds: [],
			call: (method, body) =>
				Effect.suspend(() => {
					if (world.slackFails) {
						return Effect.fail(
							new SupportSlackRefusedError({ message: "refused", method, error: "not_in_channel" }),
						)
					}
					world.posts.push(body)
					return Effect.succeed({ ok: true })
				}),
		}),
	)

const makeLayer = (world: World, testDb: TestDb) =>
	Layer.effect(CancellationReviewService, CancellationReviewService.make).pipe(
		Layer.provide(
			Layer.mergeAll(stubs(world), OnboardingService.layer.pipe(Layer.provide(testDb.layer)), testDb.layer),
		),
		Layer.provide(Env.layer),
		Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config(world)))),
	)

const BASE_CONFIG = {
	PORT: "3472",
	TINYBIRD_HOST: "https://api.tinybird.co",
	TINYBIRD_TOKEN: "test-token",
	MAPLE_AUTH_MODE: "self_hosted",
	MAPLE_ROOT_PASSWORD: "test-root-password",
	MAPLE_DEFAULT_ORG_ID: "default",
	MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
	MAPLE_INGEST_KEY: "maple_sk_test",
}

const config = (world: World) =>
	world.channel === null
		? BASE_CONFIG
		: { ...BASE_CONFIG, MAPLE_CANCELLATION_SLACK_CHANNEL_ID: world.channel }

const review = (world: World, testDb: TestDb, input: CancellationReviewJob = job) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(CANCELED_AT + 1_000)
		return yield* CancellationReviewService.use((service) => service.review(input))
	}).pipe(Effect.provide(makeLayer(world, testDb)))

const seedOnboarding = (testDb: TestDb) =>
	Effect.promise(() =>
		executeSql(
			testDb,
			`INSERT INTO org_onboarding_state (org_id, email, first_data_received_at, created_at, updated_at)
			 VALUES ($1, 'founder@acme.test', now(), now(), now())`,
			[ORG],
		),
	)

const storedReview = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<{ rule_reason: string | null; posted_at: string | null; snapshot_json: unknown }>(
			testDb,
			"SELECT rule_reason, posted_at, snapshot_json FROM cancellation_reviews WHERE org_id = $1",
			[ORG],
		),
	)

describe("CancellationReviewService", () => {
	it.effect("gathers the snapshot, posts the report and records the review", () =>
		Effect.gen(function* () {
			const world = freshWorld()
			const testDb = createTestDb(trackedDbs)
			yield* seedOnboarding(testDb)

			assert.strictEqual(yield* review(world, testDb), "posted")

			assert.strictEqual(world.posts.length, 1)
			const post = world.posts[0]
			assert.strictEqual(post?.channel, "C_CANCELLATIONS")
			assert.strictEqual(post?.text, "Plan cancelled: Acme Inc. (Stopped sending telemetry)")
			const blocks = String(post?.blocks)
			assert.include(blocks, "Stopped sending telemetry 24 days ago (42 GB the month before)")
			assert.include(blocks, "Nobody opened the app in 20 days")
			assert.include(blocks, "founder@acme.test")
			assert.include(blocks, "access until Oct 19 (12d left)")

			const stored = yield* storedReview(testDb)
			assert.strictEqual(stored?.rule_reason, "stopped_sending")
			assert.isNotNull(stored?.posted_at)
			assert.deepNestedInclude(stored?.snapshot_json as object, {
				"plan.tenureDays": 240,
				"org.members": 2,
				"org.everReceivedData": true,
				"ingest.daysSinceLastData": 24,
				"visits.daysSinceLastVisit": 20,
				"billing.lastInvoiceTotal": 39,
			})
		}),
	)

	it.effect("reports a subscription once: the redelivery and the later expiry are no-ops", () =>
		Effect.gen(function* () {
			const world = freshWorld()
			const testDb = createTestDb(trackedDbs)

			assert.strictEqual(yield* review(world, testDb), "posted")
			assert.strictEqual(yield* review(world, testDb), "duplicate")
			world.planStatus = "expired"
			assert.strictEqual(yield* review(world, testDb, { ...job, phase: "ended" }), "duplicate")
			assert.strictEqual(world.posts.length, 1)
		}),
	)

	it.effect("keys a subscription Autumn sent no start for on its cancellation time", () =>
		Effect.gen(function* () {
			const world = freshWorld()
			const testDb = createTestDb(trackedDbs)
			const first = { ...job, startedAt: null }
			const second = { ...first, canceledAt: CANCELED_AT + 90 * DAY_MS }

			assert.strictEqual(yield* review(world, testDb, first), "posted")
			assert.strictEqual(yield* review(world, testDb, first), "duplicate")
			// A later cancellation of the same plan is its own review, not the first one again.
			assert.strictEqual(yield* review(world, testDb, second), "posted")
		}),
	)

	it.effect("does not review a plan that ended because the org holds another one", () =>
		Effect.gen(function* () {
			const world = freshWorld()
			// Autumn still reports an active plan subscription: an upgrade, not a departure.
			const outcome = yield* review(world, createTestDb(trackedDbs), { ...job, phase: "ended" })
			assert.strictEqual(outcome, "plan_switch")
			assert.strictEqual(world.posts.length, 0)
		}),
	)

	it.effect("posts without the sections it could not read", () =>
		Effect.gen(function* () {
			const world = freshWorld()
			world.warehouseDown = true
			const testDb = createTestDb(trackedDbs)

			assert.strictEqual(yield* review(world, testDb), "posted")
			assert.include(String(world.posts[0]?.blocks), "Could not read: app visits")
		}),
	)

	it.effect("retries a report Slack refused, and posts it on the next delivery", () =>
		Effect.gen(function* () {
			const world = freshWorld()
			world.slackFails = true
			const testDb = createTestDb(trackedDbs)

			const failed = yield* Effect.exit(review(world, testDb))
			assert.isTrue(Exit.isFailure(failed))
			assert.isNull((yield* storedReview(testDb))?.posted_at)

			world.slackFails = false
			assert.strictEqual(yield* review(world, testDb), "posted")
		}),
	)

	it.effect("leaves an org on another region's instance to that instance", () =>
		Effect.gen(function* () {
			const world = freshWorld()
			world.wrongRegion = true
			assert.strictEqual(yield* review(world, createTestDb(trackedDbs)), "other_region")
			assert.strictEqual(world.posts.length, 0)
		}),
	)

	it.effect("does not review an add-on going away", () =>
		Effect.gen(function* () {
			const world = freshWorld()
			world.addOn = true
			assert.strictEqual(yield* review(world, createTestDb(trackedDbs)), "not_a_plan")
			assert.strictEqual(world.posts.length, 0)
		}),
	)

	it.effect("does nothing on a deployment with no channel configured", () =>
		Effect.gen(function* () {
			const world = freshWorld()
			world.channel = null
			const testDb = createTestDb(trackedDbs)
			assert.strictEqual(yield* review(world, testDb), "not_configured")
			assert.isUndefined(yield* storedReview(testDb))
		}),
	)
})
