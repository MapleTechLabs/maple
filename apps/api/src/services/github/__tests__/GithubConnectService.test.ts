import { afterEach, assert, describe, it } from "@effect/vitest"
import { IntegrationsValidationError, type VcsSyncJob } from "@maple/domain/http"
import { Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { DatabaseLibsqlLive } from "@/lib/DatabaseLibsqlLive"
import { cleanupTempDirs, createTempDbUrl } from "@/lib/test-sqlite"
import { GithubAppClient } from "@/services/github/GithubAppClient"
import { GithubConnectService } from "@/services/github/GithubConnectService"
import type { GithubHttp } from "@/services/github/GithubHttp"
import { OAuthStateRepository } from "@/services/OAuthStateRepository"
import { VcsRepository } from "@/services/vcs/VcsRepository"
import { VcsSyncQueue } from "@/services/vcs/VcsSyncQueue"
import {
	asOrgId,
	asUserId,
	findError,
	GITHUB_APP_CONFIG,
	jsonResponse,
	markRemovedFor,
	recordingQueue,
	repoFor,
	reposOfInstallation,
	scriptedHttp,
	testEnv,
	upsertCommitsFor,
	upsertReposFor,
} from "../../vcs/__tests__/harness"

const dirs: string[] = []
afterEach(() => cleanupTempDirs(dirs))

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

// The OAuth `code` the callback carries when "Request user authorization during
// installation" is enabled. completeConnect now requires it for a *new* binding.
const TEST_CODE = "test-oauth-code"

// Responders for the user-OAuth leg, replayed in call order by scriptedHttp:
// POST /login/oauth/access_token → user token, then GET /user/installations.
const oauthTokenResponse = () => jsonResponse({ access_token: "user-token", token_type: "bearer" })
const userInstallationsResponse =
	(ids: ReadonlyArray<number> = [42]) =>
	() =>
		jsonResponse({ total_count: ids.length, installations: ids.map((id) => ({ id })) })

// A successful connect makes three ordered HTTP calls: OAuth token exchange, the
// user's administrable installations (must include 42), then the App-JWT
// installation detail. `rest` appends any responders the test needs afterward.
const connectResponders = (...rest: Array<() => Response>) => [
	oauthTokenResponse,
	userInstallationsResponse([42]),
	installationResponse,
	...rest,
]

// Wire GithubConnectService over a temp sqlite (real repo + state repo), a real
// GithubAppClient backed by the stubbed GithubHttp, and a recording queue.
const connectLayer = (url: string, http: Layer.Layer<GithubHttp>, sent: Array<VcsSyncJob>) => {
	const env = testEnv(url, GITHUB_APP_CONFIG)
	const database = DatabaseLibsqlLive.pipe(Layer.provide(env))
	const data = Layer.mergeAll(
		VcsRepository.layer,
		OAuthStateRepository.layer,
		Layer.succeed(VcsSyncQueue, recordingQueue(sent)),
	).pipe(Layer.provide(database), Layer.provide(env))
	const githubAppClient = GithubAppClient.layer.pipe(Layer.provide(http), Layer.provide(env))
	const service = GithubConnectService.layer.pipe(Layer.provide(Layer.mergeAll(env, githubAppClient, data)))
	return Layer.mergeAll(service, data)
}

describe("GithubConnectService", () => {
	it.effect("startConnect mints a state row and returns the GitHub install URL with state", () => {
		const { url } = createTempDbUrl("maple-gh-start-", dirs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp(connectResponders())
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const { redirectUrl, state } = yield* svc.startConnect(asOrgId("org_test"), asUserId("user_1"), {
				callbackUrl: "https://api.localhost/api/integrations/github/callback",
			})
			assert.ok(state.length > 0)
			assert.ok(redirectUrl.startsWith("https://github.com/apps/maple-test-app/installations/new"))
			assert.ok(redirectUrl.includes(`state=${state}`))
		}).pipe(Effect.provide(connectLayer(url, http, sent)))
	})

	it.effect("completeConnect upserts the installation and enqueues a created sync job", () => {
		const { url } = createTempDbUrl("maple-gh-complete-", dirs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp(connectResponders())
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_test")
			const userId = asUserId("user_1")

			const { state } = yield* svc.startConnect(orgId, userId, {
				callbackUrl: "https://tunnel.example/api/integrations/github/callback",
				returnTo: "https://web.localhost/integrations?integration=github",
			})

			const result = yield* svc.completeConnect("42", state, TEST_CODE)
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
		const http = scriptedHttp(
			connectResponders()
				.slice(0, 2)
				.concat(() => jsonResponse({ message: "Not Found" }, { status: 404 })),
		)
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const { state } = yield* svc.startConnect(asOrgId("org_test"), asUserId("user_1"), {
				callbackUrl: "https://tunnel.example/cb",
			})

			const exit = yield* svc.completeConnect("42", state, TEST_CODE).pipe(Effect.exit)
			assert.ok(findError(exit) instanceof IntegrationsValidationError)

			const found = yield* repo.resolveInstallation("github", "42")
			assert.ok(Option.isNone(found))
			assert.strictEqual(sent.length, 0)
		}).pipe(Effect.provide(connectLayer(url, http, sent)))
	})

	// Fail-closed: creating a *new* installation binding requires proof of
	// ownership (the OAuth `code`). Without it, the confused-deputy guard refuses
	// to claim the (enumerable) installation_id and connects nothing.
	it.effect("completeConnect refuses a new binding when no OAuth code is supplied", () => {
		const { url } = createTempDbUrl("maple-gh-no-code-", dirs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp(connectResponders())
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const { state } = yield* svc.startConnect(asOrgId("org_test"), asUserId("user_1"), {
				callbackUrl: "https://tunnel.example/cb",
			})

			// No `code` argument → rejected before any installation row is written.
			const exit = yield* svc.completeConnect("42", state).pipe(Effect.exit)
			assert.ok(findError(exit) instanceof IntegrationsValidationError)
			assert.ok(Option.isNone(yield* repo.resolveInstallation("github", "42")))
			assert.strictEqual(sent.length, 0)
		}).pipe(Effect.provide(connectLayer(url, http, sent)))
	})

	// The OAuth code is valid but the authorizing user does NOT administer the
	// supplied installation_id (it isn't in their /user/installations) — reject.
	it.effect("completeConnect rejects when the user cannot administer the installation", () => {
		const { url } = createTempDbUrl("maple-gh-not-admin-", dirs)
		const sent: Array<VcsSyncJob> = []
		// User administers installation 99, not the requested 42.
		const http = scriptedHttp([oauthTokenResponse, userInstallationsResponse([99]), installationResponse])
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const { state } = yield* svc.startConnect(asOrgId("org_test"), asUserId("user_1"), {
				callbackUrl: "https://tunnel.example/cb",
			})

			const exit = yield* svc.completeConnect("42", state, TEST_CODE).pipe(Effect.exit)
			assert.ok(findError(exit) instanceof IntegrationsValidationError)
			assert.ok(Option.isNone(yield* repo.resolveInstallation("github", "42")))
			assert.strictEqual(sent.length, 0)
		}).pipe(Effect.provide(connectLayer(url, http, sent)))
	})

	// A same-org reconnect/reconfigure of an installation this org already owns is
	// allowed without a fresh `code` (e.g. setup_action=update, which need not
	// carry one) — the existing row proves ownership, so we don't fail closed.
	it.effect("completeConnect allows a same-org reconnect without an OAuth code", () => {
		const { url } = createTempDbUrl("maple-gh-reconnect-", dirs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp(connectResponders())
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_test")

			// First connect (with code) establishes the org-owned installation row.
			const first = yield* svc.startConnect(orgId, asUserId("user_1"), {
				callbackUrl: "https://tunnel.example/cb",
			})
			yield* svc.completeConnect("42", first.state, TEST_CODE)
			assert.ok(Option.isSome(yield* repo.resolveInstallation("github", "42")))

			// Second connect from the SAME org, no code → still allowed (reconnect).
			const second = yield* svc.startConnect(orgId, asUserId("user_1"), {
				callbackUrl: "https://tunnel.example/cb",
			})
			const result = yield* svc.completeConnect("42", second.state)
			assert.strictEqual(result.orgId, orgId)
			const found = yield* repo.resolveInstallation("github", "42")
			assert.ok(Option.isSome(found))
			assert.strictEqual(found.value.orgId, orgId)
		}).pipe(Effect.provide(connectLayer(url, http, sent)))
	})

	it.effect("completeConnect rejects an unrecognized state without calling GitHub", () => {
		const { url } = createTempDbUrl("maple-gh-state-", dirs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp(connectResponders())
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const exit = yield* svc.completeConnect("42", "not-a-real-state").pipe(Effect.exit)
			assert.ok(findError(exit) instanceof IntegrationsValidationError)
			assert.strictEqual(sent.length, 0)
		}).pipe(Effect.provide(connectLayer(url, http, sent)))
	})

	// The state nonce is a short-lived (10-min) CSRF guard: a callback that arrives
	// after the TTL is rejected, and nothing is connected. (it.effect freezes the
	// clock, so we advance past the TTL with TestClock.)
	it.effect("completeConnect rejects an expired state and connects nothing", () => {
		const { url } = createTempDbUrl("maple-gh-state-expired-", dirs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp(connectResponders())
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const { state } = yield* svc.startConnect(asOrgId("org_test"), asUserId("user_1"), {
				callbackUrl: "https://tunnel.example/cb",
			})

			// Advance past the 10-minute STATE_TTL_MS before the callback returns.
			yield* TestClock.adjust("11 minutes")

			const exit = yield* svc.completeConnect("42", state, TEST_CODE).pipe(Effect.exit)
			assert.ok(findError(exit) instanceof IntegrationsValidationError)
			assert.ok(Option.isNone(yield* repo.resolveInstallation("github", "42")))
			assert.strictEqual(sent.length, 0)
		}).pipe(Effect.provide(connectLayer(url, http, sent)))
	})

	// State is single-use: it is consumed on the first callback, so a replay of the
	// same state (a duplicated / retried redirect) is rejected and never connects twice.
	it.effect("completeConnect consumes the state — a replay is rejected", () => {
		const { url } = createTempDbUrl("maple-gh-state-replay-", dirs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp(connectResponders())
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const { state } = yield* svc.startConnect(asOrgId("org_test"), asUserId("user_1"), {
				callbackUrl: "https://tunnel.example/cb",
			})

			// First callback succeeds and enqueues exactly one created sync job.
			yield* svc.completeConnect("42", state, TEST_CODE)
			assert.strictEqual(sent.length, 1)

			// Replaying the now-consumed state is rejected; no second job is enqueued.
			const exit = yield* svc.completeConnect("42", state, TEST_CODE).pipe(Effect.exit)
			assert.ok(findError(exit) instanceof IntegrationsValidationError)
			assert.strictEqual(sent.length, 1)
		}).pipe(Effect.provide(connectLayer(url, http, sent)))
	})

	it.effect("disconnect purges the installation with its repos + commits and is idempotent", () => {
		const { url } = createTempDbUrl("maple-gh-disconnect-", dirs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp(connectResponders())
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_test")
			const userId = asUserId("user_1")

			// Connect, then seed repos + commits the way the sync engine would.
			const { state } = yield* svc.startConnect(orgId, userId, {
				callbackUrl: "https://tunnel.example/api/integrations/github/callback",
			})
			yield* svc.completeConnect("42", state, TEST_CODE)
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

	it.effect(
		"deleteRepository purges only that repo + its commits; getStatus surfaces removed repos",
		() => {
			const { url } = createTempDbUrl("maple-gh-del-repo-", dirs)
			const sent: Array<VcsSyncJob> = []
			const http = scriptedHttp(connectResponders())
			return Effect.gen(function* () {
				const svc = yield* GithubConnectService
				const repo = yield* VcsRepository
				const orgId = asOrgId("org_test")
				const userId = asUserId("user_1")

				const { state } = yield* svc.startConnect(orgId, userId, {
					callbackUrl: "https://tunnel.example/api/integrations/github/callback",
				})
				yield* svc.completeConnect("42", state, TEST_CODE)

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
		},
	)

	it.effect("deleteRepository refuses to delete an active repo and leaves its data intact", () => {
		const { url } = createTempDbUrl("maple-gh-del-active-", dirs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp(connectResponders())
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_test")
			const userId = asUserId("user_1")

			const { state } = yield* svc.startConnect(orgId, userId, {
				callbackUrl: "https://tunnel.example/cb",
			})
			yield* svc.completeConnect("42", state, TEST_CODE)
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

	it.effect(
		"setTrackedBranch validates the branch, no-ops on the current one, and wipes+resyncs on change",
		() => {
			const { url } = createTempDbUrl("maple-gh-track-", dirs)
			const sent: Array<VcsSyncJob> = []
			const http = scriptedHttp(connectResponders())
			return Effect.gen(function* () {
				const svc = yield* GithubConnectService
				const repo = yield* VcsRepository
				const orgId = asOrgId("org_test")
				const userId = asUserId("user_1")

				const { state } = yield* svc.startConnect(orgId, userId, {
					callbackUrl: "https://tunnel.example/cb",
				})
				yield* svc.completeConnect("42", state, TEST_CODE)
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
				const r = yield* repoFor(repo, orgId, "7")
				// The tracked branch is seeded to the repo's default.
				assert.strictEqual(r.trackedBranch, "main")
				yield* repo.upsertBranches(r, [
					{ name: "main", headSha: null },
					{ name: "release", headSha: null },
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
					},
				])

				// An unknown branch is rejected; nothing changes.
				const bad = yield* svc.setTrackedBranch(orgId, r.id, "nope").pipe(Effect.exit)
				assert.ok(findError(bad) instanceof IntegrationsValidationError)
				assert.ok(Option.isSome(yield* repo.findCommitBySha(orgId, SHA as never)))

				// Selecting the current branch is a no-op: no wipe, no backfill enqueued.
				sent.length = 0
				const noop = yield* svc.setTrackedBranch(orgId, r.id, "main")
				assert.strictEqual(noop.backfillQueued, false)
				assert.ok(Option.isSome(yield* repo.findCommitBySha(orgId, SHA as never)))
				assert.strictEqual(sent.filter((j) => j.kind === "sync-commits").length, 0)

				// Changing the tracked branch wipes the repo's commits and enqueues a backfill
				// of the new branch.
				sent.length = 0
				const changed = yield* svc.setTrackedBranch(orgId, r.id, "release")
				assert.strictEqual(changed.trackedBranch, "release")
				assert.ok(changed.backfillQueued)
				assert.ok(Option.isNone(yield* repo.findCommitBySha(orgId, SHA as never)))
				assert.strictEqual((yield* repoFor(repo, orgId, "7")).trackedBranch, "release")
				const backfills = sent.filter((j) => j.kind === "sync-commits")
				assert.strictEqual(backfills.length, 1)
				assert.strictEqual(
					backfills[0]!.kind === "sync-commits" ? backfills[0]!.branch : "",
					"release",
				)
			}).pipe(Effect.provide(connectLayer(url, http, sent)))
		},
	)
})
