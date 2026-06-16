import { afterEach, assert, describe, it } from "@effect/vitest"
import { generateKeyPairSync } from "node:crypto"
import { IntegrationsValidationError, OrgId, UserId, type VcsSyncJob } from "@maple/domain/http"
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import { DatabaseLibsqlLive } from "@/lib/DatabaseLibsqlLive"
import { Env } from "@/lib/Env"
import { cleanupTempDirs, createTempDbUrl } from "@/lib/test-sqlite"
import { GithubAppClient } from "@/services/github/GithubAppClient"
import { GithubConnectService } from "@/services/github/GithubConnectService"
import { GithubHttp, type GithubHttpShape } from "@/services/github/GithubHttp"
import { OAuthStateRepository } from "@/services/OAuthStateRepository"
import { VcsRepository } from "@/services/vcs/VcsRepository"
import { VcsSyncQueue, type VcsSyncQueueShape } from "@/services/vcs/VcsSyncQueue"

const dirs: string[] = []
afterEach(() => cleanupTempDirs(dirs))

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

// A real RSA key so the App-JWT mint (crypto.subtle.importKey) succeeds; the
// `GET /app/installations/{id}` call is stubbed at the GithubHttp seam below.
const APP_PRIVATE_KEY = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "spki", format: "pem" },
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey

const config = (url: string) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_DB_URL: url,
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			GITHUB_APP_SLUG: "maple-test-app",
			GITHUB_APP_ID: "123456",
			GITHUB_APP_PRIVATE_KEY: APP_PRIVATE_KEY,
		}),
	)

const jsonResponse = (body: unknown, init?: { status?: number }) =>
	new Response(JSON.stringify(body), {
		status: init?.status ?? 200,
		headers: { "content-type": "application/json" },
	})

// GithubHttp seam replaying canned responses in call order. completeConnect's
// only HTTP call is `GET /app/installations/{id}` (the App-JWT mint is local).
const scriptedHttp = (responders: ReadonlyArray<() => Response>) => {
	let i = 0
	return Layer.succeed(GithubHttp, {
		fetch: async () => {
			const make = responders[Math.min(i, responders.length - 1)]!
			i += 1
			return make()
		},
	} satisfies GithubHttpShape)
}

const installationResponse = () =>
	jsonResponse({
		id: 42,
		account: {
			login: "octo",
			id: 100,
			type: "Organization",
			avatar_url: "https://avatars.githubusercontent.com/u/100",
		},
		repository_selection: "all",
	})

const queueStub = (sent: Array<VcsSyncJob>): VcsSyncQueueShape => ({
	send: (job) => Effect.sync(() => void sent.push(job)),
	sendBatch: (jobs) => Effect.sync(() => void sent.push(...jobs)),
})

// Wire GithubConnectService over a temp sqlite (real repo + state repo), a real
// GithubAppClient backed by the stubbed GithubHttp, and a stubbed queue.
const connectLayer = (url: string, http: Layer.Layer<GithubHttp>, sent: Array<VcsSyncJob>) => {
	const env = Env.layer.pipe(Layer.provide(config(url)))
	const database = DatabaseLibsqlLive.pipe(Layer.provide(env))
	const data = Layer.mergeAll(
		VcsRepository.layer,
		OAuthStateRepository.layer,
		Layer.succeed(VcsSyncQueue, queueStub(sent)),
	).pipe(Layer.provide(database), Layer.provide(env))
	const githubAppClient = GithubAppClient.layer.pipe(Layer.provide(http), Layer.provide(env))
	const service = GithubConnectService.layer.pipe(
		Layer.provide(Layer.mergeAll(env, githubAppClient, data)),
	)
	return Layer.mergeAll(service, data)
}

const findError = <A, E>(exit: Exit.Exit<A, E>): unknown => {
	if (!Exit.isFailure(exit)) return undefined
	const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
	return failure ?? Cause.squash(exit.cause)
}

// The repo service now speaks our internal ids; these resolve a row by its GitHub
// external id (the way the sync engine seeds it) and hand the id-based methods the
// entity, so these tests can keep seeding by external id.
const expectSome = <A>(o: Option.Option<A>): A => {
	assert.ok(Option.isSome(o), "expected Option.some, got none")
	return o.value
}
const installationFor = (repo: VcsRepository, externalInstallationId: string) =>
	repo.resolveInstallation("github", externalInstallationId).pipe(Effect.map(expectSome))
const repoFor = (repo: VcsRepository, orgId: OrgId, externalRepoId: string) =>
	repo.resolveRepository(orgId, "github", externalRepoId).pipe(Effect.map(expectSome))
const upsertReposFor = (
	repo: VcsRepository,
	externalInstallationId: string,
	repos: Parameters<VcsRepository["upsertRepositories"]>[1],
) => installationFor(repo, externalInstallationId).pipe(Effect.flatMap((i) => repo.upsertRepositories(i, repos)))
const upsertCommitsFor = (
	repo: VcsRepository,
	orgId: OrgId,
	externalRepoId: string,
	commits: Parameters<VcsRepository["upsertCommits"]>[1],
) => repoFor(repo, orgId, externalRepoId).pipe(Effect.flatMap((r) => repo.upsertCommits(r, commits)))
const markRemovedFor = (repo: VcsRepository, orgId: OrgId, externalRepoId: string) =>
	repoFor(repo, orgId, externalRepoId).pipe(Effect.flatMap((r) => repo.markRepositoryRemoved(r.id)))
const reposOfInstallation = (repo: VcsRepository, externalInstallationId: string, scope: "active" | "all") =>
	Effect.gen(function* () {
		const found = yield* repo.resolveInstallation("github", externalInstallationId)
		return Option.isNone(found) ? [] : yield* repo.listRepositoriesByInstallation(found.value.id, scope)
	})

describe("GithubConnectService", () => {
	it.effect("startConnect mints a state row and returns the GitHub install URL with state", () => {
		const { url } = createTempDbUrl("maple-gh-start-", dirs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp([installationResponse])
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const { redirectUrl, state } = yield* svc.startConnect(
				asOrgId("org_test"),
				asUserId("user_1"),
				{ callbackUrl: "https://api.localhost/api/integrations/github/callback" },
			)
			assert.ok(state.length > 0)
			assert.ok(redirectUrl.startsWith("https://github.com/apps/maple-test-app/installations/new"))
			assert.ok(redirectUrl.includes(`state=${state}`))
		}).pipe(Effect.provide(connectLayer(url, http, sent)))
	})

	it.effect("completeConnect upserts the installation and enqueues a created sync job", () => {
		const { url } = createTempDbUrl("maple-gh-complete-", dirs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp([installationResponse])
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_test")
			const userId = asUserId("user_1")

			const { state } = yield* svc.startConnect(orgId, userId, {
				callbackUrl: "https://tunnel.example/api/integrations/github/callback",
				returnTo: "https://web.localhost/integrations?integration=github",
			})

			const result = yield* svc.completeConnect("42", state)
			assert.strictEqual(result.orgId, orgId)
			assert.strictEqual(result.returnTo, "https://web.localhost/integrations?integration=github")

			const found = yield* repo.resolveInstallation("github", "42")
			assert.ok(Option.isSome(found))
			assert.strictEqual(found.value.orgId, orgId)
			assert.strictEqual(found.value.accountLogin, "octo")
			assert.strictEqual(found.value.accountType, "organization")
			assert.strictEqual(found.value.externalAccountId, "100")
			assert.strictEqual(found.value.repositorySelection, "all")
			assert.strictEqual(found.value.installedByUserId, userId)
			assert.strictEqual(found.value.status, "active")

			assert.strictEqual(sent.length, 1)
			const job = sent[0]!
			assert.strictEqual(job.kind, "installation-sync")
			if (job.kind !== "installation-sync") return
			assert.strictEqual(job.provider, "github")
			assert.strictEqual(job.externalInstallationId, "42")
			assert.strictEqual(job.reason, "created")
		}).pipe(Effect.provide(connectLayer(url, http, sent)))
	})

	it.effect("completeConnect surfaces a 404 installation as a validation error", () => {
		const { url } = createTempDbUrl("maple-gh-404-", dirs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp([() => jsonResponse({ message: "Not Found" }, { status: 404 })])
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const { state } = yield* svc.startConnect(asOrgId("org_test"), asUserId("user_1"), {
				callbackUrl: "https://tunnel.example/cb",
			})

			const exit = yield* svc.completeConnect("42", state).pipe(Effect.exit)
			assert.ok(findError(exit) instanceof IntegrationsValidationError)

			const found = yield* repo.resolveInstallation("github", "42")
			assert.ok(Option.isNone(found))
			assert.strictEqual(sent.length, 0)
		}).pipe(Effect.provide(connectLayer(url, http, sent)))
	})

	it.effect("completeConnect rejects an unrecognized state without calling GitHub", () => {
		const { url } = createTempDbUrl("maple-gh-state-", dirs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp([installationResponse])
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const exit = yield* svc.completeConnect("42", "not-a-real-state").pipe(Effect.exit)
			assert.ok(findError(exit) instanceof IntegrationsValidationError)
			assert.strictEqual(sent.length, 0)
		}).pipe(Effect.provide(connectLayer(url, http, sent)))
	})

	it.effect("disconnect purges the installation with its repos + commits and is idempotent", () => {
		const { url } = createTempDbUrl("maple-gh-disconnect-", dirs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp([installationResponse])
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_test")
			const userId = asUserId("user_1")

			// Connect, then seed repos + commits the way the sync engine would.
			const { state } = yield* svc.startConnect(orgId, userId, {
				callbackUrl: "https://tunnel.example/api/integrations/github/callback",
			})
			yield* svc.completeConnect("42", state)
			yield* upsertReposFor(repo, "42", [
				{
					externalRepoId: "7",
					owner: "octo",
					name: "repo",
					fullName: "octo/repo",
					defaultBranch: "main",
					htmlUrl: "https://github.com/octo/repo",
					isPrivate: true,
					isArchived: false,
				},
			])
			const SHA = "a".repeat(40)
			yield* upsertCommitsFor(repo, orgId, "7", [
				{
					sha: SHA,
					message: "m",
					authorName: null,
					authorEmail: null,
					authorLogin: null,
					authorAvatarUrl: null,
					authoredAt: null,
					committedAt: 1,
					htmlUrl: `https://github.com/octo/repo/commit/${SHA}`,
					branch: "main",
				},
			])

			// Disconnect removes the installation row and all its VCS data.
			const result = yield* svc.disconnect(orgId)
			assert.strictEqual(result.disconnected, true)
			assert.ok(Option.isNone(yield* repo.resolveInstallation("github", "42")))
			assert.strictEqual((yield* reposOfInstallation(repo, "42", "all")).length, 0)
			assert.ok(Option.isNone(yield* repo.findCommitBySha(orgId, SHA as never)))

			// Status now reports disconnected, and a second disconnect is a no-op.
			const status = yield* svc.getStatus(orgId)
			assert.strictEqual(status.connected, false)
			const second = yield* svc.disconnect(orgId)
			assert.strictEqual(second.disconnected, false)
		}).pipe(Effect.provide(connectLayer(url, http, sent)))
	})

	it.effect("deleteRepository purges only that repo + its commits; getStatus surfaces removed repos", () => {
		const { url } = createTempDbUrl("maple-gh-del-repo-", dirs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp([installationResponse])
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_test")
			const userId = asUserId("user_1")

			const { state } = yield* svc.startConnect(orgId, userId, {
				callbackUrl: "https://tunnel.example/api/integrations/github/callback",
			})
			yield* svc.completeConnect("42", state)

			// Two repos: "7" (to delete) and "8" (kept), each with a commit.
			yield* upsertReposFor(repo, "42", [
				{
					externalRepoId: "7",
					owner: "octo",
					name: "repo",
					fullName: "octo/repo",
					defaultBranch: "main",
					htmlUrl: "https://github.com/octo/repo",
					isPrivate: true,
					isArchived: false,
				},
				{
					externalRepoId: "8",
					owner: "octo",
					name: "other",
					fullName: "octo/other",
					defaultBranch: "main",
					htmlUrl: "https://github.com/octo/other",
					isPrivate: false,
					isArchived: false,
				},
			])
			const SHA_7 = "a".repeat(40)
			const SHA_8 = "b".repeat(40)
			const seedCommit = (repoId: string, sha: string) =>
				upsertCommitsFor(repo, orgId, repoId, [
					{
						sha,
						message: "m",
						authorName: null,
						authorEmail: null,
						authorLogin: null,
						authorAvatarUrl: null,
						authoredAt: null,
						committedAt: 1,
						htmlUrl: `https://github.com/octo/r/commit/${sha}`,
						branch: "main",
					},
				])
			yield* seedCommit("7", SHA_7)
			yield* seedCommit("8", SHA_8)

			// Resolve repo "7"'s Maple id — the dashboard's delete handle — then mark
			// it removed so it's the provider-removed repo the user deletes.
			const repo7 = yield* repo.resolveRepository(orgId, "github", "7")
			assert.ok(Option.isSome(repo7))
			const repo7Id = repo7.value.id
			yield* markRemovedFor(repo, orgId, "7")
			// getStatus surfaces removed repos (scope "all") by Maple id, with status.
			const before = yield* svc.getStatus(orgId)
			const removed = before.repositories.find((r) => r.id === repo7Id)
			assert.ok(removed)
			assert.strictEqual(removed.status, "removed")

			const result = yield* svc.deleteRepository(orgId, repo7Id)
			assert.strictEqual(result.deleted, true)

			// "7" and its commit are gone; "8" and its commit remain.
			assert.ok(Option.isNone(yield* repo.resolveRepository(orgId, "github", "7")))
			assert.ok(Option.isNone(yield* repo.findCommitBySha(orgId, SHA_7 as never)))
			assert.ok(Option.isSome(yield* repo.resolveRepository(orgId, "github", "8")))
			assert.ok(Option.isSome(yield* repo.findCommitBySha(orgId, SHA_8 as never)))

			// Deleting the same (now-absent) id again is a no-op (idempotent).
			const again = yield* svc.deleteRepository(orgId, repo7Id)
			assert.strictEqual(again.deleted, false)
		}).pipe(Effect.provide(connectLayer(url, http, sent)))
	})

	it.effect("deleteRepository refuses to delete an active repo and leaves its data intact", () => {
		const { url } = createTempDbUrl("maple-gh-del-active-", dirs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp([installationResponse])
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_test")
			const userId = asUserId("user_1")

			const { state } = yield* svc.startConnect(orgId, userId, {
				callbackUrl: "https://tunnel.example/cb",
			})
			yield* svc.completeConnect("42", state)
			yield* upsertReposFor(repo, "42", [
				{
					externalRepoId: "7",
					owner: "octo",
					name: "repo",
					fullName: "octo/repo",
					defaultBranch: "main",
					htmlUrl: "https://github.com/octo/repo",
					isPrivate: true,
					isArchived: false,
				},
			])
			const SHA = "a".repeat(40)
			yield* upsertCommitsFor(repo, orgId, "7", [
				{
					sha: SHA,
					message: "m",
					authorName: null,
					authorEmail: null,
					authorLogin: null,
					authorAvatarUrl: null,
					authoredAt: null,
					committedAt: 1,
					htmlUrl: `https://github.com/octo/repo/commit/${SHA}`,
					branch: "main",
				},
			])

			// The repo is still active → delete is rejected; row + commit untouched.
			const repo7 = yield* repo.resolveRepository(orgId, "github", "7")
			assert.ok(Option.isSome(repo7))
			const exit = yield* svc.deleteRepository(orgId, repo7.value.id).pipe(Effect.exit)
			assert.ok(findError(exit) instanceof IntegrationsValidationError)
			assert.ok(Option.isSome(yield* repo.resolveRepository(orgId, "github", "7")))
			assert.ok(Option.isSome(yield* repo.findCommitBySha(orgId, SHA as never)))
		}).pipe(Effect.provide(connectLayer(url, http, sent)))
	})
})
