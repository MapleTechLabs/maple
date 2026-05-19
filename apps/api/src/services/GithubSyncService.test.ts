import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import {
	githubCommits,
	githubInstallations,
	githubRepositories,
	githubUnresolvedShas,
	type GithubInstallationRow,
	type GithubRepositoryRow,
} from "@maple/db"
import { eq } from "drizzle-orm"
import { Database } from "./DatabaseLive"
import { GithubAppJwtService } from "./GithubAppJwtService"
import { GithubInstallationClient, type GithubCommit, type GithubInstallation, type GithubRepo, type SearchCommitResult } from "./GithubInstallationClient"
import { GithubSyncService } from "./GithubSyncService"
import {
	cleanupTempDirs,
	createTempDbUrl as makeTempDb,
} from "./test-sqlite"
import { fullGithubConfig, makeBaseLayer } from "./github-test-helpers"

const createdTempDirs: string[] = []
afterEach(() => cleanupTempDirs(createdTempDirs))
const tempDb = () => makeTempDb("maple-github-sync-", createdTempDirs)

interface ClientStub {
	listInstallationRepositories?: (id: number) => GithubRepo[]
	listCommitsPaginated?: (id: number, opts: any) => { commits: GithubCommit[]; nextCursor: string | null }
	getCommit?: (id: number, owner: string, name: string, sha: string) => GithubCommit | null
	compareRefs?: (id: number, owner: string, name: string, base: string, head: string) => GithubCommit[]
	getInstallationMetadata?: (id: number) => GithubInstallation
	listBranchesForCommit?: (id: number, owner: string, name: string, sha: string) => string[]
	searchCommitBySha?: (id: number, sha: string) => SearchCommitResult | null
}

const makeMockClient = (stub: ClientStub) =>
	Layer.succeed(
		GithubInstallationClient,
		GithubInstallationClient.of({
			listInstallationRepositories: (id) =>
				stub.listInstallationRepositories
					? Effect.succeed(stub.listInstallationRepositories(id))
					: Effect.succeed([]),
			listCommitsPaginated: (id, opts) =>
				stub.listCommitsPaginated
					? Effect.succeed(stub.listCommitsPaginated(id, opts))
					: Effect.succeed({ commits: [], nextCursor: null }),
			getCommit: (id, owner, name, sha) =>
				stub.getCommit
					? Effect.succeed(stub.getCommit(id, owner, name, sha))
					: Effect.succeed(null),
			compareRefs: (id, owner, name, base, head) =>
				stub.compareRefs
					? Effect.succeed(stub.compareRefs(id, owner, name, base, head))
					: Effect.succeed([]),
			getInstallationMetadata: (id) =>
				stub.getInstallationMetadata
					? Effect.succeed(stub.getInstallationMetadata(id))
					: Effect.fail({
							_tag: "@maple/http/errors/IntegrationsUpstreamError",
							message: "not mocked",
						} as never),
			listBranchesForCommit: (id, owner, name, sha) =>
				stub.listBranchesForCommit
					? Effect.succeed(stub.listBranchesForCommit(id, owner, name, sha))
					: Effect.succeed([]),
			searchCommitBySha: (id, sha) =>
				stub.searchCommitBySha
					? Effect.succeed(stub.searchCommitBySha(id, sha))
					: Effect.succeed(null),
		}),
	)

const makeLayer = (clientStub: ClientStub) => {
	const { url } = tempDb()
	return GithubSyncService.bareLayer.pipe(
		Layer.provide(makeMockClient(clientStub)),
		Layer.provideMerge(GithubAppJwtService.layer),
		Layer.provideMerge(makeBaseLayer(fullGithubConfig(url))),
	)
}

const fakeRepo = (id: number, name: string): GithubRepo => ({
	id,
	name,
	full_name: `acme/${name}`,
	owner: { id: 1, login: "acme" },
	private: false,
	html_url: `https://github.com/acme/${name}`,
	default_branch: "main",
})

const fakeCommit = (sha: string, message = "feat: thing"): GithubCommit => ({
	sha,
	html_url: `https://github.com/acme/repo/commit/${sha}`,
	commit: {
		message,
		author: { name: "Jane", email: "jane@example.com", date: "2026-05-01T12:00:00Z" },
		committer: { name: "Jane", email: "jane@example.com", date: "2026-05-01T12:00:00Z" },
	},
	author: { login: "jane", id: 1, avatar_url: "https://avatars/jane" },
	committer: { login: "jane", id: 1, avatar_url: "https://avatars/jane" },
})

const fakeInstallation = (id: number, repoSelection: "all" | "selected" = "all"): GithubInstallation => ({
	id,
	account: { id: 100, login: "acme", type: "Organization", avatar_url: "https://avatars/acme" },
	app_slug: "maple-test",
	target_type: "Organization",
	repository_selection: repoSelection,
	permissions: { metadata: "read", contents: "read" },
	events: ["push"],
	suspended_at: null,
})

// Test helpers that bypass the service and directly query/seed the DB.
const seedInstallationAndRepos = (orgId: string, installationId: number, repos: Array<{ id: number; name: string }>) =>
	Effect.gen(function* () {
		const database = yield* Database
		const dbInstallationId = randomUUID()
		const now = Date.now()
		yield* database.execute((db) =>
			db.insert(githubInstallations).values({
				id: dbInstallationId,
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
		const repoRows: Array<{ id: string; githubRepoId: number }> = []
		for (const repo of repos) {
			const repoId = randomUUID()
			repoRows.push({ id: repoId, githubRepoId: repo.id })
			yield* database.execute((db) =>
				db.insert(githubRepositories).values({
					id: repoId,
					orgId,
					installationId: dbInstallationId,
					githubRepoId: repo.id,
					owner: "acme",
					name: repo.name,
					defaultBranch: "main",
					private: false,
					htmlUrl: `https://github.com/acme/${repo.name}`,
					syncEnabled: true,
					backfillStatus: "pending",
					createdAt: now,
					updatedAt: now,
				}),
			)
		}
		return { dbInstallationId, repoRows }
	})

const selectRepo = (orgId: string, repoId: string) =>
	Effect.gen(function* () {
		const database = yield* Database
		const rows = yield* database.execute((db) =>
			db.select().from(githubRepositories).where(eq(githubRepositories.id, repoId)).limit(1),
		)
		return rows[0] as GithubRepositoryRow | undefined
	})

const selectInstallation = (installationId: number) =>
	Effect.gen(function* () {
		const database = yield* Database
		const rows = yield* database.execute((db) =>
			db
				.select()
				.from(githubInstallations)
				.where(eq(githubInstallations.installationId, installationId))
				.limit(1),
		)
		return rows[0] as GithubInstallationRow | undefined
	})

const countCommits = Effect.gen(function* () {
	const database = yield* Database
	const rows = yield* database.execute((db) => db.select().from(githubCommits))
	return rows.length
})

const countTombstones = Effect.gen(function* () {
	const database = yield* Database
	const rows = yield* database.execute((db) => db.select().from(githubUnresolvedShas))
	return rows.length
})

describe("GithubSyncService", () => {
	describe("runReconcile", () => {
		it("creates installation + repo rows for a new install", async () => {
			const layer = makeLayer({
				getInstallationMetadata: () => fakeInstallation(12345),
				listInstallationRepositories: () => [fakeRepo(1, "repo-a"), fakeRepo(2, "repo-b")],
			})
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const sync = yield* GithubSyncService
					yield* sync.runReconcile({ orgId: "org_1", installationId: 12345 })
					const installation = yield* selectInstallation(12345)
					const database = yield* Database
					const repos = yield* database.execute((db) => db.select().from(githubRepositories))
					return { installation, repos }
				}).pipe(Effect.provide(layer)),
			)
			expect(result.installation?.accountLogin).toBe("acme")
			expect(result.repos).toHaveLength(2)
			expect(result.repos.map((r) => r.name).sort()).toEqual(["repo-a", "repo-b"])
		})

		it("disables sync on repos that GitHub no longer reports", async () => {
			const layer = makeLayer({
				getInstallationMetadata: () => fakeInstallation(12345),
				// Only repo 1 still in the install
				listInstallationRepositories: () => [fakeRepo(1, "repo-a")],
			})
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const sync = yield* GithubSyncService
					// Seed the DB with TWO repos; reconcile should keep #1, disable #2
					yield* seedInstallationAndRepos("org_1", 12345, [
						{ id: 1, name: "repo-a" },
						{ id: 2, name: "repo-b" },
					])
					yield* sync.runReconcile({ orgId: "org_1", installationId: 12345 })
					const database = yield* Database
					return yield* database.execute((db) => db.select().from(githubRepositories))
				}).pipe(Effect.provide(layer)),
			)
			const repoA = result.find((r) => r.name === "repo-a")
			const repoB = result.find((r) => r.name === "repo-b")
			expect(repoA?.syncEnabled).toBe(true)
			expect(repoB?.syncEnabled).toBe(false) // disabled, not deleted (preserves history)
		})

		it("marks suspended when metadata API fails", async () => {
			const layer = makeLayer({ /* no getInstallationMetadata → fails */ })
			const installation = await Effect.runPromise(
				Effect.gen(function* () {
					const sync = yield* GithubSyncService
					yield* seedInstallationAndRepos("org_1", 12345, [{ id: 1, name: "r" }])
					yield* sync.runReconcile({ orgId: "org_1", installationId: 12345 })
					return yield* selectInstallation(12345)
				}).pipe(Effect.provide(layer)),
			)
			expect(installation?.suspendedAt).not.toBeNull()
		})
	})

	describe("runBackfill", () => {
		it("writes commits and flips status to complete", async () => {
			const layer = makeLayer({
				listCommitsPaginated: () => ({
					commits: [fakeCommit("a".repeat(40)), fakeCommit("b".repeat(40), "fix: bug")],
					nextCursor: null,
				}),
			})
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const sync = yield* GithubSyncService
					const { repoRows } = yield* seedInstallationAndRepos("org_1", 12345, [
						{ id: 1, name: "repo-a" },
					])
					const repoId = repoRows[0]!.id
					const progress = yield* sync.runBackfill({
						orgId: "org_1",
						repoId,
						sinceUnixMs: 0,
						cursor: null,
					})
					const repo = yield* selectRepo("org_1", repoId)
					const commits = yield* countCommits
					return { progress, repo, commits }
				}).pipe(Effect.provide(layer)),
			)
			expect(result.progress.done).toBe(true)
			expect(result.repo?.backfillStatus).toBe("complete")
			expect(result.commits).toBe(2)
		})

		it("returns cursor and stays in 'running' when pagination has more pages", async () => {
			const layer = makeLayer({
				listCommitsPaginated: () => ({
					commits: [fakeCommit("c".repeat(40))],
					nextCursor: "https://api.github.com/page=2",
				}),
			})
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const sync = yield* GithubSyncService
					const { repoRows } = yield* seedInstallationAndRepos("org_1", 12345, [
						{ id: 1, name: "repo-a" },
					])
					const repoId = repoRows[0]!.id
					const progress = yield* sync.runBackfill({
						orgId: "org_1",
						repoId,
						sinceUnixMs: 0,
						cursor: null,
					})
					const repo = yield* selectRepo("org_1", repoId)
					return { progress, repo }
				}).pipe(Effect.provide(layer)),
			)
			expect(result.progress.done).toBe(false)
			expect(result.progress.cursor).toBe("https://api.github.com/page=2")
			expect(result.repo?.backfillStatus).toBe("running")
		})

		it("upserts on conflict (running backfill twice yields no duplicates)", async () => {
			const layer = makeLayer({
				listCommitsPaginated: () => ({
					commits: [fakeCommit("z".repeat(40))],
					nextCursor: null,
				}),
			})
			const count = await Effect.runPromise(
				Effect.gen(function* () {
					const sync = yield* GithubSyncService
					const { repoRows } = yield* seedInstallationAndRepos("org_1", 12345, [
						{ id: 1, name: "repo-a" },
					])
					const repoId = repoRows[0]!.id
					yield* sync.runBackfill({ orgId: "org_1", repoId, sinceUnixMs: 0, cursor: null })
					yield* sync.runBackfill({ orgId: "org_1", repoId, sinceUnixMs: 0, cursor: null })
					return yield* countCommits
				}).pipe(Effect.provide(layer)),
			)
			expect(count).toBe(1)
		})
	})

	describe("runWebhookPush", () => {
		const webhookCommit = (sha: string) => ({
			sha,
			message: "feat: thing",
			url: `https://github.com/acme/repo-a/commit/${sha}`,
			timestamp: "2026-05-01T12:00:00Z",
			author: { name: "Jane", email: "j@x", login: "jane" },
			committer: { name: "Jane", email: "j@x", login: "jane" },
		})

		it("writes commits from the embedded payload without any API calls", async () => {
			// No stubs at all — runWebhookPush must not call the client.
			const layer = makeLayer({})
			const count = await Effect.runPromise(
				Effect.gen(function* () {
					const sync = yield* GithubSyncService
					yield* seedInstallationAndRepos("org_1", 12345, [{ id: 1, name: "repo-a" }])
					yield* sync.runWebhookPush({
						orgId: "org_1",
						installationId: 12345,
						owner: "acme",
						name: "repo-a",
						ref: "refs/heads/main",
						before: "0".repeat(40),
						after: "f".repeat(40),
						forced: false,
						commits: [webhookCommit("a".repeat(40)), webhookCommit("b".repeat(40))],
					})
					return yield* countCommits
				}).pipe(Effect.provide(layer)),
			)
			expect(count).toBe(2)
		})

		it("is a no-op for a repo where sync_enabled=false", async () => {
			const layer = makeLayer({})
			const count = await Effect.runPromise(
				Effect.gen(function* () {
					const sync = yield* GithubSyncService
					const { repoRows } = yield* seedInstallationAndRepos("org_1", 12345, [
						{ id: 1, name: "repo-a" },
					])
					// Manually disable sync
					const database = yield* Database
					yield* database.execute((db) =>
						db
							.update(githubRepositories)
							.set({ syncEnabled: false })
							.where(eq(githubRepositories.id, repoRows[0]!.id)),
					)
					yield* sync.runWebhookPush({
						orgId: "org_1",
						installationId: 12345,
						owner: "acme",
						name: "repo-a",
						ref: "refs/heads/main",
						before: "0".repeat(40),
						after: "f".repeat(40),
						forced: false,
						commitShas: ["a".repeat(40)],
					})
					return yield* countCommits
				}).pipe(Effect.provide(layer)),
			)
			expect(count).toBe(0)
		})

		it("falls back to compareRefs when no inline commits are passed (queue path)", async () => {
			const layer = makeLayer({
				compareRefs: () => [fakeCommit("c".repeat(40))],
			})
			const count = await Effect.runPromise(
				Effect.gen(function* () {
					const sync = yield* GithubSyncService
					yield* seedInstallationAndRepos("org_1", 12345, [{ id: 1, name: "repo-a" }])
					yield* sync.runWebhookPush({
						orgId: "org_1",
						installationId: 12345,
						owner: "acme",
						name: "repo-a",
						ref: "refs/heads/main",
						before: "0".repeat(40),
						after: "f".repeat(40),
						forced: true,
						commitShas: [], // empty → fall back to compareRefs
					})
					return yield* countCommits
				}).pipe(Effect.provide(layer)),
			)
			expect(count).toBe(1)
		})
	})

	describe("runResolveUnknownSha", () => {
		const sha = "a".repeat(40)

		const fakeSearchHit = (githubRepoId: number) => ({
			sha,
			html_url: `https://github.com/acme/repo-a/commit/${sha}`,
			commit: {
				message: "feat: thing",
				author: { name: "Jane", email: "jane@x", date: "2026-05-01T12:00:00Z" },
				committer: { name: "Jane", email: "jane@x", date: "2026-05-01T12:00:00Z" },
			},
			author: { login: "jane", id: 1, avatar_url: "https://avatars/jane" },
			committer: { login: "jane", id: 1, avatar_url: "https://avatars/jane" },
			repository: {
				id: githubRepoId,
				name: "repo-a",
				full_name: "acme/repo-a",
				owner: { login: "acme" },
			},
		})

		it("writes commit when the search API returns a match", async () => {
			const layer = makeLayer({
				searchCommitBySha: (_id, requestSha) =>
					requestSha === sha ? fakeSearchHit(1) : null,
			})
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const sync = yield* GithubSyncService
					yield* seedInstallationAndRepos("org_1", 12345, [{ id: 1, name: "repo-a" }])
					const r = yield* sync.runResolveUnknownSha({ orgId: "org_1", sha })
					const commits = yield* countCommits
					const tombstones = yield* countTombstones
					return { resolved: r.resolved, commits, tombstones }
				}).pipe(Effect.provide(layer)),
			)
			expect(result.resolved).toBe(true)
			expect(result.commits).toBe(1)
			expect(result.tombstones).toBe(0)
		})

		it("treats search hit on a sync-disabled repo as unresolved", async () => {
			const layer = makeLayer({
				searchCommitBySha: () => fakeSearchHit(1),
			})
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const sync = yield* GithubSyncService
					const { repoRows } = yield* seedInstallationAndRepos("org_1", 12345, [
						{ id: 1, name: "repo-a" },
					])
					const database = yield* Database
					yield* database.execute((db) =>
						db
							.update(githubRepositories)
							.set({ syncEnabled: false })
							.where(eq(githubRepositories.id, repoRows[0]!.id)),
					)
					return yield* sync.runResolveUnknownSha({ orgId: "org_1", sha })
				}).pipe(Effect.provide(layer)),
			)
			expect(result.resolved).toBe(false)
		})

		it("writes tombstone with attempt_count=1 on first miss", async () => {
			const layer = makeLayer({ searchCommitBySha: () => null })
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const sync = yield* GithubSyncService
					yield* seedInstallationAndRepos("org_1", 12345, [{ id: 1, name: "repo-a" }])
					yield* sync.runResolveUnknownSha({ orgId: "org_1", sha })
					const database = yield* Database
					const rows = yield* database.execute((db) => db.select().from(githubUnresolvedShas))
					return rows[0]!
				}).pipe(Effect.provide(layer)),
			)
			expect(result.attemptCount).toBe(1)
			expect(result.permanent).toBe(false)
		})

		it("marks tombstone permanent after 3 failed attempts", async () => {
			const layer = makeLayer({ searchCommitBySha: () => null })
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const sync = yield* GithubSyncService
					yield* seedInstallationAndRepos("org_1", 12345, [{ id: 1, name: "repo-a" }])
					yield* sync.runResolveUnknownSha({ orgId: "org_1", sha })
					yield* sync.runResolveUnknownSha({ orgId: "org_1", sha })
					yield* sync.runResolveUnknownSha({ orgId: "org_1", sha })
					const database = yield* Database
					const rows = yield* database.execute((db) => db.select().from(githubUnresolvedShas))
					return rows[0]!
				}).pipe(Effect.provide(layer)),
			)
			expect(result.permanent).toBe(true)
		})

		it("ignores SHA values that don't match the regex", async () => {
			const layer = makeLayer({})
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const sync = yield* GithubSyncService
					yield* seedInstallationAndRepos("org_1", 12345, [{ id: 1, name: "repo-a" }])
					const r = yield* sync.runResolveUnknownSha({ orgId: "org_1", sha: "not-a-sha" })
					const tombstones = yield* countTombstones
					return { resolved: r.resolved, tombstones }
				}).pipe(Effect.provide(layer)),
			)
			expect(result.resolved).toBe(false)
			expect(result.tombstones).toBe(0)
		})

		it("no-ops on existing permanent tombstone (does not increment counter)", async () => {
			const layer = makeLayer({ searchCommitBySha: () => null })
			const final = await Effect.runPromise(
				Effect.gen(function* () {
					const sync = yield* GithubSyncService
					yield* seedInstallationAndRepos("org_1", 12345, [{ id: 1, name: "repo-a" }])
					// Bump to permanent
					yield* sync.runResolveUnknownSha({ orgId: "org_1", sha })
					yield* sync.runResolveUnknownSha({ orgId: "org_1", sha })
					yield* sync.runResolveUnknownSha({ orgId: "org_1", sha })
					// Should now be permanent — further calls should not change it
					const database = yield* Database
					const before = (yield* database.execute((db) => db.select().from(githubUnresolvedShas)))[0]!
					yield* sync.runResolveUnknownSha({ orgId: "org_1", sha })
					yield* sync.runResolveUnknownSha({ orgId: "org_1", sha })
					const after = (yield* database.execute((db) => db.select().from(githubUnresolvedShas)))[0]!
					return { before, after }
				}).pipe(Effect.provide(layer)),
			)
			expect((final.before as any).attemptCount).toEqual((final.after as any).attemptCount)
		})
	})
})
