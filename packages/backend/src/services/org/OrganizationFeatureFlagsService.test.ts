import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Duration, Effect, Fiber, Layer, Option, Schema, String as Str } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { CacheBackend, EdgeCacheService, makeMemoryBackend } from "@maple/cache"
import { OrgId } from "@maple/domain/http"
import { EdgeCacheServiceLive } from "@maple/backend/platform/CacheBackendLive"
import { Env } from "@maple/backend/platform/Env"
import { answeringWithin, OrganizationFeatureFlagsService } from "./OrganizationFeatureFlagsService"

describe("answeringWithin", () => {
	const setup = () => {
		const reads = { count: 0 }
		const inTime = answeringWithin<string, number>(60_000)
		// A provider that takes five seconds to answer.
		const slow = Effect.sync(() => void reads.count++).pipe(
			Effect.andThen(Effect.sleep(Duration.seconds(5))),
			Effect.as(Option.some(1)),
		)
		const fast = Effect.sync(() => void reads.count++).pipe(Effect.as(Option.some(2)))
		return { reads, ask: (read: typeof slow) => inTime("org", Duration.seconds(2), read), slow, fast }
	}

	it.effect("answers none once the wait is over, and then without waiting or reading again", () =>
		Effect.gen(function* () {
			const { reads, ask, slow } = setup()
			const first = yield* Effect.forkChild(ask(slow))
			yield* TestClock.adjust(Duration.seconds(2))
			expect(yield* Fiber.join(first)).toEqual(Option.none())
			// Within the quiet minute: no read starts, and nothing is waited on.
			expect(yield* ask(slow)).toEqual(Option.none())
			expect(reads.count).toBe(1)
		}),
	)

	it.effect("reads again after the quiet minute, and a read in time ends it", () =>
		Effect.gen(function* () {
			const { reads, ask, slow, fast } = setup()
			const first = yield* Effect.forkChild(ask(slow))
			yield* TestClock.adjust(Duration.seconds(2))
			yield* Fiber.join(first)
			yield* TestClock.adjust(Duration.minutes(1))
			expect(yield* ask(fast)).toEqual(Option.some(2))
			expect(yield* ask(fast)).toEqual(Option.some(2))
			expect(reads.count).toBe(3)
		}),
	)
})

/** Clerk's organization endpoint, answering `respond` and counting calls. */
const fakeClerkFetch = (respond: () => Response) => {
	const calls = { count: 0 }
	const fetchImpl: typeof globalThis.fetch = async (input) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
		if (url.hostname === "api.clerk.com" && Str.includes("/organizations/")(url.pathname)) {
			calls.count++
			return respond()
		}
		return new Response("not found", { status: 404 })
	}
	return { calls, layer: Layer.succeed(FetchHttpClient.Fetch, fetchImpl) }
}

const clerkOrganization = (publicMetadata: Record<string, unknown>) =>
	new Response(
		JSON.stringify({
			object: "organization",
			id: "org_flags",
			name: "Maple",
			slug: "maple",
			has_image: false,
			max_allowed_memberships: 5,
			admin_delete_enabled: true,
			public_metadata: publicMetadata,
			created_at: 0,
			updated_at: 0,
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	)

const clerkEnv = Env.layer.pipe(
	Layer.provide(
		ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				TINYBIRD_HOST: "https://api.tinybird.co",
				TINYBIRD_TOKEN: "test-token",
				TINYBIRD_SIGNING_KEY: "test-signing-key",
				TINYBIRD_WORKSPACE_ID: "test-workspace",
				MAPLE_AUTH_MODE: "clerk",
				CLERK_SECRET_KEY: "sk_test_123",
				CLERK_JWT_KEY: "jwt_test_123",
				MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
				MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			}),
		),
	),
)

const orgId = Schema.decodeSync(OrgId)("org_flags")

/** Flags as one fresh isolate reads them: its own memo, the colo's shared cache. */
const readInFreshIsolate = Effect.gen(function* () {
	const service = yield* OrganizationFeatureFlagsService
	return yield* service.flags(orgId)
}).pipe(Effect.provide(Layer.fresh(OrganizationFeatureFlagsService.layer)))

describe("OrganizationFeatureFlagsService", () => {
	it.effect("a second isolate reads the flags its colo already fetched, without calling Clerk", () => {
		const clerk = fakeClerkFetch(() => clerkOrganization({ datasources: true }))
		return Effect.gen(function* () {
			const first = yield* readInFreshIsolate
			const second = yield* readInFreshIsolate
			expect(first.dataSources).toBe(true)
			expect(second.dataSources).toBe(true)
			expect(clerk.calls.count).toBe(1)
		}).pipe(Effect.provide([clerkEnv, EdgeCacheServiceLive, clerk.layer]))
	})

	it.effect("a failed Clerk read is not shared: the next isolate asks Clerk again", () => {
		let fail = true
		const clerk = fakeClerkFetch(() =>
			fail ? new Response("unavailable", { status: 503 }) : clerkOrganization({ datasources: true }),
		)
		return Effect.gen(function* () {
			const first = yield* readInFreshIsolate
			expect(first.dataSources).toBe(false)
			fail = false
			const second = yield* readInFreshIsolate
			expect(second.dataSources).toBe(true)
			expect(clerk.calls.count).toBe(2)
		}).pipe(Effect.provide([clerkEnv, EdgeCacheServiceLive, clerk.layer]))
	})

	it.effect(
		"a shared answer stored late stops serving 30s after Clerk gave it, not after the write",
		() => {
			let enabled = true
			const clerk = fakeClerkFetch(() => clerkOrganization({ datasources: enabled }))
			const memory = makeMemoryBackend()
			// Every write lands 10s after the answer it carries, so storage keeps it until 40s.
			const lateWrites = Layer.succeed(
				CacheBackend,
				CacheBackend.of({
					...memory,
					put: (bucket, hash, value, ttlSeconds, nowMs) =>
						memory.put(bucket, hash, value, ttlSeconds, nowMs + 10_000),
				}),
			)
			return Effect.gen(function* () {
				expect((yield* readInFreshIsolate).dataSources).toBe(true)
				enabled = false
				yield* TestClock.adjust(Duration.seconds(35))
				expect((yield* readInFreshIsolate).dataSources).toBe(false)
				expect(clerk.calls.count).toBe(2)
			}).pipe(
				Effect.provide([
					clerkEnv,
					EdgeCacheService.layer.pipe(Layer.provide(lateWrites)),
					clerk.layer,
				]),
			)
		},
	)

	it.effect("a stale shared answer whose delete fails is still not served", () => {
		let enabled = true
		const clerk = fakeClerkFetch(() => clerkOrganization({ datasources: enabled }))
		const memory = makeMemoryBackend()
		// Writes land 10s late and deletes never take, so the stale entry survives the invalidate.
		const stuck = Layer.succeed(
			CacheBackend,
			CacheBackend.of({
				...memory,
				put: (bucket, hash, value, ttlSeconds, nowMs) =>
					memory.put(bucket, hash, value, ttlSeconds, nowMs + 10_000),
				delete: () => Effect.void,
			}),
		)
		return Effect.gen(function* () {
			expect((yield* readInFreshIsolate).dataSources).toBe(true)
			enabled = false
			yield* TestClock.adjust(Duration.seconds(35))
			expect((yield* readInFreshIsolate).dataSources).toBe(false)
		}).pipe(Effect.provide([clerkEnv, EdgeCacheService.layer.pipe(Layer.provide(stuck)), clerk.layer]))
	})
})
