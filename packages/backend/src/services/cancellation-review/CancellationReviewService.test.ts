import { afterEach, assert, describe, it } from "@effect/vitest"
import { DailySpendResponse, DailyVolume, OrgId } from "@maple/domain/http"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { ConfigProvider, DateTime, Effect, Layer, Option, Schema } from "effect"
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
import { SupportChannelUnavailableError } from "@maple/domain/support-channel"
import {
	SupportSlackClient,
	SupportSlackRefusedError,
} from "@maple/backend/services/support/SupportSlackClient"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { CancellationReviewService, type CancellationToReview } from "./CancellationReviewService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_leaving")
const OWN_ORG = Schema.decodeUnknownSync(OrgId)("org_maple")
const CANCELED_AT = Date.parse("2026-10-07T15:30:00Z")
const DAY_MS = 86_400_000

const job: CancellationToReview = {
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
	/** What the region lookup answers; `null` is Clerk not answering. */
	servedHere: boolean | null
	/** Autumn's HTTP status, and the subscriptions it reports the org holding now. */
	autumnStatus: number
	subscriptions: Array<{ planId: string; status: string; addOn?: boolean }>
	/** `refused`: Slack answered no. `unreachable`: it did not answer. */
	slack: "ok" | "refused" | "unreachable"
	warehouseDown: boolean
	/** The org's own page views, and whether anyone at all has page views under Maple's org. */
	visitRows: Array<{ bucket: DateTime.Utc; groupName: string; value: number; eventCount: number }>
	anyPageViews: boolean
	queries: Array<{ orgId: string; sql: string }>
	posts: Array<Record<string, unknown>>
}

const freshWorld = (): World => ({
	channel: "C_CANCELLATIONS",
	servedHere: true,
	autumnStatus: 200,
	subscriptions: [{ planId: "startup", status: "active" }],
	slack: "ok",
	warehouseDown: false,
	visitRows: [
		{ bucket: DateTime.makeUnsafe("2026-09-17T00:00:00Z"), groupName: "", value: 3, eventCount: 40 },
	],
	anyPageViews: true,
	queries: [],
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
		Layer.mock(OrganizationRegionService)({
			region: "us",
			servedHere: () => Effect.succeed(Option.fromNullishOr(world.servedHere)),
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
				compiledQuery: (tenant, compiled) =>
					Effect.suspend(() => {
						if (world.warehouseDown) return Effect.die(new Error("warehouse down"))
						const sql = compiledQueryOf(compiled).sql
						world.queries.push({ orgId: tenant.orgId, sql })
						// The second, unfiltered query is the "is this the right org at all" probe.
						const rows = sql.includes(ORG)
							? world.visitRows
							: world.anyPageViews
								? [
										{
											bucket: DateTime.makeUnsafe("2026-08-08T00:00:00Z"),
											groupName: "",
											value: 9,
											eventCount: 900,
										},
									]
								: []
						return Effect.succeed(rows as ReadonlyArray<never>)
					}),
			}),
		),
		Layer.mock(OrgIngestKeysService)({
			resolveIngestKey: () =>
				Effect.succeed(Option.some({ orgId: OWN_ORG, keyType: "private" as const, keyId: "key_1" })),
		}),
		Layer.mock(AutumnClient)({
			getOrCreateCustomer: () =>
				Effect.succeed({
					statusCode: world.autumnStatus,
					response: {
						id: ORG,
						// One odd field on a subscription must not cost the report its guards.
						subscriptions: world.subscriptions.map((sub) => ({ ...sub, pastDue: null })),
						balances: {},
						invoices: [
							{ status: "paid", total: 39, currency: "usd", createdAt: 2 },
							{ status: "paid", total: 39, currency: "usd", createdAt: 1 },
						],
					},
				}),
		}),
		Layer.succeed(SupportSlackClient, {
			configured: true,
			teamUserIds: [],
			call: (method, body) =>
				Effect.suspend(() => {
					if (world.slack === "refused") {
						return Effect.fail(
							new SupportSlackRefusedError({
								message: "refused",
								method,
								error: "not_in_channel",
							}),
						)
					}
					if (world.slack === "unreachable") {
						return Effect.fail(
							new SupportChannelUnavailableError({
								message: "Slack did not answer",
								operation: method,
							}),
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
			Layer.mergeAll(
				stubs(world),
				OnboardingService.layer.pipe(Layer.provide(testDb.layer)),
				testDb.layer,
			),
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

const review = (
	world: World,
	testDb: TestDb,
	input: CancellationToReview = job,
	nowMs = CANCELED_AT + 1_000,
) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(nowMs)
		return yield* CancellationReviewService.use((service) => service.review(input))
	}).pipe(Effect.provide(makeLayer(world, testDb)))

/** The step a review failed at. */
const failedStep = (world: World, testDb: TestDb, input: CancellationToReview = job) =>
	review(world, testDb, input).pipe(
		Effect.flip,
		Effect.map((error) => error.step),
	)

const seed = (testDb: TestDb) =>
	Effect.promise(async () => {
		await executeSql(
			testDb,
			`INSERT INTO org_onboarding_state (org_id, email, created_at, updated_at)
			 VALUES ($1, 'founder@acme.test', now(), now())`,
			[ORG],
		)
		// One dashboard for the org, one for somebody else.
		for (const orgId of [ORG, "org_someone_else"]) {
			await executeSql(
				testDb,
				`INSERT INTO dashboards (org_id, id, name, payload_json, created_at, updated_at, created_by, updated_by)
				 VALUES ($1, 'dash_1', 'Overview', '{}', now(), now(), 'user_1', 'user_1')`,
				[orgId],
			)
		}
	})

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
			yield* seed(testDb)

			// Processed three days after the org cancelled: the windows are anchored
			// on the cancellation, the access left on today.
			const lateJob = { ...job, receivedAt: CANCELED_AT + 3 * DAY_MS }
			assert.strictEqual(yield* review(world, testDb, lateJob, CANCELED_AT + 3 * DAY_MS), "posted")

			assert.strictEqual(world.posts.length, 1)
			const post = world.posts[0]
			assert.strictEqual(post?.channel, "C_CANCELLATIONS")
			assert.strictEqual(post?.text, "Plan cancelled: Acme Inc. (Stopped sending telemetry)")
			const blocks = String(post?.blocks)
			assert.include(blocks, "Stopped sending telemetry 24 days ago (42 GB the month before)")
			assert.include(blocks, "Nobody opened the app in 20 days")
			assert.include(blocks, "founder@acme.test")
			assert.include(blocks, "access until Oct 19 (9d left)")
			assert.notInclude(blocks, "Could not read")

			// The org's visits are read from Maple's own org, filtered to the customer.
			assert.strictEqual(world.queries.length, 1)
			assert.strictEqual(world.queries[0]?.orgId, OWN_ORG)
			assert.include(world.queries[0]?.sql, ORG)

			const stored = yield* storedReview(testDb)
			assert.strictEqual(stored?.rule_reason, "stopped_sending")
			assert.isNotNull(stored?.posted_at)
			assert.deepNestedInclude(stored?.snapshot_json as object, {
				"plan.tenureDays": 240,
				"plan.daysUntilEnd": 9,
				"org.members": 2,
				// From the telemetry itself: nothing writes the onboarding column this once read.
				"org.everReceivedData": true,
				"ingest.daysSinceLastData": 24,
				"visits.daysSinceLastVisit": 20,
				"adoption.dashboards": 1,
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
			world.subscriptions = [{ planId: "startup", status: "expired" }]
			assert.strictEqual(yield* review(world, testDb, { ...job, phase: "ended" }), "duplicate")
			assert.strictEqual(world.posts.length, 1)
		}),
	)

	it.effect("reviews a subscription again when it is cancelled a second time", () =>
		Effect.gen(function* () {
			const world = freshWorld()
			const testDb = createTestDb(trackedDbs)
			const again = { ...job, canceledAt: CANCELED_AT + 90 * DAY_MS }

			assert.strictEqual(yield* review(world, testDb), "posted")
			// Kept the plan after all, then cancelled it again three months on.
			assert.strictEqual(yield* review(world, testDb, again), "posted")
			assert.strictEqual(yield* review(world, testDb, again), "duplicate")
			// A stale redelivery of the first cancellation does not reopen it.
			assert.strictEqual(yield* review(world, testDb), "duplicate")
			assert.strictEqual(world.posts.length, 2)
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
			assert.strictEqual(yield* review(world, testDb, second), "posted")
		}),
	)

	it.effect("does not review a plan that ended while the org holds an active one", () =>
		Effect.gen(function* () {
			const world = freshWorld()
			world.subscriptions = [
				{ planId: "startup", status: "expired" },
				{ planId: "scale", status: "active" },
			]
			const outcome = yield* review(world, createTestDb(trackedDbs), { ...job, phase: "ended" })
			assert.strictEqual(outcome, "still_subscribed")
			assert.strictEqual(world.posts.length, 0)
		}),
	)

	it.effect("reviews an ended plan when only an add-on is still active", () =>
		Effect.gen(function* () {
			const world = freshWorld()
			world.subscriptions = [
				{ planId: "startup", status: "expired" },
				{ planId: "bringyourowncloud", status: "active", addOn: true },
			]
			const outcome = yield* review(world, createTestDb(trackedDbs), { ...job, phase: "ended" })
			assert.strictEqual(outcome, "posted")
		}),
	)

	it.effect("does not review an add-on going away", () =>
		Effect.gen(function* () {
			const world = freshWorld()
			world.subscriptions = [{ planId: "startup", status: "active", addOn: true }]
			assert.strictEqual(yield* review(world, createTestDb(trackedDbs)), "not_a_plan")
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

	it.effect("says nobody opened the app only when the org it read has page views at all", () =>
		Effect.gen(function* () {
			const world = freshWorld()
			world.visitRows = []
			assert.strictEqual(yield* review(world, createTestDb(trackedDbs)), "posted")
			assert.include(String(world.posts[0]?.blocks), "Nobody opened the app in the last 60 days")

			// No page views from anyone: the key points at an org the app does not report to.
			const elsewhere = freshWorld()
			elsewhere.visitRows = []
			elsewhere.anyPageViews = false
			assert.strictEqual(yield* review(elsewhere, createTestDb(trackedDbs)), "posted")
			assert.include(String(elsewhere.posts[0]?.blocks), "Could not read: app visits")
			assert.notInclude(String(elsewhere.posts[0]?.blocks), "Nobody opened the app")
		}),
	)

	it.effect("fails a report Slack could not be reached for, and posts it once the lease is over", () =>
		Effect.gen(function* () {
			const world = freshWorld()
			world.slack = "unreachable"
			const testDb = createTestDb(trackedDbs)

			assert.strictEqual(yield* failedStep(world, testDb), "post")
			assert.isNull((yield* storedReview(testDb))?.posted_at)

			world.slack = "ok"
			// A redelivery seconds later finds the first delivery's claim still fresh and waits.
			assert.strictEqual(yield* failedStep(world, testDb), "claim")
			assert.strictEqual(world.posts.length, 0)
			// Svix's next attempt, minutes on, takes the review over.
			assert.strictEqual(yield* review(world, testDb, job, CANCELED_AT + 5 * 60_000), "posted")
		}),
	)

	it.effect("does not ask for a redelivery when Slack answers no, and tries again at expiry", () =>
		Effect.gen(function* () {
			const world = freshWorld()
			world.slack = "refused"
			const testDb = createTestDb(trackedDbs)

			// Bot not in the channel: a retry changes nothing, so the webhook is not held up.
			assert.strictEqual(yield* review(world, testDb), "refused")
			assert.isNull((yield* storedReview(testDb))?.posted_at)

			world.slack = "ok"
			world.subscriptions = [{ planId: "startup", status: "expired" }]
			const expiry = { ...job, phase: "ended" as const }
			assert.strictEqual(yield* review(world, testDb, expiry, CANCELED_AT + 12 * DAY_MS), "posted")
		}),
	)

	it.effect("retries, with nothing claimed or posted, when Autumn does not answer", () =>
		Effect.gen(function* () {
			const world = freshWorld()
			world.autumnStatus = 500
			const testDb = createTestDb(trackedDbs)

			assert.strictEqual(yield* failedStep(world, testDb), "billing")
			assert.isUndefined(yield* storedReview(testDb))
			assert.strictEqual(world.posts.length, 0)
		}),
	)

	it.effect("waits rather than guesses when the org's region is unknown", () =>
		Effect.gen(function* () {
			const world = freshWorld()
			world.servedHere = null
			assert.strictEqual(yield* failedStep(world, createTestDb(trackedDbs)), "region")
			assert.strictEqual(world.posts.length, 0)
		}),
	)

	it.effect("leaves an org on another region's instance to that instance", () =>
		Effect.gen(function* () {
			const world = freshWorld()
			world.servedHere = false
			assert.strictEqual(yield* review(world, createTestDb(trackedDbs)), "other_region")
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
