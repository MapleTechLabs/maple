import { assert, describe, it } from "@effect/vitest"
import { type GitCommitSha, OrgId } from "@maple/domain/http"
import { Effect, Exit, Layer, Option, Schema } from "effect"
import { VcsProviderRegistry } from "./VcsProviderRegistry"
import { VcsRepository } from "./VcsRepository"
import { VcsSourceService } from "./VcsSourceService"
import type { VcsProviderClient } from "./VcsProviderClient"

const ORG = Schema.decodeUnknownSync(OrgId)("org_source_test")
const OTHER_ORG = Schema.decodeUnknownSync(OrgId)("org_other")

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

const makeLayer = (providerCalls: string[]) => {
	const provider = {
		id: "github",
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
				return ref === "gone" ? Option.none() : Option.some("d".repeat(40) as GitCommitSha)
			}),
		fetchArchiveLink: (_installation, repo, sha) =>
			Effect.sync(() => {
				providerCalls.push(`archive:${repo.owner}/${repo.name}:${sha}`)
				return `https://codeload.test/${repo.owner}/${repo.name}/tar.gz/${sha}`
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
		listRepositoriesByInstallation: () => Effect.succeed([repository]),
	} as never)
	const registryLayer = Layer.succeed(VcsProviderRegistry, {
		ids: ["github"],
		resolve: () => Effect.succeed(provider),
	})
	return VcsSourceService.layer.pipe(Layer.provide(Layer.mergeAll(repoLayer, registryLayer)))
}

describe("VcsSourceService", () => {
	it.effect("uses only the current organization's active installation and tracked ref", () => {
		const calls: string[] = []
		return Effect.gen(function* () {
			const source = yield* VcsSourceService
			const repositories = yield* source.listRepositories(ORG)
			assert.deepStrictEqual(
				repositories.map((repo) => repo.fullName),
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

	it.effect("resolves a checkout at the tracked branch, at a named ref, and straight from a SHA", () => {
		const calls: string[] = []
		return Effect.gen(function* () {
			const source = yield* VcsSourceService
			const tracked = yield* source.resolveCheckout(ORG, "octo/shop")
			assert.strictEqual(tracked.ref, "production")
			assert.strictEqual(tracked.sha, "d".repeat(40))
			assert.match(tracked.archiveUrl, /tar\.gz\/d{40}$/)
			const pinned = yield* source.resolveCheckout(ORG, "octo/shop", "e".repeat(40))
			assert.strictEqual(pinned.sha, "e".repeat(40))
			const missing = yield* Effect.exit(source.resolveCheckout(ORG, "octo/shop", "gone"))
			assert.isTrue(Exit.isFailure(missing))
			assert.deepStrictEqual(calls, [
				"resolve:octo/shop:production",
				`archive:octo/shop:${"d".repeat(40)}`,
				`archive:octo/shop:${"e".repeat(40)}`,
				"resolve:octo/shop:gone",
			])
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
})
