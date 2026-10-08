import { assert, describe, it } from "@effect/vitest"
import {
	type EdgeCacheBackend,
	EdgeCacheService,
	makeEdgeCacheService,
	makeMemoryBackend,
} from "@maple/cache"
import { OrganizationWrongRegionError, OrgId } from "@maple/domain/http"
import type { MapleRegion } from "@maple/domain/organization-regions"
import { Effect, Exit, Option, Ref, Schema } from "effect"
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
								cause: undefined,
							}),
						),
					onSome: Effect.succeed,
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

	it.effect("a Clerk failure serves the request and is not cached as a region", () =>
		Effect.gen(function* () {
			const backend = makeMemoryBackend()
			const directory = yield* makeDirectory(Option.none())
			const regions = yield* isolate(backend, directory)
			yield* regions.ensureServedHere(orgId)
			assert.deepStrictEqual(yield* regions.servedHere(orgId), Option.none())
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
})
