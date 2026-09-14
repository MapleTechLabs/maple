import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { OrgId, UserId } from "@maple/domain/http"
import { ONBOARDING_REWARD_WINDOW_MS } from "@maple/domain/onboarding-checklist"
import { EdgeCacheService, MemoryCacheBackendLive } from "@maple/cache"
import { Env } from "@maple/backend/platform/Env"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { AlertDestinationsService } from "@maple/backend/services/alerts/AlertDestinationsService"
import { AlertRulesService } from "@maple/backend/services/alerts/AlertRulesService"
import { AutumnClient, type AutumnResult } from "@maple/backend/services/billing/autumn-http"
import { VcsRepository } from "@maple/backend/services/integrations/vcs/VcsRepository"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { OnboardingChecklistService } from "@maple/backend/services/org/OnboardingChecklistService"
import { OnboardingService } from "@maple/backend/services/org/OnboardingService"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
import { OrganizationService } from "@maple/backend/services/org/OrganizationService"
import { SignalPresenceService } from "@maple/backend/services/org/SignalPresenceService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_checklist")
const USER = Schema.decodeUnknownSync(UserId)("user_checklist")
const tenant: TenantContext = { orgId: ORG, userId: USER, roles: ["org:admin"], authMode: "self_hosted" }

const die = () => Effect.die(new Error("not exercised by this test"))

/**
 * The org's state as each collaborator would report it, plus what they were asked. Tests flip
 * the fields; the stubs read them at call time so one layer serves every scenario.
 */
interface World {
	orgCreatedAtMs: number | null
	orgLookupFails: boolean
	telemetryPresent: boolean
	ruleCount: number
	destinationCount: number
	memberCount: number
	membersFail: boolean
	redeemStatus: number
	orgLookups: number
	redeems: Array<{ customerId: string; code: string }>
}

const freshWorld = (): World => ({
	// The test clock starts at 0, so "created now" is 0 and the window closes a day later.
	orgCreatedAtMs: 0,
	orgLookupFails: false,
	telemetryPresent: true,
	ruleCount: 1,
	destinationCount: 1,
	memberCount: 2,
	membersFail: false,
	redeemStatus: 200,
	orgLookups: 0,
	redeems: [],
})

const ok = (response: unknown = {}): AutumnResult => ({ statusCode: 200, response })

const stubs = (world: World) =>
	Layer.mergeAll(
		Layer.succeed(OrganizationService, {
			retrieve: (orgId) =>
				Effect.suspend(() => {
					world.orgLookups += 1
					return world.orgLookupFails
						? Effect.die(new Error("clerk unreachable"))
						: Effect.succeed({
								id: orgId,
								name: "Acme",
								slug: "acme",
								imageUrl: null,
								createdAtMs: world.orgCreatedAtMs,
							})
				}),
			delete: die,
		}),
		Layer.succeed(SignalPresenceService, {
			read: () =>
				Effect.sync(() => ({
					generatedAt: 0,
					windowStart: 0,
					windowEnd: 0,
					warehouseAvailable: true,
					signals: [
						{
							signal: "traces",
							status: world.telemetryPresent ? "present" : "absent",
							count: 1,
							firstSeen: null,
							lastSeen: null,
						},
						{ signal: "sessions", status: "present", count: 1, firstSeen: null, lastSeen: null },
					],
				})),
		}),
		Layer.succeed(AlertRulesService, {
			listRules: () =>
				Effect.sync(() => ({ rules: Array.from({ length: world.ruleCount }, () => ({}) as never) })),
			createRule: die,
			deleteRule: die,
		}),
		Layer.succeed(AlertDestinationsService, {
			listDestinations: () =>
				Effect.sync(() => ({
					destinations: Array.from({ length: world.destinationCount }, () => ({}) as never),
				})),
			createDestination: die,
			updateDestination: die,
			deleteDestination: die,
			listTelegramChats: die,
			testDestination: die,
		}),
		Layer.succeed(OrgMembersService, {
			listMembers: () =>
				Effect.suspend(() =>
					world.membersFail
						? Effect.die(new Error("clerk unreachable"))
						: Effect.succeed(
								Array.from({ length: world.memberCount }, (_, index) => ({
									userId: Schema.decodeUnknownSync(UserId)(`user_${index}`),
									email: `member${index}@example.com`,
									name: null,
									imageUrl: null,
								})),
							),
				),
			resolveMembers: die,
		}),
		Layer.succeed(AutumnClient, {
			getOrCreateCustomer: () => Effect.succeed(ok({ id: ORG })),
			aggregateEvents: die,
			attach: die,
			previewAttach: die,
			openCustomerPortal: die,
			listPlans: die,
			redeemReward: (customerId, { code }) =>
				Effect.sync(() => {
					world.redeems.push({ customerId, code })
					return world.redeemStatus === 200
						? ok({ success: true })
						: { statusCode: world.redeemStatus, response: { message: "autumn down" } }
				}),
			updateCustomerBillingControls: die,
		}),
	)

const config = (extra: Record<string, string> = {}) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3510",
			MCP_PORT: "3511",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			...extra,
		}),
	)

const makeLayer = (world: World, testDb: TestDb, extraConfig?: Record<string, string>) => {
	const envLive = Env.layer.pipe(Layer.provide(config(extraConfig)))
	return Layer.effect(OnboardingChecklistService, OnboardingChecklistService.make).pipe(
		// `provideMerge` so tests can reach the real key service to mint and touch a key.
		Layer.provideMerge(
			Layer.mergeAll(
				stubs(world),
				OnboardingService.layer,
				ApiKeysService.layer,
				VcsRepository.layer,
				EdgeCacheService.layer.pipe(Layer.provide(MemoryCacheBackendLive)),
			),
		),
		Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)),
	)
}

const WITH_CODE = { AUTUMN_ONBOARDING_REWARD_CODE: "ONBOARD30" }

const claimedAtInDb = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<{ reward_claimed_at: Date | null }>(
			testDb,
			`SELECT reward_claimed_at FROM org_onboarding_state WHERE org_id = $1`,
			[ORG],
		),
	).pipe(Effect.map((row) => row?.reward_claimed_at ?? null))

/** An active GitHub installation, written the way the connect callback would. */
const connectGithub = (testDb: TestDb, status: "active" | "suspended" = "active") =>
	Effect.promise(() =>
		executeSql(
			testDb,
			`INSERT INTO vcs_installations
			   (id, org_id, provider, external_installation_id, account_login, account_type,
			    external_account_id, installed_by_user_id, status, created_at, updated_at)
			 VALUES ($1, $2, 'github', '42', 'acme', 'organization', '7', $3, $4, now(), now())`,
			[
				status === "active"
					? "0b2c1c3e-1d2a-4f3b-9c8d-0000000000a1"
					: "0b2c1c3e-1d2a-4f3b-9c8d-0000000000b2",
				ORG,
				USER,
				status,
			],
		),
	)

/** Mint an MCP key and record a use of it — the one step the stubs cannot flip. */
const useMcpKey = Effect.gen(function* () {
	const keys = yield* ApiKeysService
	const created = yield* keys.create(ORG, USER, { name: "cursor", kind: "mcp" })
	yield* keys.touchLastUsed(created.id)
})

describe("OnboardingChecklistService.read", () => {
	it.effect("reports every step done for a fully set-up org inside the window", () => {
		const world = freshWorld()
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* useMcpKey
			yield* connectGithub(testDb)
			const service = yield* OnboardingChecklistService
			const report = yield* service.read(tenant)
			assert.strictEqual(report.status, "claimable")
			assert.strictEqual(report.completedCount, 5)
			assert.strictEqual(report.deadlineAtMs, ONBOARDING_REWARD_WINDOW_MS)
		}).pipe(Effect.provide(makeLayer(world, testDb)))
	})

	it.effect("reads the org's creation time from the provider once and persists it", () => {
		const world = freshWorld()
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* OnboardingChecklistService
			yield* service.read(tenant)
			yield* service.read(tenant)
			assert.strictEqual(world.orgLookups, 1)
		}).pipe(Effect.provide(makeLayer(world, testDb)))
	})

	it.effect("expires an org outside the window without asking any collaborator", () => {
		const world = freshWorld()
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* OnboardingChecklistService
			yield* TestClock.adjust(`${25 * 60 * 60 * 1000} millis`)
			world.membersFail = true // would defect if reached
			const report = yield* service.read(tenant)
			assert.strictEqual(report.status, "expired")
			assert.strictEqual(report.completedCount, 0)
		}).pipe(Effect.provide(makeLayer(world, testDb)))
	})

	it.effect("leaves a step undone when its read fails rather than guessing it done", () => {
		const world = freshWorld()
		world.membersFail = true
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* useMcpKey
			yield* connectGithub(testDb)
			const service = yield* OnboardingChecklistService
			const report = yield* service.read(tenant)
			assert.strictEqual(report.status, "in_progress")
			assert.strictEqual(report.steps.find((step) => step.id === "invite_teammate")?.completed, false)
			assert.strictEqual(report.completedCount, 4)
		}).pipe(Effect.provide(makeLayer(world, testDb)))
	})

	it.effect("does not count a suspended GitHub installation as connected", () => {
		const world = freshWorld()
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* connectGithub(testDb, "suspended")
			const service = yield* OnboardingChecklistService
			const report = yield* service.read(tenant)
			assert.strictEqual(report.steps.find((step) => step.id === "connect_github")?.completed, false)
		}).pipe(Effect.provide(makeLayer(world, testDb)))
	})

	it.effect("treats an org the provider cannot date as expired", () => {
		const world = freshWorld()
		world.orgLookupFails = true
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* OnboardingChecklistService
			const report = yield* service.read(tenant)
			assert.strictEqual(report.status, "expired")
			assert.strictEqual(report.deadlineAtMs, null)
		}).pipe(Effect.provide(makeLayer(world, testDb)))
	})

	it.effect("counts the MCP step only once a key has actually been used", () => {
		const world = freshWorld()
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* OnboardingChecklistService
			const keys = yield* ApiKeysService
			const mcpStep = (report: { steps: ReadonlyArray<{ id: string; completed: boolean }> }) =>
				report.steps.find((step) => step.id === "connect_mcp_agent")?.completed

			assert.strictEqual(mcpStep(yield* service.read(tenant)), false)
			const created = yield* keys.create(ORG, USER, { name: "cursor", kind: "mcp" })
			assert.strictEqual(mcpStep(yield* service.read(tenant)), false)
			yield* keys.touchLastUsed(created.id)
			assert.strictEqual(mcpStep(yield* service.read(tenant)), true)
		}).pipe(Effect.provide(makeLayer(world, testDb)))
	})
})

describe("OnboardingChecklistService.claim", () => {
	it.effect("redeems the reward once and stamps the row", () => {
		const world = freshWorld()
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* useMcpKey
			yield* connectGithub(testDb)
			const service = yield* OnboardingChecklistService
			const report = yield* service.claim(tenant)
			assert.strictEqual(report.status, "claimed")
			assert.deepStrictEqual(world.redeems, [{ customerId: ORG, code: "ONBOARD30" }])
			assert.notStrictEqual(yield* claimedAtInDb(testDb), null)

			const again = yield* service.claim(tenant)
			assert.strictEqual(again.status, "claimed")
			assert.strictEqual(world.redeems.length, 1)
		}).pipe(Effect.provide(makeLayer(world, testDb, WITH_CODE)))
	})

	it.effect("refuses while steps remain, naming the reason", () => {
		const world = freshWorld()
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* OnboardingChecklistService
			const error = yield* Effect.flip(service.claim(tenant))
			assert.strictEqual(error._tag, "@maple/http/errors/OnboardingRewardNotClaimableError")
			assert.strictEqual(
				error._tag === "@maple/http/errors/OnboardingRewardNotClaimableError" ? error.reason : null,
				"incomplete",
			)
			assert.strictEqual(world.redeems.length, 0)
			assert.strictEqual(yield* claimedAtInDb(testDb), null)
		}).pipe(Effect.provide(makeLayer(world, testDb, WITH_CODE)))
	})

	it.effect("fails closed without a reward code and leaves the row untouched", () => {
		const world = freshWorld()
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* useMcpKey
			yield* connectGithub(testDb)
			const service = yield* OnboardingChecklistService
			const error = yield* Effect.flip(service.claim(tenant))
			assert.strictEqual(error._tag, "@maple/http/errors/BillingNotConfiguredError")
			assert.strictEqual(world.redeems.length, 0)
			assert.strictEqual(yield* claimedAtInDb(testDb), null)
		}).pipe(Effect.provide(makeLayer(world, testDb)))
	})

	it.effect("rolls the reservation back when Autumn refuses, so the org can retry", () => {
		const world = freshWorld()
		world.redeemStatus = 500
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* useMcpKey
			yield* connectGithub(testDb)
			const service = yield* OnboardingChecklistService
			const error = yield* Effect.flip(service.claim(tenant))
			assert.strictEqual(error._tag, "@maple/http/errors/BillingUpstreamError")
			assert.strictEqual(world.redeems.length, 1)
			assert.strictEqual(yield* claimedAtInDb(testDb), null)

			world.redeemStatus = 200
			const report = yield* service.claim(tenant)
			assert.strictEqual(report.status, "claimed")
		}).pipe(Effect.provide(makeLayer(world, testDb, WITH_CODE)))
	})

	it.effect("lets exactly one of two concurrent claims reach Autumn", () => {
		const world = freshWorld()
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* useMcpKey
			yield* connectGithub(testDb)
			const service = yield* OnboardingChecklistService
			const [a, b] = yield* Effect.all([service.claim(tenant), service.claim(tenant)], {
				concurrency: 2,
			})
			assert.strictEqual(a.status, "claimed")
			assert.strictEqual(b.status, "claimed")
			assert.strictEqual(world.redeems.length, 1)
		}).pipe(Effect.provide(makeLayer(world, testDb, WITH_CODE)))
	})

	it.effect("refuses once the window has closed even with every step done", () => {
		const world = freshWorld()
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* useMcpKey
			yield* connectGithub(testDb)
			const service = yield* OnboardingChecklistService
			yield* TestClock.adjust(`${ONBOARDING_REWARD_WINDOW_MS + 1} millis`)
			const error = yield* Effect.flip(service.claim(tenant))
			assert.strictEqual(error._tag, "@maple/http/errors/OnboardingRewardNotClaimableError")
			assert.strictEqual(
				error._tag === "@maple/http/errors/OnboardingRewardNotClaimableError" ? error.reason : null,
				"expired",
			)
			assert.strictEqual(world.redeems.length, 0)
		}).pipe(Effect.provide(makeLayer(world, testDb, WITH_CODE)))
	})
})
