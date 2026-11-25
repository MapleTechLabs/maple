import { randomUUID } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Array as Arr } from "effect"
import { TestClock } from "effect/testing"
import { AuthorizationUnavailableError, OrgId, UserId } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import * as PG from "@maple-dev/effect-orm/postgres"
import { DigestSubscriptions } from "@maple/db/tables"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { EmailService } from "@maple/backend/platform/EmailService"
import { Env } from "@maple/backend/platform/Env"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { EdgeCacheService, makeEdgeCacheService, makeMemoryBackend } from "@maple/cache"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { OrgMembershipService } from "@maple/backend/services/auth/OrgMembershipService"
import { WebAnalyticsDigestService } from "./WebAnalyticsDigestService"

const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3476",
			MCP_PORT: "3477",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

// Monday 2026-07-06 09:00 UTC, when the default schedule (Monday, 09:00, UTC) is due.
const TICK_MS = Date.UTC(2026, 6, 6, 9, 0, 0)

/** A week with visitors, so the org has something to report; every other query answers empty. */
const summaryRow = {
	visitors: 40,
	sessions: 50,
	newSessions: 10,
	bouncedSessions: 5,
	identifiedSessions: 50,
	unknownHistorySessions: 0,
	avgDurationMs: 30_000,
	botSessions: 0,
}

const warehouse = Layer.succeed(
	WarehouseQueryService,
	makeWarehouseServiceStub({
		compiledQuery: (_tenant, input, options) =>
			compiledQueryOf(input)
				.decodeRows(options?.context === "webAnalyticsDigestSummary" ? [summaryRow] : [])
				.pipe(Effect.orDie),
	}),
)

interface DirectoryMember {
	readonly role: string
	readonly customPermissions?: ReadonlyArray<Policy.Permission>
}

/**
 * Clerk's memberships by user id; without them the deployment has no directory (self-hosted).
 * `clerk.down` fails the org listing while set; `clerk.listings` counts them.
 */
const makeDirectory = (
	members?: ReadonlyMap<string, DirectoryMember>,
	clerk: { down: boolean; listings: number } = { down: false, listings: 0 },
) =>
	Layer.mock(OrgMembershipService)(
		members === undefined
			? { directory: "none" }
			: {
					directory: "clerk",
					orgGrants: () =>
						Effect.suspend(() => {
							clerk.listings++
							return clerk.down
								? Effect.fail(new AuthorizationUnavailableError({ message: "Clerk is down" }))
								: Effect.succeed(
										new Map(
											Arr.map(
												Arr.fromIterable(members),
												([userId, member]) =>
													[
														UserId.make(userId),
														Policy.grantsOf(
															[member.role],
															member.customPermissions,
														),
													] as const,
											),
										),
									)
						}),
				},
	)

const makeHarness = (directory?: ReadonlyMap<string, DirectoryMember>) => {
	const sends: string[] = []
	const emailStub = Layer.succeed(EmailService, {
		isConfigured: true,
		send: (to) => Effect.sync(() => void sends.push(to)),
	})
	const base = createTestDb(createdDbs).layer.pipe(
		Layer.provideMerge(Env.layer),
		Layer.provide(testConfig()),
	)
	const layer = Layer.effect(WebAnalyticsDigestService, WebAnalyticsDigestService.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				emailStub,
				warehouse,
				Layer.succeed(EdgeCacheService, makeEdgeCacheService(makeMemoryBackend())),
				makeDirectory(directory),
			),
		),
		Layer.provideMerge(base),
	)
	return { sends, layer }
}

const seedSub = (email: string, userId: string) =>
	Effect.gen(function* () {
		const database = yield* Database
		yield* database.execute((db) =>
			db.run(
				PG.insertInto(DigestSubscriptions).values({
					id: randomUUID(),
					orgId: OrgId.make("org_web_digest_test"),
					userId,
					email,
					enabled: true,
					webAnalyticsEnabled: true,
					dayOfWeek: 1,
					timezone: "UTC",
					createdAt: TICK_MS,
					updatedAt: TICK_MS,
				}),
			),
		)
	})

describe("WebAnalyticsDigestService.runTick", () => {
	it.effect("sends only to subscribers whose role still reads telemetry", () => {
		const { sends, layer } = makeHarness(
			new Map<string, DirectoryMember>([
				["user-reader", { role: "org:custom", customPermissions: ["telemetry:read"] }],
				["user-blind", { role: "org:custom", customPermissions: ["billing:manage"] }],
				["user-orphaned", { role: "org:custom" }],
			]),
		)
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			yield* seedSub("reader@example.com", "user-reader")
			yield* seedSub("blind@example.com", "user-blind")
			yield* seedSub("orphaned@example.com", "user-orphaned")
			yield* seedSub("departed@example.com", "user-departed")

			const digest = yield* WebAnalyticsDigestService
			const result = yield* digest.runTick()

			assert.deepStrictEqual(sends, ["reader@example.com"])
			assert.strictEqual(result.sentCount, 1)
		}).pipe(Effect.provide(layer))
	})

	it.effect("sends to every subscriber on a self-hosted deployment", () => {
		const { sends, layer } = makeHarness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			yield* seedSub("a@example.com", "user-a")
			yield* seedSub("b@example.com", "user-b")

			const digest = yield* WebAnalyticsDigestService
			yield* digest.runTick()

			assert.deepStrictEqual(sends.sort(), ["a@example.com", "b@example.com"])
		}).pipe(Effect.provide(layer))
	})
})
