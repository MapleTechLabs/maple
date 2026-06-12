import { afterEach, assert, describe, it } from "@effect/vitest"
import { createHmac, randomUUID } from "node:crypto"
import {
	OrgId,
	UserId,
	VcsRepoDecodeError,
	VcsSyncJob,
	VcsWebhookParseError,
	VcsWebhookSignatureError,
} from "@maple/domain/http"
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import { DatabaseLibsqlLive } from "@/lib/DatabaseLibsqlLive"
import { Env } from "@/lib/Env"
import { cleanupTempDirs, createTempDbUrl, executeSql } from "@/lib/test-sqlite"
import { GithubAppClient } from "@/services/github/GithubAppClient"
import { GithubProvider } from "@/services/github/GithubProvider"
import type { VcsProviderClient } from "@/services/vcs/VcsProviderClient"
import { VcsProviderRegistry, type VcsProviderRegistryShape } from "@/services/vcs/VcsProviderRegistry"
import { VcsRepository } from "@/services/vcs/VcsRepository"
import { VcsSyncQueue, type VcsSyncQueueShape } from "@/services/vcs/VcsSyncQueue"
import { VcsSyncService } from "@/services/vcs/VcsSyncService"

const dirs: string[] = []
afterEach(() => cleanupTempDirs(dirs))

const WEBHOOK_SECRET = "testsecret"
const SHA = "abc1230000000000000000000000000000000def"

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
			GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET,
		}),
	)

const envLayer = (url: string) => Env.layer.pipe(Layer.provide(config(url)))

const repoLayer = (url: string) =>
	VcsRepository.layer.pipe(Layer.provide(DatabaseLibsqlLive), Layer.provide(envLayer(url)))

const providerLayer = () => {
	const env = envLayer("")
	return GithubProvider.layer.pipe(
		Layer.provide(Layer.mergeAll(env, GithubAppClient.layer.pipe(Layer.provide(env)))),
	)
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

const sign = (body: string) => `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`

const findError = <A, E>(exit: Exit.Exit<A, E>): unknown => {
	if (!Exit.isFailure(exit)) return undefined
	const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
	return failure ?? Cause.squash(exit.cause)
}

describe("VcsSyncJob", () => {
	it("round-trips through encode/decode", () => {
		const job: VcsSyncJob = {
			kind: "push-delta",
			provider: "github",
			externalInstallationId: "42",
			externalRepoId: "7",
			branch: "main",
			commits: [
				{
					sha: SHA,
					message: "hello",
					authorName: "Octo",
					authorEmail: "o@x.io",
					authorLogin: "octocat",
					authorAvatarUrl: null,
					authoredAt: 1,
					committedAt: 2,
					htmlUrl: "https://github.com/o/r/commit/x",
					branch: "main",
				},
			],
		}
		const wire = JSON.parse(JSON.stringify(Schema.encodeSync(VcsSyncJob)(job)))
		assert.deepStrictEqual(Schema.decodeUnknownSync(VcsSyncJob)(wire), job)
	})
})

describe("GithubProvider.webhookToJobs", () => {
	const pushBody = JSON.stringify({
		ref: "refs/heads/main",
		repository: { id: 7, owner: { login: "octo" } },
		installation: { id: 42 },
		commits: [
			{
				id: SHA,
				message: "hello world",
				timestamp: "2026-01-01T00:00:00Z",
				url: `https://github.com/octo/repo/commit/${SHA}`,
				author: { name: "Octo Cat", email: "octo@x.io", username: "octocat" },
			},
		],
	})

	it.effect("maps a validly-signed push to a push-delta job", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const jobs = yield* provider.webhookToJobs({
				headers: { "x-github-event": "push", "x-hub-signature-256": sign(pushBody) },
				rawBody: pushBody,
			})
			assert.strictEqual(jobs.length, 1)
			const job = jobs[0]!
			assert.strictEqual(job.kind, "push-delta")
			if (job.kind !== "push-delta") return
			assert.strictEqual(job.externalInstallationId, "42")
			assert.strictEqual(job.externalRepoId, "7")
			assert.strictEqual(job.branch, "main")
			assert.strictEqual(job.commits.length, 1)
			assert.strictEqual(job.commits[0]!.sha, SHA)
			assert.strictEqual(job.commits[0]!.authorLogin, "octocat")
		}).pipe(Effect.provide(providerLayer())),
	)

	it.effect("rejects an invalid signature with VcsWebhookSignatureError", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const exit = yield* provider
				.webhookToJobs({
					headers: { "x-github-event": "push", "x-hub-signature-256": "sha256=deadbeef" },
					rawBody: pushBody,
				})
				.pipe(Effect.exit)
			assert.ok(Exit.isFailure(exit))
			assert.ok(findError(exit) instanceof VcsWebhookSignatureError)
		}).pipe(Effect.provide(providerLayer())),
	)

	it.effect("maps an installation 'created' event to an installation-sync job", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const body = JSON.stringify({ action: "created", installation: { id: 99 } })
			const jobs = yield* provider.webhookToJobs({
				headers: { "x-github-event": "installation", "x-hub-signature-256": sign(body) },
				rawBody: body,
			})
			assert.strictEqual(jobs.length, 1)
			const job = jobs[0]!
			assert.strictEqual(job.kind, "installation-sync")
			if (job.kind !== "installation-sync") return
			assert.strictEqual(job.reason, "created")
			assert.strictEqual(job.externalInstallationId, "99")
		}).pipe(Effect.provide(providerLayer())),
	)
})

describe("VcsRepository", () => {
	it.effect("upserts + reads an installation and commits (validated)", () => {
		const { url } = createTempDbUrl("maple-vcs-repo-", dirs)
		return Effect.gen(function* () {
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_test")
			const installation = yield* repo.upsertInstallation({
				orgId,
				provider: "github",
				externalInstallationId: "42",
				accountLogin: "octo",
				accountType: "organization",
				externalAccountId: "100",
				accountAvatarUrl: null,
				repositorySelection: "all",
				installedByUserId: asUserId("user_1"),
			})
			assert.strictEqual(installation.orgId, orgId)
			assert.strictEqual(installation.accountType, "organization")

			const found = yield* repo.getInstallation("github", "42")
			assert.ok(Option.isSome(found))
			assert.strictEqual(found.value.externalInstallationId, "42")

			const count = yield* repo.upsertCommits(orgId, "github", "7", [
				{
					sha: SHA,
					message: "hello",
					authorName: "Octo",
					authorEmail: null,
					authorLogin: "octocat",
					authorAvatarUrl: null,
					authoredAt: null,
					committedAt: 123,
					htmlUrl: `https://github.com/octo/repo/commit/${SHA}`,
					branch: "main",
				},
			])
			assert.strictEqual(count, 1)

			const commit = yield* repo.findCommitBySha(orgId, SHA as never)
			assert.ok(Option.isSome(commit))
			assert.strictEqual(commit.value.shortSha, SHA.slice(0, 7))
			assert.strictEqual(commit.value.authorLogin, "octocat")
		}).pipe(Effect.provide(repoLayer(url)))
	})

	it.effect("raises VcsRepoDecodeError when a row has an invalid enum", () => {
		const { url, dbPath } = createTempDbUrl("maple-vcs-decode-", dirs)
		return Effect.gen(function* () {
			const repo = yield* VcsRepository
			// Corrupt a row directly (account_type is not a valid VcsAccountType).
			yield* Effect.promise(() =>
				executeSql(
					dbPath,
					`INSERT INTO vcs_installations
						(id, org_id, provider, external_installation_id, account_login, account_type,
						 external_account_id, repository_selection, status, installed_by_user_id, created_at, updated_at)
					 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
					[randomUUID(), "org_x", "github", "55", "octo", "team", "1", "all", "active", "user_1", 0, 0],
				),
			)
			const exit = yield* repo.getInstallation("github", "55").pipe(Effect.exit)
			assert.ok(Exit.isFailure(exit))
			assert.ok(findError(exit) instanceof VcsRepoDecodeError)
		}).pipe(Effect.provide(repoLayer(url)))
	})
})

describe("VcsSyncService orchestrator", () => {
	const SHA_A = "a".repeat(40)
	const SHA_B = "b".repeat(40)

	const commit = (sha: string, committedAt: number) => ({
		sha,
		message: `commit ${sha.slice(0, 7)}`,
		authorName: null,
		authorEmail: null,
		authorLogin: null,
		authorAvatarUrl: null,
		authoredAt: null,
		committedAt,
		htmlUrl: `https://github.com/o/r/commit/${sha}`,
		branch: "main",
	})

	interface StubOpts {
		readonly sent: Array<VcsSyncJob>
		readonly repos?: ReadonlyArray<{
			externalRepoId: string
			owner: string
			name: string
			fullName: string
			defaultBranch: string
			htmlUrl: string
			isPrivate: boolean
			isArchived: boolean
		}>
		readonly commits?: ReadonlyArray<ReturnType<typeof commit>>
	}

	// Real VcsRepository (temp D1) + stubbed provider/queue ports, so dispatch,
	// cursor direction, and the drop guards are exercised against real persistence.
	const orchestratorLayer = (url: string, opts: StubOpts) => {
		const fakeProvider: VcsProviderClient = {
			id: "github",
			webhookToJobs: () => Effect.succeed([]),
			fetchRepositories: () => Effect.succeed(opts.repos ?? []),
			fetchCommits: () => Effect.succeed(opts.commits ?? []),
		}
		const registry = Layer.succeed(VcsProviderRegistry, {
			ids: ["github"],
			resolve: () => Effect.succeed(fakeProvider),
		} satisfies VcsProviderRegistryShape)
		const queue = Layer.succeed(VcsSyncQueue, {
			send: (job) => Effect.sync(() => void opts.sent.push(job)),
			sendBatch: (jobs) => Effect.sync(() => void opts.sent.push(...jobs)),
		} satisfies VcsSyncQueueShape)
		const repoLive = VcsRepository.layer.pipe(
			Layer.provide(DatabaseLibsqlLive),
			Layer.provide(envLayer(url)),
		)
		return VcsSyncService.layer.pipe(Layer.provideMerge(Layer.mergeAll(repoLive, registry, queue)))
	}

	const seedInstallation = (repo: VcsRepository, orgId: ReturnType<typeof asOrgId>) =>
		repo.upsertInstallation({
			orgId,
			provider: "github",
			externalInstallationId: "42",
			accountLogin: "octo",
			accountType: "organization",
			externalAccountId: "100",
			accountAvatarUrl: null,
			repositorySelection: "all",
			installedByUserId: asUserId("user_1"),
		})

	it.effect("drops a job for an unknown installation without persisting or failing", () => {
		const { url } = createTempDbUrl("maple-vcs-orch-unknown-", dirs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			const job: VcsSyncJob = {
				kind: "push-delta",
				provider: "github",
				externalInstallationId: "999", // never seeded
				externalRepoId: "7",
				branch: "main",
				commits: [commit(SHA_A, 1)],
			}
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(job)) // must not fail
			const found = yield* repo.findCommitBySha(orgId, SHA_A as never)
			assert.ok(Option.isNone(found))
			assert.strictEqual(sent.length, 0)
		}).pipe(Effect.provide(orchestratorLayer(url, { sent })))
	})

	it.effect("push-delta upserts every commit", () => {
		const { url } = createTempDbUrl("maple-vcs-orch-push-", dirs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			const job: VcsSyncJob = {
				kind: "push-delta",
				provider: "github",
				externalInstallationId: "42",
				externalRepoId: "7",
				branch: "main",
				commits: [commit(SHA_A, 1), commit(SHA_B, 2)],
			}
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(job))
			const a = yield* repo.findCommitBySha(orgId, SHA_A as never)
			const b = yield* repo.findCommitBySha(orgId, SHA_B as never)
			assert.ok(Option.isSome(a) && Option.isSome(b))
		}).pipe(Effect.provide(orchestratorLayer(url, { sent })))
	})

	it.effect("installation-sync upserts the provider's repos and enqueues a backfill per repo", () => {
		const { url } = createTempDbUrl("maple-vcs-orch-inst-", dirs)
		const sent: Array<VcsSyncJob> = []
		const repos = [
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
		]
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			const job: VcsSyncJob = {
				kind: "installation-sync",
				provider: "github",
				externalInstallationId: "42",
				reason: "created",
			}
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(job))
			const stored = yield* repo.listRepositoriesByInstallation("github", "42")
			assert.strictEqual(stored.length, 1)
			assert.strictEqual(stored[0]!.externalRepoId, "7")
			assert.strictEqual(sent.length, 1)
			assert.strictEqual(sent[0]!.kind, "backfill-repo")
		}).pipe(Effect.provide(orchestratorLayer(url, { sent, repos })))
	})

	it.effect("backfill sets the cursor to the head (first/newest) commit", () => {
		const { url } = createTempDbUrl("maple-vcs-orch-backfill-", dirs)
		const sent: Array<VcsSyncJob> = []
		// GitHub returns newest-first; fetchCommits[0] is the head.
		const commits = [commit(SHA_B, 2), commit(SHA_A, 1)]
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* repo.upsertRepositories(orgId, "github", "42", [
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
			const job: VcsSyncJob = {
				kind: "backfill-repo",
				provider: "github",
				externalInstallationId: "42",
				externalRepoId: "7",
				owner: "octo",
				name: "repo",
				defaultBranch: "main",
				sinceMs: 0,
			}
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(job))
			const stored = yield* repo.listRepositoriesByInstallation("github", "42")
			assert.strictEqual(stored[0]!.syncStatus, "ready")
			assert.strictEqual(stored[0]!.lastSyncCursor, SHA_B)
		}).pipe(Effect.provide(orchestratorLayer(url, { sent, commits })))
	})
})

// The SHA-shape regex lives only in the GitCommitSha brand; these assert that
// validation fires at both the webhook decode boundary and on persistence.
describe("git SHA validation (branded type)", () => {
	it.effect("webhook decode rejects a malformed commit SHA with VcsWebhookParseError", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const body = JSON.stringify({
				ref: "refs/heads/main",
				repository: { id: 7, owner: { login: "octo" } },
				installation: { id: 42 },
				commits: [{ id: "not-a-real-sha", message: "x", url: "https://example.com" }],
			})
			const exit = yield* provider
				.webhookToJobs({
					headers: { "x-github-event": "push", "x-hub-signature-256": sign(body) },
					rawBody: body,
				})
				.pipe(Effect.exit)
			assert.ok(Exit.isFailure(exit))
			assert.ok(findError(exit) instanceof VcsWebhookParseError)
		}).pipe(Effect.provide(providerLayer())),
	)

	it.effect("upsertCommits rejects a malformed SHA with VcsRepoDecodeError", () => {
		const { url } = createTempDbUrl("maple-vcs-sha-", dirs)
		return Effect.gen(function* () {
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_sha")
			const exit = yield* repo
				.upsertCommits(orgId, "github", "7", [
					{
						sha: "ABC", // not 40-char lowercase hex
						message: "bad",
						authorName: null,
						authorEmail: null,
						authorLogin: null,
						authorAvatarUrl: null,
						authoredAt: null,
						committedAt: 1,
						htmlUrl: "https://example.com",
						branch: "main",
					},
				])
				.pipe(Effect.exit)
			assert.ok(Exit.isFailure(exit))
			assert.ok(findError(exit) instanceof VcsRepoDecodeError)
		}).pipe(Effect.provide(repoLayer(url)))
	})
})
