import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { Effect, Exit, Layer, Schema } from "effect"
import {
	githubCommits,
	githubInstallations,
	githubReleases,
	githubRepositories,
	githubUnresolvedShas,
} from "@maple/db"
import { OrgId, UserId } from "@maple/domain/http"
import { eq } from "drizzle-orm"
import { Database } from "./DatabaseLive"
import { GithubAppJwtService } from "./GithubAppJwtService"
import { GithubAppService } from "./GithubAppService"
import { cleanupTempDirs, createTempDbUrl as makeTempDb } from "./test-sqlite"
import { fullGithubConfig, makeBaseLayer, type TestGithubConfig } from "./github-test-helpers"

const createdTempDirs: string[] = []
afterEach(() => cleanupTempDirs(createdTempDirs))
const tempDb = () => makeTempDb("maple-github-app-", createdTempDirs)

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

const makeLayer = (override: Partial<TestGithubConfig> = {}) => {
	const { url } = tempDb()
	const cfg = { ...fullGithubConfig(url), ...override }
	// GithubAppService no longer depends on the queue, so no WorkerEnvironment
	// substitution is needed in tests — the regular `.layer` self-provides all
	// of its github primitives.
	return GithubAppService.layer.pipe(
		Layer.provideMerge(GithubAppJwtService.layer),
		Layer.provideMerge(makeBaseLayer(cfg)),
	)
}

// Seed an installation + N repos with K commits per repo + an unresolved tombstone.
const seed = (orgId: string, opts: { installationId?: number; repoCount?: number; commitsPerRepo?: number } = {}) =>
	Effect.gen(function* () {
		const database = yield* Database
		const installationDbId = randomUUID()
		const installationId = opts.installationId ?? 12345
		const repoCount = opts.repoCount ?? 1
		const commitsPerRepo = opts.commitsPerRepo ?? 2
		const now = Date.now()
		yield* database.execute((db) =>
			db.insert(githubInstallations).values({
				id: installationDbId,
				orgId,
				installationId,
				appSlug: "maple-test",
				accountId: 100,
				accountLogin: "acme",
				accountType: "Organization",
				targetType: "Organization",
				repositorySelection: "all",
				permissionsJson: "{}",
				eventsJson: "[]",
				installedByUserId: "user_1",
				createdAt: now,
				updatedAt: now,
			}),
		)
		const repoIds: string[] = []
		for (let i = 0; i < repoCount; i++) {
			const repoId = randomUUID()
			repoIds.push(repoId)
			yield* database.execute((db) =>
				db.insert(githubRepositories).values({
					id: repoId,
					orgId,
					installationId: installationDbId,
					// Vary by installationId so two seed() calls in one org don't
					// collide on the (org_id, github_repo_id) unique constraint.
					githubRepoId: installationId * 1000 + i + 1,
					owner: "acme",
					name: `repo-${installationId}-${i}`,
					defaultBranch: "main",
					private: false,
					htmlUrl: `https://github.com/acme/repo-${installationId}-${i}`,
					syncEnabled: true,
					backfillStatus: "complete",
					createdAt: now,
					updatedAt: now,
				}),
			)
			for (let c = 0; c < commitsPerRepo; c++) {
				// SHAs must be unique per (orgId, sha) — include installationId in the
				// pad so distinct seed() calls within the same org don't collide.
				const shaSeed = `${installationId}-${i}-${c}`
				const sha = (shaSeed + "0".repeat(40)).slice(0, 40)
				yield* database.execute((db) =>
					db.insert(githubCommits).values({
						id: randomUUID(),
						orgId,
						repoId,
						sha,
						shortSha: sha.slice(0, 7),
						message: `commit ${c}`,
						authoredAt: now,
						committedAt: now,
						htmlUrl: `https://github.com/acme/repo-${i}/commit/${sha}`,
						branchesJson: "[]",
						syncedAt: now,
						createdAt: now,
					}),
				)
			}
			yield* database.execute((db) =>
				db.insert(githubReleases).values({
					id: randomUUID(),
					orgId,
					repoId,
					githubReleaseId: installationId * 1000 + i + 1,
					tagName: `v1.${installationId}.${i}.0`,
					htmlUrl: `https://github.com/acme/repo-${installationId}-${i}/releases/tag/v1.${installationId}.${i}.0`,
					createdAt: now,
					syncedAt: now,
				}),
			)
		}
		yield* database.execute((db) =>
			db.insert(githubUnresolvedShas).values({
				id: randomUUID(),
				orgId,
				sha: `dead${installationId}beef`,
				attemptCount: 2,
				lastAttemptAt: now,
				permanent: false,
				createdAt: now,
				updatedAt: now,
			}),
		)
		return { installationDbId, repoIds }
	})

const countAll = Effect.gen(function* () {
	const database = yield* Database
	const installations = yield* database.execute((db) => db.select().from(githubInstallations))
	const repos = yield* database.execute((db) => db.select().from(githubRepositories))
	const commits = yield* database.execute((db) => db.select().from(githubCommits))
	const releases = yield* database.execute((db) => db.select().from(githubReleases))
	const tombstones = yield* database.execute((db) => db.select().from(githubUnresolvedShas))
	return {
		installations: installations.length,
		repos: repos.length,
		commits: commits.length,
		releases: releases.length,
		tombstones: tombstones.length,
	}
})

describe("GithubAppService", () => {
	describe("getStatus", () => {
		it("reports configured=true when env is set", async () => {
			const status = await Effect.runPromise(
				Effect.gen(function* () {
					const svc = yield* GithubAppService
					return yield* svc.getStatus(asOrgId("org_1"))
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(status.configured).toBe(true)
			expect(status.appSlug).toBe("maple-test")
			expect(status.missingEnv).toEqual([])
		})

		it("reports configured=false + lists missing keys", async () => {
			const status = await Effect.runPromise(
				Effect.gen(function* () {
					const svc = yield* GithubAppService
					return yield* svc.getStatus(asOrgId("org_1"))
				}).pipe(
					Effect.provide(
						makeLayer({
							appId: undefined,
							webhookSecret: undefined,
						}),
					),
				),
			)
			expect(status.configured).toBe(false)
			expect(status.missingEnv).toContain("GITHUB_APP_ID")
			expect(status.missingEnv).toContain("GITHUB_APP_WEBHOOK_SECRET")
		})

		it("counts installations for the org", async () => {
			const status = await Effect.runPromise(
				Effect.gen(function* () {
					const svc = yield* GithubAppService
					yield* seed("org_1", { installationId: 1 })
					yield* seed("org_1", { installationId: 2 })
					yield* seed("org_OTHER", { installationId: 3 })
					return yield* svc.getStatus(asOrgId("org_1"))
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(status.installations).toBe(2)
		})
	})

	describe("startInstall / consumeState", () => {
		it("startInstall returns a URL that contains the configured slug and a fresh state", async () => {
			const { redirectUrl, state } = await Effect.runPromise(
				Effect.gen(function* () {
					const svc = yield* GithubAppService
					return yield* svc.startInstall({
						orgId: asOrgId("org_1"),
						userId: asUserId("user_1"),
						callbackUrl: "https://example.com/cb",
					})
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(redirectUrl).toContain("apps/maple-test/installations/new")
			expect(redirectUrl).toContain(`state=${state}`)
			expect(state.length).toBeGreaterThan(20)
		})

		it("consumeState returns the org+user context and deletes the state row", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const svc = yield* GithubAppService
					const { state } = yield* svc.startInstall({
						orgId: asOrgId("org_42"),
						userId: asUserId("user_42"),
						callbackUrl: "https://x/cb",
						returnTo: "/back",
					})
					const ctx = yield* svc.consumeState(state)
					// Second consume should fail because the state was deleted
					const replay = yield* Effect.exit(svc.consumeState(state))
					return { ctx, replayed: Exit.isFailure(replay) }
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(result.ctx.orgId).toBe("org_42")
			expect(result.ctx.userId).toBe("user_42")
			expect(result.ctx.returnTo).toBe("/back")
			expect(result.replayed).toBe(true)
		})

		it("consumeState fails for an unknown state", async () => {
			const exit = await Effect.runPromiseExit(
				Effect.gen(function* () {
					const svc = yield* GithubAppService
					return yield* svc.consumeState("nonexistent-state")
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(Exit.isFailure(exit)).toBe(true)
		})
	})

	describe("listInstallations / listRepositories", () => {
		it("listInstallations includes repository counts", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const svc = yield* GithubAppService
					yield* seed("org_1", { repoCount: 3 })
					return yield* svc.listInstallations(asOrgId("org_1"))
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(result).toHaveLength(1)
			expect(result[0]?.repositoryCount).toBe(3)
		})

		it("listRepositories rejects unknown installation", async () => {
			const exit = await Effect.runPromiseExit(
				Effect.gen(function* () {
					const svc = yield* GithubAppService
					return yield* svc.listRepositories(asOrgId("org_1"), "no-such-installation")
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(Exit.isFailure(exit)).toBe(true)
		})

		it("listRepositories returns commit counts per repo", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const svc = yield* GithubAppService
					const { installationDbId } = yield* seed("org_1", { repoCount: 2, commitsPerRepo: 5 })
					return yield* svc.listRepositories(asOrgId("org_1"), installationDbId)
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(result).toHaveLength(2)
			expect(result[0]?.commitCount).toBe(5)
			expect(result[1]?.commitCount).toBe(5)
		})
	})

	// `setRepoSyncEnabled` + `findRepoForBackfill` were thin passthroughs over
	// GithubRepositoryRepo.updateById / findByOrgAndDbId; the github.http.ts
	// handlers now call the repo directly. Behavior is covered by the repo's
	// own unit coverage + the route-level coverage of those handlers.

	describe("disconnectInstallation — hard delete", () => {
		it("deletes installation + repos + commits + releases and clears tombstones", async () => {
			const counts = await Effect.runPromise(
				Effect.gen(function* () {
					const svc = yield* GithubAppService
					const { installationDbId } = yield* seed("org_1", {
						repoCount: 2,
						commitsPerRepo: 3,
					})
					yield* svc.disconnectInstallation({
						orgId: asOrgId("org_1"),
						installationId: installationDbId,
					})
					return yield* countAll
				}).pipe(Effect.provide(makeLayer())),
			)
			// Only this org had data; all should be zero
			expect(counts.installations).toBe(0)
			expect(counts.repos).toBe(0)
			expect(counts.commits).toBe(0)
			expect(counts.releases).toBe(0)
			expect(counts.tombstones).toBe(0)
		})

		it("keeps tombstones when another installation still exists for the same org", async () => {
			const tombstones = await Effect.runPromise(
				Effect.gen(function* () {
					const svc = yield* GithubAppService
					const { installationDbId: keep } = yield* seed("org_1", { installationId: 1 })
					const { installationDbId: drop } = yield* seed("org_1", { installationId: 2 })
					yield* svc.disconnectInstallation({
						orgId: asOrgId("org_1"),
						installationId: drop,
					})
					const counts = yield* countAll
					// First seed left 1 tombstone, second seed added another. After dropping one
					// installation, both tombstones should still exist because installation `keep`
					// is still present in this org.
					return counts.tombstones > 0
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(tombstones).toBe(true)
		})

		it("does not touch other orgs' data", async () => {
			const counts = await Effect.runPromise(
				Effect.gen(function* () {
					const svc = yield* GithubAppService
					const { installationDbId } = yield* seed("org_1", {
						installationId: 1,
						repoCount: 1,
						commitsPerRepo: 2,
					})
					yield* seed("org_OTHER", {
						installationId: 999,
						repoCount: 1,
						commitsPerRepo: 4,
					})
					yield* svc.disconnectInstallation({
						orgId: asOrgId("org_1"),
						installationId: installationDbId,
					})
					return yield* countAll
				}).pipe(Effect.provide(makeLayer())),
			)
			// org_OTHER should be intact: 1 installation, 1 repo, 4 commits, 1 release, 1 tombstone
			expect(counts.installations).toBe(1)
			expect(counts.repos).toBe(1)
			expect(counts.commits).toBe(4)
			expect(counts.releases).toBe(1)
			expect(counts.tombstones).toBe(1)
		})

		it("returns the GitHub uninstall URL", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const svc = yield* GithubAppService
					const { installationDbId } = yield* seed("org_1", { installationId: 12345 })
					return yield* svc.disconnectInstallation({
						orgId: asOrgId("org_1"),
						installationId: installationDbId,
					})
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(result.disconnected).toBe(true)
			expect(result.uninstallUrl).toContain("/settings/installations/12345")
		})

		it("rejects an unknown installation", async () => {
			const exit = await Effect.runPromiseExit(
				Effect.gen(function* () {
					const svc = yield* GithubAppService
					return yield* svc.disconnectInstallation({
						orgId: asOrgId("org_1"),
						installationId: "no-such-installation",
					})
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(Exit.isFailure(exit)).toBe(true)
		})
	})
})
