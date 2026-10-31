import { assert, describe, it } from "@effect/vitest"
import {
	type EdgeCacheBackend,
	EdgeCacheService,
	makeEdgeCacheService,
	makeMemoryBackend,
} from "@maple/cache"
import { OrganizationWrongRegionError, OrgId } from "@maple/domain/http"
import type { MapleRegion } from "@maple/domain/organization-regions"
import { Deferred, Effect, Exit, Fiber, Option, Ref, Schema } from "effect"
import { TestClock } from "effect/testing"
import { ClerkRequestError } from "@maple/backend/services/auth/clerk-request"
import {
	type DirectoryOrganization,
	makeOrganizationRegionService,
	type ReadDirectoryOrganization,
} from "./OrganizationRegionService"

const orgId = Schema.decodeUnknownSync(OrgId)("org_region_cache")

const chosen = (region: MapleRegion): DirectoryOrganization => ({
	publicMetadata: { regions: [region] },
	createdAt: 0,
})
/** Created at the test clock's start with no region yet, so still inside the choice window. */
const open: DirectoryOrganization = { publicMetadata: {}, createdAt: 0 }

/** A stand-in Clerk whose answer can change, counting reads. */
const makeDirectory = Effect.fnUntraced(function* (initial: Option.Option<DirectoryOrganization>) {
	const answer = yield* Ref.make(initial)
	const reads = yield* Ref.make(0)
	const read = (_: OrgId) =>
		Ref.update(reads, (n) => n + 1).pipe(
			Effect.andThen(Ref.get(answer)),
			Effect.flatMap(
				Option.match({
					onNone: () =>
						Effect.fail(
							new ClerkRequestError({
								operation: "Clerk.organizations.getOrganization",
								message: "Clerk is down",
								status: 503,
								cause: undefined,
							}),
						),
					onSome: (organization) => Effect.succeed(Option.some(organization)),
				}),
			),
		)
	return { answer, reads, read }
})

/** A fresh isolate: its own memory, the data center's shared cache. */
const isolate = (backend: EdgeCacheBackend, directory: { readonly read: ReadDirectoryOrganization }) =>
	makeOrganizationRegionService("us", Option.some(directory.read)).pipe(
		Effect.provideService(EdgeCacheService, makeEdgeCacheService(backend)),
	)

const isWrongRegion = <A, E>(exit: Exit.Exit<A, E>): boolean =>
	Exit.isFailure(exit) &&
	Option.exists(Exit.findErrorOption(exit), (error) => error instanceof OrganizationWrongRegionError)

describe("OrganizationRegionService", () => {
	it.effect("a miss reads Clerk once, then the isolate answers", () =>
		Effect.gen(function* () {
			const directory = yield* makeDirectory(Option.some(chosen("us")))
			const regions = yield* isolate(makeMemoryBackend(), directory)
			yield* regions.ensureServedHere(orgId)
			yield* regions.ensureServedHere(orgId)
			assert.strictEqual(yield* Ref.get(directory.reads), 1)
		}),
	)

	it.effect("a fresh isolate reuses another isolate's answer from the shared cache", () =>
		Effect.gen(function* () {
			const backend = makeMemoryBackend()
			const directory = yield* makeDirectory(Option.some(chosen("us")))
			yield* (yield* isolate(backend, directory)).ensureServedHere(orgId)
			yield* TestClock.adjust("30 seconds")
			yield* (yield* isolate(backend, directory)).ensureServedHere(orgId)
			assert.strictEqual(yield* Ref.get(directory.reads), 1)
		}),
	)

	it.effect("a chosen region expires 60 s after Clerk was read, in every tier", () =>
		Effect.gen(function* () {
			const backend = makeMemoryBackend()
			const directory = yield* makeDirectory(Option.some(chosen("us")))
			yield* (yield* isolate(backend, directory)).ensureServedHere(orgId)
			yield* TestClock.adjust("30 seconds")
			const second = yield* isolate(backend, directory)
			yield* second.ensureServedHere(orgId)
			// The second isolate got the answer at 30 s, but it was read at 0 s.
			yield* TestClock.adjust("30 seconds")
			yield* second.ensureServedHere(orgId)
			assert.strictEqual(yield* Ref.get(directory.reads), 2)
		}),
	)

	it.effect("an open region expires after 5 s, so a choice of EU lands quickly", () =>
		Effect.gen(function* () {
			const backend = makeMemoryBackend()
			const directory = yield* makeDirectory(Option.some(open))
			const regions = yield* isolate(backend, directory)
			yield* regions.ensureServedHere(orgId)
			yield* Ref.set(directory.answer, Option.some(chosen("eu")))
			yield* TestClock.adjust("4 seconds")
			yield* regions.ensureServedHere(orgId)
			yield* TestClock.adjust("1 second")
			assert.isTrue(
				isWrongRegion(
					yield* Effect.exit((yield* isolate(backend, directory)).ensureServedHere(orgId)),
				),
			)
			assert.isTrue(isWrongRegion(yield* Effect.exit(regions.ensureServedHere(orgId))))
		}),
	)

	it.effect("forgetting drops the answer from both tiers", () =>
		Effect.gen(function* () {
			const backend = makeMemoryBackend()
			const directory = yield* makeDirectory(Option.some(open))
			const regions = yield* isolate(backend, directory)
			yield* regions.ensureServedHere(orgId)
			yield* Ref.set(directory.answer, Option.some(chosen("eu")))
			yield* regions.forget(orgId)
			assert.isTrue(isWrongRegion(yield* Effect.exit(regions.ensureServedHere(orgId))))
			assert.isTrue(
				isWrongRegion(
					yield* Effect.exit((yield* isolate(backend, directory)).ensureServedHere(orgId)),
				),
			)
		}),
	)

	it.effect("an organization Clerk no longer has is deleted, not unknown, and still served", () =>
		Effect.gen(function* () {
			const regions = yield* isolate(makeMemoryBackend(), { read: () => Effect.succeedNone })
			assert.strictEqual(yield* regions.servedHere(orgId), "deleted")
			yield* regions.ensureServedHere(orgId)
		}),
	)

	it.effect("a Clerk failure serves the request and is not cached as a region", () =>
		Effect.gen(function* () {
			const backend = makeMemoryBackend()
			const directory = yield* makeDirectory(Option.none())
			const regions = yield* isolate(backend, directory)
			yield* regions.ensureServedHere(orgId)
			assert.strictEqual(yield* regions.servedHere(orgId), "unknown")
			yield* Ref.set(directory.answer, Option.some(chosen("eu")))
			assert.isTrue(isWrongRegion(yield* Effect.exit(regions.ensureServedHere(orgId))))
			assert.isTrue(
				isWrongRegion(
					yield* Effect.exit((yield* isolate(backend, directory)).ensureServedHere(orgId)),
				),
			)
		}),
	)

	it.effect("a refusal is not cached, so a region just chosen here is served at once", () =>
		Effect.gen(function* () {
			const backend = makeMemoryBackend()
			const directory = yield* makeDirectory(Option.some(chosen("eu")))
			const regions = yield* isolate(backend, directory)
			assert.isTrue(isWrongRegion(yield* Effect.exit(regions.ensureServedHere(orgId))))
			yield* Ref.set(directory.answer, Option.some(chosen("us")))
			yield* regions.ensureServedHere(orgId)
			yield* (yield* isolate(backend, directory)).ensureServedHere(orgId)
			assert.strictEqual(yield* Ref.get(directory.reads), 2)
		}),
	)

	it.effect("a shared read that hangs hands over to Clerk after 40 ms", () =>
		Effect.gen(function* () {
			const hung: EdgeCacheBackend = { ...makeMemoryBackend(), get: () => Effect.never }
			const directory = yield* makeDirectory(Option.some(chosen("eu")))
			const pending = yield* Effect.forkChild(
				Effect.exit((yield* isolate(hung, directory)).ensureServedHere(orgId)),
			)
			yield* TestClock.adjust("40 millis")
			assert.isTrue(isWrongRegion(yield* Fiber.join(pending)))
		}),
	)

	it.effect("a slow shared answer still wins over a slower Clerk", () =>
		Effect.gen(function* () {
			const backend = makeMemoryBackend()
			const directory = yield* makeDirectory(Option.some(chosen("us")))
			yield* (yield* isolate(backend, directory)).ensureServedHere(orgId)
			// Clerk now says EU and takes 500 ms, so only the shared answer can serve the request.
			yield* Ref.set(directory.answer, Option.some(chosen("eu")))
			const slowClerk = { read: (id: OrgId) => Effect.delay(directory.read(id), "500 millis") }
			const slowCache: EdgeCacheBackend = {
				...backend,
				get: (...args) => Effect.delay(backend.get(...args), "100 millis"),
			}
			const pending = yield* Effect.forkChild(
				Effect.exit((yield* isolate(slowCache, slowClerk)).ensureServedHere(orgId)),
			)
			yield* TestClock.adjust("1 second")
			assert.isTrue(Exit.isSuccess(yield* Fiber.join(pending)))
		}),
	)

	it.effect("parallel misses in one isolate read Clerk once and share its answer", () =>
		Effect.gen(function* () {
			const directory = yield* makeDirectory(Option.some(chosen("us")))
			const slowClerk = { read: (id: OrgId) => Effect.delay(directory.read(id), "120 millis") }
			const regions = yield* isolate(makeMemoryBackend(), slowClerk)
			const pending = yield* Effect.forkChild(
				Effect.all(
					Array.from({ length: 4 }, () => Effect.exit(regions.ensureServedHere(orgId))),
					{ concurrency: "unbounded" },
				),
			)
			yield* TestClock.adjust("200 millis")
			const exits = yield* Fiber.join(pending)
			assert.isTrue(exits.every(Exit.isSuccess))
			assert.strictEqual(yield* Ref.get(directory.reads), 1)
		}),
	)

	it.effect("waiting requests share a refusal too, which is never remembered", () =>
		Effect.gen(function* () {
			const directory = yield* makeDirectory(Option.some(chosen("eu")))
			const slowClerk = { read: (id: OrgId) => Effect.delay(directory.read(id), "120 millis") }
			const regions = yield* isolate(makeMemoryBackend(), slowClerk)
			const pending = yield* Effect.forkChild(
				Effect.all(
					Array.from({ length: 3 }, () => Effect.exit(regions.ensureServedHere(orgId))),
					{ concurrency: "unbounded" },
				),
			)
			yield* TestClock.adjust("200 millis")
			assert.isTrue((yield* Fiber.join(pending)).every(isWrongRegion))
			assert.strictEqual(yield* Ref.get(directory.reads), 1)
			// The next request reads again, so a region just chosen here is served at once.
			yield* Ref.set(directory.answer, Option.some(chosen("us")))
			const next = yield* Effect.forkChild(Effect.exit(regions.ensureServedHere(orgId)))
			yield* TestClock.adjust("200 millis")
			assert.isTrue(Exit.isSuccess(yield* Fiber.join(next)))
		}),
	)

	it.effect("a request waiting on a hung read gives up and reads for itself", () =>
		Effect.gen(function* () {
			const directory = yield* makeDirectory(Option.some(chosen("eu")))
			const calls = yield* Ref.make(0)
			const firstHangs = {
				read: (id: OrgId) =>
					Ref.getAndUpdate(calls, (n) => n + 1).pipe(
						Effect.flatMap((n) => (n === 0 ? Effect.never : directory.read(id))),
					),
			}
			const regions = yield* isolate(makeMemoryBackend(), firstHangs)
			yield* Effect.forkChild(regions.ensureServedHere(orgId))
			yield* TestClock.adjust("10 millis")
			const follower = yield* Effect.forkChild(Effect.exit(regions.ensureServedHere(orgId)))
			yield* TestClock.adjust("6 seconds")
			assert.isTrue(isWrongRegion(yield* Fiber.join(follower)))
			assert.strictEqual(yield* Ref.get(calls), 2)
		}),
	)

	it.effect("requests wait out a slow Clerk read instead of each calling Clerk", () =>
		Effect.gen(function* () {
			const directory = yield* makeDirectory(Option.some(chosen("us")))
			const slowClerk = { read: (id: OrgId) => Effect.delay(directory.read(id), "2 seconds") }
			const regions = yield* isolate(makeMemoryBackend(), slowClerk)
			const pending = yield* Effect.forkChild(
				Effect.all(
					Array.from({ length: 3 }, () => Effect.exit(regions.ensureServedHere(orgId))),
					{ concurrency: "unbounded" },
				),
			)
			yield* TestClock.adjust("5 seconds")
			assert.isTrue((yield* Fiber.join(pending)).every(Exit.isSuccess))
			assert.strictEqual(yield* Ref.get(directory.reads), 1)
		}),
	)

	it.effect("a read started before forget never answers a request that came after it", () =>
		Effect.gen(function* () {
			const directory = yield* makeDirectory(Option.some(chosen("us")))
			const calls = yield* Ref.make(0)
			const firstReadStarted = yield* Deferred.make<void>()
			// Each call reads Clerk at once and answers later; the pre-forget read lands first.
			const clerk = {
				read: (id: OrgId) =>
					Effect.flatMap(
						Ref.getAndUpdate(calls, (n) => n + 1),
						(n) =>
							Effect.flatMap(directory.read(id), (answer) =>
								Deferred.succeed(firstReadStarted, undefined).pipe(
									Effect.andThen(Effect.sleep(n === 0 ? "100 millis" : "200 millis")),
									Effect.as(answer),
								),
							),
					),
			}
			const regions = yield* isolate(makeMemoryBackend(), clerk)
			const before = yield* Effect.forkChild(Effect.exit(regions.ensureServedHere(orgId)))
			yield* Deferred.await(firstReadStarted)
			// The region is written in the same millisecond, before the first read answers.
			yield* Ref.set(directory.answer, Option.some(chosen("eu")))
			yield* regions.forget(orgId)
			const after = yield* Effect.forkChild(
				Effect.all(
					[
						Effect.exit(regions.ensureServedHere(orgId)),
						Effect.exit(regions.ensureServedHere(orgId)),
					],
					{
						concurrency: "unbounded",
					},
				),
			)
			yield* TestClock.adjust("300 millis")
			assert.isTrue(Exit.isSuccess(yield* Fiber.join(before)))
			assert.isTrue((yield* Fiber.join(after)).every(isWrongRegion))
		}),
	)
})
