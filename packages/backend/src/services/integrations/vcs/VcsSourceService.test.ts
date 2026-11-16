import { assert, describe, it } from "@effect/vitest"
import { type GitCommitSha, OrgId } from "@maple/domain/http"
import {
	Cause,
	Deferred,
	Duration,
	Effect,
	Exit,
	Layer,
	Option,
	Predicate,
	Schema,
	Array as Arr,
	String as Str,
} from "effect"
import { TestClock } from "effect/testing"
import { VcsProviderRegistry } from "./VcsProviderRegistry"
import { VcsRepository } from "./VcsRepository"
import { CLONE_CREDENTIALS_REUSE, VcsSourceService } from "./VcsSourceService"
import type { VcsProviderClient } from "./VcsProviderClient"

const ORG = Schema.decodeSync(OrgId)("org_source_test")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_other")

const installation = {
	id: "00000000-0000-4000-8000-000000000001",
	orgId: ORG,
	provider: "github",
	status: "active",
} as const

const repository = {
	id: "00000000-0000-4000-8000-000000000002",
	orgId: ORG,
	provider: "github",
	installationId: installation.id,
	externalRepoId: "7",
	owner: "octo",
	name: "shop",
	fullName: "octo/shop",
	defaultBranch: "main",
	trackedBranch: "production",
	htmlUrl: "https://github.com/octo/shop",
	isPrivate: true,
	isArchived: false,
	status: "active",
	syncStatus: "ready",
} as const

const makeLayer = (providerCalls: string[], connected: { value: boolean } = { value: true }) => {
	const provider = {
		id: "github",
		reviewerMention: "@maple-review-bot",
		webhookSignatureHeader: "x-hub-signature-256",
		searchCode: (_installation, repo, query) =>
			Effect.sync(() => {
				providerCalls.push(`search:${repo.owner}/${repo.name}:${query}`)
				return [
					{
						path: "src/checkout.ts",
						sha: "blob",
						htmlUrl: "https://github.com/octo/shop/blob/main/src/checkout.ts",
						snippets: ["checkout"],
					},
				]
			}),
		resolveRef: (_installation, repo, ref) =>
			Effect.sync(() => {
				providerCalls.push(`resolve:${repo.owner}/${repo.name}:${ref}`)
				if (ref === "gone" || ref === Str.repeat(40)("f")) return Option.none()
				return Option.some((/^[0-9a-f]{40}$/.test(ref) ? ref : Str.repeat(40)("d")) as GitCommitSha)
			}),
		repositorySizeBytes: (_installation, repo) =>
			Effect.sync(() => {
				providerCalls.push(`size:${repo.owner}/${repo.name}`)
				return 5 * 1024 * 1024
			}),
		fetchCloneCredentials: (_installation, repo) =>
			Effect.sync(() => {
				providerCalls.push(`clone:${repo.owner}/${repo.name}`)
				return {
					remoteUrl: `https://github.test/${repo.owner}/${repo.name}.git`,
					token: "ghs_scoped",
				}
			}),
		fetchSourceFile: (_installation, repo, path, ref) =>
			Effect.sync(() => {
				providerCalls.push(`read:${repo.owner}/${repo.name}:${path}:${ref}`)
				return Option.some({
					path,
					sha: "blob",
					htmlUrl: "https://github.com/octo/shop/blob/production/src/checkout.ts",
					size: 8,
					content: "checkout",
				})
			}),
	} as VcsProviderClient

	const repoLayer = Layer.succeed(VcsRepository, {
		listInstallationsByOrg: (orgId: OrgId) => Effect.succeed(orgId === ORG ? [installation] : []),
		listActiveRepositoriesByOrg: (orgId: OrgId) =>
			Effect.sync(() => (connected.value && orgId === ORG ? [repository] : [])),
	} as never)
	const registryLayer = Layer.succeed(VcsProviderRegistry, {
		ids: ["github"],
		resolve: () => Effect.succeed(provider),
	})
	return Layer.effect(VcsSourceService, VcsSourceService.make).pipe(
		Layer.provide(Layer.mergeAll(repoLayer, registryLayer)),
	)
}

describe("VcsSourceService", () => {
	it.effect("uses only the current organization's active installation and tracked ref", () => {
		const calls: string[] = []
		return Effect.gen(function* () {
			const source = yield* VcsSourceService
			const repositories = yield* source.listRepositories(ORG)
			assert.deepStrictEqual(
				Arr.map(repositories, (repo) => repo.fullName),
				["octo/shop"],
			)
			assert.strictEqual(repositories[0]?.trackedBranch, "production")

			const matches = yield* source.searchCode(ORG, "OCTO/SHOP", "checkout", { limit: 5 })
			assert.strictEqual(matches[0]?.path, "src/checkout.ts")
			const file = yield* source.readFile(ORG, "octo/shop", "src/checkout.ts")
			assert.strictEqual(file.ref, "production")
			assert.deepStrictEqual(calls, [
				"search:octo/shop:checkout",
				"read:octo/shop:src/checkout.ts:production",
			])
		}).pipe(Effect.provide(makeLayer(calls)))
	})

	it.effect("reads a connected repository's size from its provider, and only the org's own", () => {
		const calls: string[] = []
		return Effect.gen(function* () {
			const source = yield* VcsSourceService
			const bytes = yield* source.repositorySizeBytes(ORG, "Octo/Shop")
			const other = yield* Effect.exit(source.repositorySizeBytes(OTHER_ORG, "octo/shop"))
			assert.deepStrictEqual(
				[bytes, Exit.isFailure(other), calls],
				[5 * 1024 * 1024, true, ["size:octo/shop"]],
			)
		}).pipe(Effect.provide(makeLayer(calls)))
	})

	it.effect("resolves a checkout at the tracked branch, at a named ref, and at a confirmed SHA", () => {
		const calls: string[] = []
		return Effect.gen(function* () {
			const source = yield* VcsSourceService
			const tracked = yield* source.resolveCheckout(ORG, "octo/shop")
			assert.strictEqual(tracked.ref, "production")
			assert.strictEqual(tracked.sha, Str.repeat(40)("d"))
			assert.strictEqual(tracked.remoteUrl, "https://github.test/octo/shop.git")
			// The credential stays apart from the URL, so nothing downstream can put it
			// in a command's arguments by accident.
			assert.strictEqual(tracked.token, "ghs_scoped")
			assert.notInclude(tracked.remoteUrl, "ghs_scoped")
			const pinned = yield* source.resolveCheckout(ORG, "octo/shop", Str.repeat(40)("e"))
			assert.strictEqual(pinned.sha, Str.repeat(40)("e"))
			const missing = yield* Effect.exit(source.resolveCheckout(ORG, "octo/shop", "gone"))
			assert.isTrue(Exit.isFailure(missing))
			assert.deepStrictEqual(calls, [
				"resolve:octo/shop:production",
				"clone:octo/shop",
				// The second checkout reuses the first one's clone token.
				`resolve:octo/shop:${Str.repeat(40)("e")}`,
				"resolve:octo/shop:gone",
			])
		}).pipe(Effect.provide(makeLayer(calls)))
	})

	it.effect("reuses a clone token while fresh but checks repository access on every checkout", () => {
		const calls: string[] = []
		const connected = { value: true }
		const sha = Str.repeat(40)("e")
		return Effect.gen(function* () {
			const source = yield* VcsSourceService
			yield* source.resolveCheckout(ORG, "octo/shop", sha)
			yield* source.resolveCheckout(ORG, "octo/shop", sha)
			assert.deepStrictEqual(calls, [`resolve:octo/shop:${sha}`, "clone:octo/shop"])

			yield* TestClock.adjust(Duration.sum(CLONE_CREDENTIALS_REUSE, Duration.seconds(1)))
			yield* source.resolveCheckout(ORG, "octo/shop", sha)
			assert.deepStrictEqual(calls, [`resolve:octo/shop:${sha}`, "clone:octo/shop", "clone:octo/shop"])

			// Disconnected inside the reuse window: the cached token is never handed out.
			connected.value = false
			const gone = yield* Effect.exit(source.resolveCheckout(ORG, "octo/shop", sha))
			assert.isTrue(Exit.isFailure(gone))
		}).pipe(Effect.provide(makeLayer(calls, connected)))
	})

	it.effect("refuses a SHA the repository does not have, and asks again on the next call", () => {
		const calls: string[] = []
		const invented = Str.repeat(40)("f")
		return Effect.gen(function* () {
			const source = yield* VcsSourceService
			const first = yield* Effect.exit(source.resolveCheckout(ORG, "octo/shop", invented))
			const second = yield* Effect.exit(source.resolveCheckout(ORG, "octo/shop", invented))
			const tagOf = (exit: typeof first) => {
				const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
				return Predicate.hasProperty(error, "_tag") ? error._tag : undefined
			}
			assert.deepStrictEqual(Arr.map([first, second], tagOf), [
				"@maple/backend/vcs/VcsSourceRefNotFoundError",
				"@maple/backend/vcs/VcsSourceRefNotFoundError",
			])
			assert.deepStrictEqual(calls, [`resolve:octo/shop:${invented}`, `resolve:octo/shop:${invented}`])
		}).pipe(Effect.provide(makeLayer(calls)))
	})

	it.effect("does not expose repositories across organizations", () => {
		const calls: string[] = []
		return Effect.gen(function* () {
			const source = yield* VcsSourceService
			const result = yield* Effect.exit(
				source.searchCode(OTHER_ORG, "octo/shop", "checkout", { limit: 5 }),
			)
			assert.ok(Exit.isFailure(result))
			assert.deepStrictEqual(calls, [])
		}).pipe(Effect.provide(makeLayer(calls)))
	})

	it.live("reads installations and repositories at the same time, one repository read per call", () =>
		Effect.gen(function* () {
			const repositoriesStarted = yield* Deferred.make<void>()
			const repositoryReads: OrgId[] = []
			const suspended = {
				...installation,
				id: "00000000-0000-4000-8000-000000000003",
				status: "suspended",
			}
			const second = { ...installation, id: "00000000-0000-4000-8000-000000000004" }
			const repoLayer = Layer.succeed(VcsRepository, {
				// Resolves only once the repository read has begun, so a sequential read never finishes.
				listInstallationsByOrg: () =>
					Deferred.await(repositoriesStarted).pipe(Effect.as([installation, suspended, second])),
				listActiveRepositoriesByOrg: (orgId: OrgId) =>
					Effect.sync(() => repositoryReads.push(orgId)).pipe(
						Effect.andThen(Deferred.succeed(repositoriesStarted, undefined)),
						Effect.as([
							repository,
							{
								...repository,
								id: "00000000-0000-4000-8000-000000000005",
								installationId: suspended.id,
								fullName: "octo/hidden",
							},
							{
								...repository,
								id: "00000000-0000-4000-8000-000000000006",
								installationId: second.id,
								fullName: "octo/api",
							},
						]),
					),
			} as never)
			const registryLayer = Layer.succeed(VcsProviderRegistry, {
				ids: ["github"],
				resolve: () => Effect.die("unused"),
			} as never)
			const repositories = yield* Effect.gen(function* () {
				const source = yield* VcsSourceService
				return yield* source.listRepositories(ORG)
			}).pipe(
				Effect.provide(
					Layer.effect(VcsSourceService, VcsSourceService.make).pipe(
						Layer.provide(Layer.mergeAll(repoLayer, registryLayer)),
					),
				),
				Effect.timeoutOrElse({
					duration: Duration.seconds(2),
					orElse: () => Effect.die("reads ran in sequence"),
				}),
			)
			assert.deepStrictEqual(
				[Arr.map(repositories, (repo) => repo.fullName), repositoryReads],
				[["octo/api", "octo/shop"], [ORG]],
			)
		}),
	)
})
