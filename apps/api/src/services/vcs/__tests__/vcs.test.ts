import { afterEach, assert, describe, it } from "@effect/vitest"
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto"
import {
	GitCommitSha,
	OrgId,
	UserId,
	VcsInstallation,
	VcsInstallationGoneError,
	VcsProviderError,
	VcsRateLimitedError,
	VcsRepoDecodeError,
	VcsRepoUnavailableError,
	VcsSyncJob,
	VcsWebhookParseError,
	VcsWebhookSignatureError,
} from "@maple/domain/http"
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import { DatabaseLibsqlLive } from "@/lib/DatabaseLibsqlLive"
import { Env } from "@/lib/Env"
import { cleanupTempDirs, createTempDbUrl, executeSql } from "@/lib/test-sqlite"
import { GithubAppClient } from "@/services/github/GithubAppClient"
import { GithubHttp, type GithubHttpShape } from "@/services/github/GithubHttp"
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
	const client = GithubAppClient.layer.pipe(Layer.provide(Layer.mergeAll(env, GithubHttp.layer)))
	return GithubProvider.layer.pipe(Layer.provide(Layer.mergeAll(env, client)))
}

// A real RSA key so mintAppJwt's crypto.subtle.importKey succeeds; the App's REST
// calls are stubbed at the GithubHttp seam below.
const APP_PRIVATE_KEY = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "spki", format: "pem" },
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey

const appConfig = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		PORT: "3472",
		TINYBIRD_HOST: "https://api.tinybird.co",
		TINYBIRD_TOKEN: "test-token",
		MAPLE_DB_URL: "",
		MAPLE_AUTH_MODE: "self_hosted",
		MAPLE_ROOT_PASSWORD: "test-root-password",
		MAPLE_DEFAULT_ORG_ID: "default",
		MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
		MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET,
		GITHUB_APP_ID: "123456",
		GITHUB_APP_PRIVATE_KEY: APP_PRIVATE_KEY,
	}),
)

// Build a GithubProvider whose HTTP responses are scripted in call order. The
// first call is always the installation-token mint.
const stubbedProviderLayer = (responders: ReadonlyArray<() => Response>) => {
	let i = 0
	const http = Layer.succeed(GithubHttp, {
		fetch: async () => {
			const make = responders[Math.min(i, responders.length - 1)]!
			i += 1
			return make()
		},
	} satisfies GithubHttpShape)
	const env = Env.layer.pipe(Layer.provide(appConfig))
	const client = GithubAppClient.layer.pipe(Layer.provide(Layer.mergeAll(env, http)))
	return GithubProvider.layer.pipe(Layer.provide(Layer.mergeAll(env, client)))
}

const jsonResponse = (body: unknown, init?: { status?: number; headers?: Record<string, string> }) =>
	new Response(JSON.stringify(body), {
		status: init?.status ?? 200,
		headers: { "content-type": "application/json", ...init?.headers },
	})

const tokenResponse = () => jsonResponse({ token: "ghs_test", expires_at: "2099-01-01T00:00:00Z" })

const commitJson = (sha: string) => ({
	sha,
	html_url: `https://github.com/octo/repo/commit/${sha}`,
	commit: {
		message: "m",
		author: { name: "A", email: "a@x.io", date: "2026-01-01T00:00:00Z" },
		committer: { date: "2026-01-01T00:00:00Z" },
	},
	author: { login: "octo" },
})

const commitsResponse = (shas: ReadonlyArray<string>) => jsonResponse(shas.map(commitJson))

// 429 carrying retry-after (seconds): 0 ⇒ ride out inline; large ⇒ defer.
const rateLimited = (retryAfterSeconds: number) =>
	new Response("rate limited", { status: 429, headers: { "retry-after": String(retryAfterSeconds) } })

const hexShas = (count: number) =>
	Array.from({ length: count }, (_, n) => n.toString(16).padStart(40, "0"))

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

const sign = (body: string) => `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`

// The repo service now speaks our internal ids; these resolve a row the way a
// webhook does (by GitHub external id) and hand the id-based methods the entity,
// so the tests stay addressed by external id without re-querying everywhere.
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
const markInstStatusFor = (
	repo: VcsRepository,
	externalInstallationId: string,
	status: Parameters<VcsRepository["markInstallationStatus"]>[1],
) =>
	installationFor(repo, externalInstallationId).pipe(
		Effect.flatMap((i) => repo.markInstallationStatus(i.id, status)),
	)
const purgeInstallationFor = (repo: VcsRepository, orgId: OrgId, externalInstallationId: string) =>
	repo.resolveInstallation("github", externalInstallationId).pipe(
		Effect.flatMap(
			Option.match({
				onNone: () => Effect.void,
				onSome: (i) => repo.purgeInstallation(orgId, i.id),
			}),
		),
	)
const reposOfInstallation = (repo: VcsRepository, externalInstallationId: string, scope: "active" | "all") =>
	Effect.gen(function* () {
		const found = yield* repo.resolveInstallation("github", externalInstallationId)
		return Option.isNone(found) ? [] : yield* repo.listRepositoriesByInstallation(found.value.id, scope)
	})

const findError = <A, E>(exit: Exit.Exit<A, E>): unknown => {
	if (!Exit.isFailure(exit)) return undefined
	const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
	return failure ?? Cause.squash(exit.cause)
}

describe("VcsSyncJob", () => {
	it("round-trips through encode/decode", () => {
		const job: VcsSyncJob = {
			kind: "push",
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
		after: SHA,
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

	it.effect("maps a validly-signed push to a push job", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const jobs = yield* provider.webhookToJobs({
				headers: { "x-github-event": "push", "x-hub-signature-256": sign(pushBody) },
				rawBody: pushBody,
			})
			assert.strictEqual(jobs.length, 1)
			const job = jobs[0]!
			assert.strictEqual(job.kind, "push")
			if (job.kind !== "push") return
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

	// A Cloudflare Queue message caps at 128 KB and commit messages are unbounded,
	// so a large push must split into multiple jobs packed by *byte size* — each
	// independently enqueueable — rather than relying on a fixed commit count.
	it.effect("splits a large push into multiple jobs that each stay under the 128 KB queue cap", () =>
		Effect.gen(function* () {
			const QUEUE_MESSAGE_LIMIT = 128 * 1024
			const provider = yield* GithubProvider
			const shas = hexShas(400)
			const message = "x".repeat(1024) // ~1 KB messages ⇒ ~440 KB total ⇒ several jobs
			const body = JSON.stringify({
				ref: "refs/heads/main",
				repository: { id: 7, owner: { login: "octo" } },
				installation: { id: 42 },
				commits: shas.map((sha) => ({
					id: sha,
					message,
					timestamp: "2026-01-01T00:00:00Z",
					url: `https://github.com/octo/repo/commit/${sha}`,
					author: { name: "Octo Cat", email: "octo@x.io", username: "octocat" },
				})),
			})
			const jobs = yield* provider.webhookToJobs({
				headers: { "x-github-event": "push", "x-hub-signature-256": sign(body) },
				rawBody: body,
			})
			assert.ok(jobs.length > 1) // the push was split across multiple jobs
			for (const job of jobs) {
				assert.strictEqual(job.kind, "push")
				if (job.kind !== "push") return
				// Every job is independently enqueueable, regardless of the (count-blind) split.
				const wireBytes = Buffer.byteLength(JSON.stringify(Schema.encodeSync(VcsSyncJob)(job)))
				assert.ok(wireBytes < QUEUE_MESSAGE_LIMIT)
				// All slices share the same provider/installation/repo/branch.
				assert.strictEqual(job.externalInstallationId, "42")
				assert.strictEqual(job.externalRepoId, "7")
				assert.strictEqual(job.branch, "main")
			}
			// Every commit is preserved across the slices, in order — none dropped.
			const splitShas = jobs.flatMap((job) => (job.kind === "push" ? job.commits.map((c) => c.sha) : []))
			assert.deepStrictEqual(splitShas, shas)
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

			const found = yield* repo.resolveInstallation("github", "42")
			assert.ok(Option.isSome(found))
			assert.strictEqual(found.value.externalInstallationId, "42")
			// status is not passed to upsertInstallation — it comes from the schema default.
			assert.strictEqual(found.value.status, "active")

			// A commit requires its repo row to exist first (it references it by id).
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
			const repoRow = yield* repo.resolveRepository(orgId, "github", "7")
			assert.ok(Option.isSome(repoRow))

			const count = yield* upsertCommitsFor(repo, orgId, "7", [
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
			assert.strictEqual(commit.value.authorLogin, "octocat")
			// The commit is linked to its repo row by internal id.
			assert.strictEqual(commit.value.repositoryId, repoRow.value.id)
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
			const exit = yield* repo.resolveInstallation("github", "55").pipe(Effect.exit)
			assert.ok(Exit.isFailure(exit))
			assert.ok(findError(exit) instanceof VcsRepoDecodeError)
		}).pipe(Effect.provide(repoLayer(url)))
	})

	it.effect("purgeInstallation deletes the installation with its repos + commits, leaving other installations intact", () => {
		const { url } = createTempDbUrl("maple-vcs-purge-", dirs)
		return Effect.gen(function* () {
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_purge")
			const repoFixture = (externalRepoId: string, fullName: string) => ({
				externalRepoId,
				owner: fullName.split("/")[0]!,
				name: fullName.split("/")[1]!,
				fullName,
				defaultBranch: "main",
				htmlUrl: `https://github.com/${fullName}`,
				isPrivate: true,
				isArchived: false,
			})
			const commitFixture = (sha: string) => ({
				sha,
				message: "m",
				authorName: null,
				authorEmail: null,
				authorLogin: null,
				authorAvatarUrl: null,
				authoredAt: null,
				committedAt: 1,
				htmlUrl: `https://github.com/octo/repo/commit/${sha}`,
				branch: "main",
			})
			const seed = (externalInstallationId: string, accountLogin: string, externalAccountId: string) =>
				repo.upsertInstallation({
					orgId,
					provider: "github",
					externalInstallationId,
					accountLogin,
					accountType: "organization",
					externalAccountId,
					accountAvatarUrl: null,
					repositorySelection: "all",
					installedByUserId: asUserId("user_1"),
				})

			// Two installations in the same org, each with a repo + a commit.
			yield* seed("42", "octo", "100")
			yield* seed("99", "other", "200")
			yield* upsertReposFor(repo, "42", [repoFixture("7", "octo/repo")])
			yield* upsertReposFor(repo, "99", [repoFixture("8", "other/repo")])
			const SHA_42 = "a".repeat(40)
			const SHA_99 = "b".repeat(40)
			yield* upsertCommitsFor(repo, orgId, "7", [commitFixture(SHA_42)])
			yield* upsertCommitsFor(repo, orgId, "8", [commitFixture(SHA_99)])

			yield* purgeInstallationFor(repo, orgId, "42")

			// Installation 42 is fully gone — row, repositories, and commits.
			assert.ok(Option.isNone(yield* repo.resolveInstallation("github", "42")))
			assert.strictEqual((yield* reposOfInstallation(repo, "42", "all")).length, 0)
			assert.ok(Option.isNone(yield* repo.findCommitBySha(orgId, SHA_42 as never)))

			// Installation 99 is untouched — the commit delete was scoped to 42's repo ids.
			assert.ok(Option.isSome(yield* repo.resolveInstallation("github", "99")))
			assert.strictEqual((yield* reposOfInstallation(repo, "99", "all")).length, 1)
			assert.ok(Option.isSome(yield* repo.findCommitBySha(orgId, SHA_99 as never)))

			// Idempotent: purging again is a no-op, not an error.
			yield* purgeInstallationFor(repo, orgId, "42")
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
		readonly sentDelays?: Array<number | undefined>
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
		readonly commitFetchNext?: {
			untilMs: number
			retryAfterSeconds: number
			reason: "rate-limited" | "page-budget"
		}
		readonly fetchCommitsError?:
			| VcsProviderError
			| VcsInstallationGoneError
			| VcsRepoUnavailableError
		readonly fetchReposError?: VcsRateLimitedError | VcsProviderError | VcsInstallationGoneError
	}

	// Real VcsRepository (temp D1) + stubbed provider/queue ports, so dispatch,
	// cursor direction, and the drop guards are exercised against real persistence.
	const orchestratorLayer = (url: string, opts: StubOpts) => {
		const fakeProvider: VcsProviderClient = {
			id: "github",
			webhookToJobs: () => Effect.succeed([]),
			fetchRepositories: () =>
				opts.fetchReposError
					? Effect.fail(opts.fetchReposError)
					: Effect.succeed(opts.repos ?? []),
			fetchCommits: () =>
				opts.fetchCommitsError
					? Effect.fail(opts.fetchCommitsError)
					: Effect.succeed({
							commits: opts.commits ?? [],
							...(opts.commitFetchNext ? { next: opts.commitFetchNext } : {}),
						}),
		}
		const registry = Layer.succeed(VcsProviderRegistry, {
			ids: ["github"],
			resolve: () => Effect.succeed(fakeProvider),
		} satisfies VcsProviderRegistryShape)
		const queue = Layer.succeed(VcsSyncQueue, {
			send: (job, options) =>
				Effect.sync(() => {
					opts.sent.push(job)
					opts.sentDelays?.push(options?.delaySeconds)
				}),
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
				kind: "push",
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

	it.effect("push upserts every commit and never changes repo sync state", () => {
		const { url } = createTempDbUrl("maple-vcs-orch-push-", dirs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo) // a freshly-discovered repo (pending, no cursor)
			const job: VcsSyncJob = {
				kind: "push",
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
			// B2: a push is pure enrichment — the sync status stays exactly as the
			// backfill left it (here: untouched since no backfill has run).
			const stored = yield* reposOfInstallation(repo, "42", "all")
			assert.strictEqual(stored[0]!.syncStatus, "pending")
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
			const stored = yield* reposOfInstallation(repo, "42", "all")
			assert.strictEqual(stored.length, 1)
			assert.strictEqual(stored[0]!.externalRepoId, "7")
			assert.strictEqual(sent.length, 1)
			assert.strictEqual(sent[0]!.kind, "backfill-repo")
		}).pipe(Effect.provide(orchestratorLayer(url, { sent, repos })))
	})

	// A new installation supersedes any prior one for the org: if the user removed
	// the old GitHub installation without Maple receiving the `installation.deleted`
	// webhook, the stale (still "active") row — and its repos/commits — is purged,
	// so the org is never left with multiple active installations.
	it.effect("a 'created' installation-sync purges any prior installation for the org", () => {
		const { url } = createTempDbUrl("maple-vcs-orch-supersede-", dirs)
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

			// A stale prior installation ("11"), still active in Maple because the
			// GitHub uninstall webhook never arrived, with a repo + commit of its own.
			yield* repo.upsertInstallation({
				orgId,
				provider: "github",
				externalInstallationId: "11",
				accountLogin: "old",
				accountType: "organization",
				externalAccountId: "1",
				accountAvatarUrl: null,
				repositorySelection: "all",
				installedByUserId: asUserId("user_1"),
			})
			yield* upsertReposFor(repo, "11", [
				{
					externalRepoId: "70",
					owner: "old",
					name: "repo",
					fullName: "old/repo",
					defaultBranch: "main",
					htmlUrl: "https://github.com/old/repo",
					isPrivate: true,
					isArchived: false,
				},
			])
			const STALE_SHA = "c".repeat(40)
			yield* upsertCommitsFor(repo, orgId, "70", [commit(STALE_SHA, 1)])

			// The freshly-connected installation ("42") exists; its created sync job runs.
			yield* seedInstallation(repo, orgId)
			const job: VcsSyncJob = {
				kind: "installation-sync",
				provider: "github",
				externalInstallationId: "42",
				reason: "created",
			}
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(job))

			// The prior installation, its repos, and its commits are all hard-deleted…
			assert.ok(Option.isNone(yield* repo.resolveInstallation("github", "11")))
			assert.strictEqual((yield* reposOfInstallation(repo, "11", "all")).length, 0)
			assert.ok(Option.isNone(yield* repo.findCommitBySha(orgId, STALE_SHA as never)))

			// …leaving exactly the new installation, which synced its own repo.
			const remaining = (yield* repo.listInstallationsByOrg(orgId)).filter((i) => i.provider === "github")
			assert.strictEqual(remaining.length, 1)
			assert.strictEqual(remaining[0]!.externalInstallationId, "42")
			const newRepos = yield* reposOfInstallation(repo, "42", "all")
			assert.strictEqual(newRepos.length, 1)
			assert.strictEqual(newRepos[0]!.externalRepoId, "7")
		}).pipe(Effect.provide(orchestratorLayer(url, { sent, repos })))
	})

	it.effect("backfill persists fetched commits and marks the repo ready", () => {
		const { url } = createTempDbUrl("maple-vcs-orch-backfill-", dirs)
		const sent: Array<VcsSyncJob> = []
		const commits = [commit(SHA_A, 1), commit(SHA_B, 2)]
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
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
			const a = yield* repo.findCommitBySha(orgId, SHA_A as never)
			const b = yield* repo.findCommitBySha(orgId, SHA_B as never)
			assert.ok(Option.isSome(a) && Option.isSome(b))
			const stored = yield* reposOfInstallation(repo, "42", "all")
			assert.strictEqual(stored[0]!.syncStatus, "ready")
		}).pipe(Effect.provide(orchestratorLayer(url, { sent, commits })))
	})

	const seedRepo = (repo: VcsRepository) =>
		upsertReposFor(repo, "42", [
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

	const backfillJob: VcsSyncJob = {
		kind: "backfill-repo",
		provider: "github",
		externalInstallationId: "42",
		externalRepoId: "7",
		owner: "octo",
		name: "repo",
		defaultBranch: "main",
		sinceMs: 0,
	}

	it.effect("VcsRepoUnavailableError marks the repo errored and leaves the installation active", () => {
		const { url } = createTempDbUrl("maple-vcs-orch-repo-gone-", dirs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo)
			// A repo-scoped error must NOT fail the job (it drains).
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(backfillJob))
			const inst = yield* repo.resolveInstallation("github", "42")
			assert.ok(Option.isSome(inst))
			assert.strictEqual(inst.value.status, "active") // never disconnected
			const stored = yield* reposOfInstallation(repo, "42", "all")
			assert.strictEqual(stored[0]!.syncStatus, "error")
		}).pipe(
			Effect.provide(
				orchestratorLayer(url, {
					sent,
					fetchCommitsError: new VcsRepoUnavailableError({ message: "repo gone" }),
				}),
			),
		)
	})

	it.effect("VcsInstallationGoneError disconnects the installation and drains the job", () => {
		const { url } = createTempDbUrl("maple-vcs-orch-inst-gone-", dirs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo) // backfill is gated on the repo row existing
			// The provider's authoritative gone signal → disconnect, no failure.
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(backfillJob))
			const inst = yield* repo.resolveInstallation("github", "42")
			assert.ok(Option.isSome(inst))
			assert.strictEqual(inst.value.status, "disconnected")
		}).pipe(
			Effect.provide(
				orchestratorLayer(url, {
					sent,
					fetchCommitsError: new VcsInstallationGoneError({ message: "installation gone" }),
				}),
			),
		)
	})

	it.effect("transient VcsProviderError fails the job so the queue retries, installation untouched", () => {
		const { url } = createTempDbUrl("maple-vcs-orch-transient-", dirs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo) // backfill is gated on the repo row existing
			const exit = yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(backfillJob)).pipe(Effect.exit)
			assert.ok(Exit.isFailure(exit)) // transient → propagated so the queue retries
			const inst = yield* repo.resolveInstallation("github", "42")
			assert.ok(Option.isSome(inst))
			assert.strictEqual(inst.value.status, "active")
		}).pipe(
			Effect.provide(
				orchestratorLayer(url, {
					sent,
					fetchCommitsError: new VcsProviderError({ message: "upstream unavailable", status: 503 }),
				}),
			),
		)
	})

	// C1: the processability gate. A non-active installation must process nothing.
	it.effect("a suspended installation is skipped — no data processed, no failure", () => {
		const { url } = createTempDbUrl("maple-vcs-orch-suspended-", dirs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* markInstStatusFor(repo, "42", "suspended")
			const job: VcsSyncJob = {
				kind: "push",
				provider: "github",
				externalInstallationId: "42",
				externalRepoId: "7",
				branch: "main",
				commits: [commit(SHA_A, 1)],
			}
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(job)) // gated → must not fail
			const a = yield* repo.findCommitBySha(orgId, SHA_A as never)
			assert.ok(Option.isNone(a)) // gate short-circuits before the upsert
			const inst = yield* repo.resolveInstallation("github", "42")
			assert.ok(Option.isSome(inst))
			assert.strictEqual(inst.value.status, "suspended") // status untouched
		}).pipe(Effect.provide(orchestratorLayer(url, { sent, commits: [commit(SHA_A, 1)] })))
	})

	// C1: unsuspend must flip the installation back to active and resume syncing.
	it.effect("unsuspend reactivates a suspended installation and re-syncs its repos", () => {
		const { url } = createTempDbUrl("maple-vcs-orch-unsuspend-", dirs)
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
			yield* markInstStatusFor(repo, "42", "suspended")
			const job: VcsSyncJob = {
				kind: "installation-sync",
				provider: "github",
				externalInstallationId: "42",
				reason: "unsuspend",
			}
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(job))
			const inst = yield* repo.resolveInstallation("github", "42")
			assert.ok(Option.isSome(inst))
			assert.strictEqual(inst.value.status, "active") // reactivated
			const stored = yield* reposOfInstallation(repo, "42", "all")
			assert.strictEqual(stored.length, 1) // re-sync ran
			assert.strictEqual(sent.length, 1)
			assert.strictEqual(sent[0]!.kind, "backfill-repo")
		}).pipe(Effect.provide(orchestratorLayer(url, { sent, repos })))
	})

	// A rate-limited backfill checkpoints + requeues a delayed continuation rather
	// than failing — no retry budget spent, finished pages not refetched.
	it.effect("a rate-limited backfill requeues a continuation with a cursor + delay", () => {
		const { url } = createTempDbUrl("maple-vcs-orch-backfill-rl-", dirs)
		const sent: Array<VcsSyncJob> = []
		const sentDelays: Array<number | undefined> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo)
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(backfillJob)) // must not fail
			// The fetched commit was persisted…
			assert.ok(Option.isSome(yield* repo.findCommitBySha(orgId, SHA_A as never)))
			// …the repo is marked backfilling (in progress, not ready)…
			const stored = yield* reposOfInstallation(repo, "42", "all")
			assert.strictEqual(stored[0]!.syncStatus, "backfilling")
			// …and a continuation was requeued from the watermark, delayed until reset.
			assert.strictEqual(sent.length, 1)
			const continuation = sent[0]!
			assert.strictEqual(continuation.kind, "backfill-repo")
			if (continuation.kind !== "backfill-repo") return
			assert.strictEqual(continuation.untilMs, 5000)
			assert.strictEqual(sentDelays[0], 600)
		}).pipe(
			Effect.provide(
				orchestratorLayer(url, {
					sent,
					sentDelays,
					commits: [commit(SHA_A, 1)],
					commitFetchNext: { untilMs: 5000, retryAfterSeconds: 600, reason: "rate-limited" },
				}),
			),
		)
	})

	// A page-budget continuation (the walk yielded to stay under the queue's 15-min
	// limit, NOT throttled) checkpoints and requeues to continue *immediately*.
	it.effect("a page-budget backfill requeues a continuation with no delay", () => {
		const { url } = createTempDbUrl("maple-vcs-orch-backfill-budget-", dirs)
		const sent: Array<VcsSyncJob> = []
		const sentDelays: Array<number | undefined> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo)
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(backfillJob)) // must not fail
			// The fetched page was persisted and the repo marked backfilling…
			assert.ok(Option.isSome(yield* repo.findCommitBySha(orgId, SHA_A as never)))
			const stored = yield* reposOfInstallation(repo, "42", "all")
			assert.strictEqual(stored[0]!.syncStatus, "backfilling")
			// …and a continuation was requeued from the watermark with NO delay…
			assert.strictEqual(sent.length, 1)
			const continuation = sent[0]!
			assert.strictEqual(continuation.kind, "backfill-repo")
			if (continuation.kind !== "backfill-repo") return
			assert.strictEqual(continuation.untilMs, 5000)
			assert.strictEqual(sentDelays[0], 0)
			// …and it never counts against the stall cap (it made progress).
			assert.strictEqual(continuation.staleAttempts, 0)
		}).pipe(
			Effect.provide(
				orchestratorLayer(url, {
					sent,
					sentDelays,
					commits: [commit(SHA_A, 1)],
					commitFetchNext: { untilMs: 5000, retryAfterSeconds: 0, reason: "page-budget" },
				}),
			),
		)
	})

	// A backfill that keeps getting rate-limited *before any commit* must not
	// requeue forever — after the stall cap it errors the repo instead.
	it.effect("a backfill with no progress stops after the stall cap", () => {
		const STALL_CAP = 10 // mirrors MAX_BACKFILL_STALL_RETRIES in VcsSyncService
		const { url } = createTempDbUrl("maple-vcs-orch-stall-", dirs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo)
			// Drive the continuation back through the consumer; every run fetches zero
			// commits (still throttled), so the watermark never moves.
			let job: VcsSyncJob = backfillJob
			for (let i = 0; i <= STALL_CAP; i++) {
				yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(job))
				if (sent.length > 0) job = sent[sent.length - 1]!
			}
			// It requeued exactly the cap's worth of continuations, then gave up.
			assert.strictEqual(sent.length, STALL_CAP)
			const stored = yield* reposOfInstallation(repo, "42", "all")
			assert.strictEqual(stored[0]!.syncStatus, "error")
		}).pipe(
			Effect.provide(
				orchestratorLayer(url, {
					sent,
					commits: [], // zero progress on every run
					commitFetchNext: { untilMs: 5000, retryAfterSeconds: 600, reason: "rate-limited" },
				}),
			),
		)
	})

	// A rate-limited installation-sync isn't resumable — it propagates so the
	// consumer redelivers the whole (small) job after the delay.
	it.effect("a rate-limited installation-sync propagates VcsRateLimitedError", () => {
		const { url } = createTempDbUrl("maple-vcs-orch-inst-rl-", dirs)
		const sent: Array<VcsSyncJob> = []
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
			const exit = yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(job)).pipe(Effect.exit)
			assert.ok(Exit.isFailure(exit))
			const error = findError(exit)
			assert.ok(error instanceof VcsRateLimitedError)
			assert.strictEqual((error as VcsRateLimitedError).retryAfterSeconds, 600)
		}).pipe(
			Effect.provide(
				orchestratorLayer(url, {
					sent,
					fetchReposError: new VcsRateLimitedError({ message: "rate limited", retryAfterSeconds: 600 }),
				}),
			),
		)
	})

	// A repositories_removed sync soft-deletes repos no longer visible upstream:
	// the row + its commits are kept (status → "removed", excluded from "active"),
	// so history survives and a later re-grant can reactivate it.
	it.effect("repositories_removed soft-deletes a vanished repo and keeps its commits", () => {
		const { url } = createTempDbUrl("maple-vcs-orch-soft-del-", dirs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo) // repo "7", active
			yield* upsertCommitsFor(repo, orgId, "7", [commit(SHA_A, 1)])

			// Upstream no longer lists repo "7" (fetchRepositories stubbed to []).
			const job: VcsSyncJob = {
				kind: "installation-sync",
				provider: "github",
				externalInstallationId: "42",
				reason: "repositories_removed",
			}
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(job))

			// Row kept but marked removed: excluded from "active", present in "all".
			const active = yield* reposOfInstallation(repo, "42", "active")
			assert.strictEqual(active.length, 0)
			const all = yield* reposOfInstallation(repo, "42", "all")
			assert.strictEqual(all.length, 1)
			assert.strictEqual(all[0]!.status, "removed")
			// Its commits are retained (soft delete, not a purge).
			assert.ok(Option.isSome(yield* repo.findCommitBySha(orgId, SHA_A as never)))
		}).pipe(Effect.provide(orchestratorLayer(url, { sent, repos: [] })))
	})

	// Re-granting access (the repo reappears in a later sync) reactivates the
	// soft-deleted row via upsertRepositories.
	it.effect("a re-added repo is reactivated (status back to active)", () => {
		const { url } = createTempDbUrl("maple-vcs-orch-reactivate-", dirs)
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
			yield* seedRepo(repo)
			yield* markRemovedFor(repo, orgId, "7") // provider had removed it

			const job: VcsSyncJob = {
				kind: "installation-sync",
				provider: "github",
				externalInstallationId: "42",
				reason: "repositories_added",
			}
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(job))

			const all = yield* reposOfInstallation(repo, "42", "all")
			assert.strictEqual(all.length, 1)
			assert.strictEqual(all[0]!.status, "active") // reactivated
		}).pipe(Effect.provide(orchestratorLayer(url, { sent, repos })))
	})

	// A push to a soft-removed repo is paused — the commit is not written, even
	// though the repo row still exists.
	it.effect("a push to a removed repo is skipped", () => {
		const { url } = createTempDbUrl("maple-vcs-orch-removed-push-", dirs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo)
			yield* markRemovedFor(repo, orgId, "7")

			const job: VcsSyncJob = {
				kind: "push",
				provider: "github",
				externalInstallationId: "42",
				externalRepoId: "7",
				branch: "main",
				commits: [commit(SHA_A, 1)],
			}
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(job)) // must not fail
			assert.ok(Option.isNone(yield* repo.findCommitBySha(orgId, SHA_A as never)))
		}).pipe(Effect.provide(orchestratorLayer(url, { sent })))
	})
})

// The SHA-shape regex lives only in the GitCommitSha brand; these assert that
// validation fires at both the webhook decode boundary and on persistence.
describe("git SHA validation (branded type)", () => {
	it("GitCommitSha accepts mixed-case input and normalizes it to lowercase", () => {
		const decode = Schema.decodeUnknownSync(GitCommitSha)
		// All-uppercase 40-hex is accepted and lowercased.
		assert.strictEqual(decode("A".repeat(40)), "a".repeat(40))
		// Mixed case round-trips to its lowercase form (so case never splits a row).
		const mixed = "AbCdEf0123456789aBcDeF0123456789AbCdEf01"
		assert.strictEqual(decode(mixed), mixed.toLowerCase())
		// Non-hex / wrong length are still rejected (after lowercasing).
		assert.throws(() => decode("Z".repeat(40)))
		assert.throws(() => decode("abc"))
	})

	it.effect("webhook decode rejects a malformed commit SHA with VcsWebhookParseError", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const body = JSON.stringify({
				ref: "refs/heads/main",
				repository: { id: 7, owner: { login: "octo" } },
				installation: { id: 42 },
				after: SHA, // valid head, so the parse failure is specifically the commit id
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
			// Seed an installation + repo so the commit attaches to a real repo entity
			// (the repo service decodes the SHA while building the row).
			yield* repo.upsertInstallation({
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
			const exit = yield* upsertCommitsFor(repo, orgId, "7", [
				{
					sha: "ABC", // not 40-char hex (case-insensitive, but still invalid)
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
			]).pipe(Effect.exit)
			assert.ok(Exit.isFailure(exit))
			assert.ok(findError(exit) instanceof VcsRepoDecodeError)
		}).pipe(Effect.provide(repoLayer(url)))
	})
})

// The centralized GitHub fetch detects 429s and decides: ride out short waits
// inline; surface long ones (backfill → partial `next`; repos → VcsRateLimitedError).
describe("GithubProvider rate-limit handling", () => {
	const REPO = { externalRepoId: "7", owner: "octo", name: "repo", defaultBranch: "main" }
	const installation = Schema.decodeUnknownSync(VcsInstallation)({
		id: randomUUID(),
		orgId: "org_test",
		provider: "github",
		externalInstallationId: "123456",
		accountLogin: "octo",
		accountType: "organization",
		externalAccountId: "1",
		accountAvatarUrl: null,
		repositorySelection: "all",
		status: "active",
		suspendedAt: null,
		installedByUserId: "user_1",
		createdAt: 0,
		updatedAt: 0,
	})

	it.effect("rides out a short rate limit inline, then completes", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const result = yield* provider.fetchCommits(installation, REPO, { sinceMs: 0 })
			assert.strictEqual(result.commits.length, 1)
			assert.strictEqual(result.next, undefined) // retried past the 429 → window complete
		}).pipe(
			// token mint → page 1 (429, retry-after 0 → inline retry) → page 1 (commits)
			Effect.provide(
				stubbedProviderLayer([tokenResponse, () => rateLimited(0), () => commitsResponse(["a".repeat(40)])]),
			),
		),
	)

	it.effect("surfaces a long rate limit mid-walk as a partial result with `next`", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const result = yield* provider.fetchCommits(installation, REPO, { sinceMs: 0 })
			assert.strictEqual(result.commits.length, 100) // page 1 kept, not thrown away
			assert.ok(result.next !== undefined)
			assert.strictEqual(result.next?.retryAfterSeconds, 600)
		}).pipe(
			// token → page 1 (full) → page 2 (429, retry-after 600 → defer)
			Effect.provide(
				stubbedProviderLayer([tokenResponse, () => commitsResponse(hexShas(100)), () => rateLimited(600)]),
			),
		),
	)

	it.effect("a long rate limit on fetchRepositories raises VcsRateLimitedError", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const exit = yield* provider.fetchRepositories(installation).pipe(Effect.exit)
			assert.ok(Exit.isFailure(exit))
			const error = findError(exit)
			assert.ok(error instanceof VcsRateLimitedError)
			assert.strictEqual((error as VcsRateLimitedError).retryAfterSeconds, 600)
		}).pipe(
			// token → repos page 1 (429, retry-after 600 → surfaced, not resumable)
			Effect.provide(stubbedProviderLayer([tokenResponse, () => rateLimited(600)])),
		),
	)

	it.effect("stops riding out a rate limit after the inline-retry cap and defers", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			// Every page replies with a 0s-wait 429; without a retry cap this would spin
			// forever. The cap surfaces it as a deferral instead, floored off 0.
			const result = yield* provider.fetchCommits(installation, REPO, { sinceMs: 0 })
			assert.strictEqual(result.commits.length, 0)
			assert.ok(result.next !== undefined)
			assert.strictEqual(result.next?.retryAfterSeconds, 60)
		}).pipe(
			// token → page 1 (429 retry-after 0, repeated past the inline cap)
			Effect.provide(stubbedProviderLayer([tokenResponse, () => rateLimited(0)])),
		),
	)

	// Not throttled — the walk voluntarily yields after the per-invocation page
	// budget so one consumer invocation can't approach the Queues 15-min limit.
	it.effect("yields a page-budget continuation when the per-invocation page cap is hit", () =>
		Effect.gen(function* () {
			// Mirrors COMMIT_PAGES_PER_INVOCATION in GithubAppClient: every page comes
			// back full (100), so the pager never sees a short page and stops only at
			// the budget, handing back a continuation instead of walking everything.
			const COMMIT_PAGES_PER_INVOCATION = 25
			const provider = yield* GithubProvider
			const result = yield* provider.fetchCommits(installation, REPO, { sinceMs: 0 })
			assert.strictEqual(result.commits.length, COMMIT_PAGES_PER_INVOCATION * 100)
			assert.ok(result.next !== undefined)
			assert.strictEqual(result.next?.reason, "page-budget")
			assert.strictEqual(result.next?.retryAfterSeconds, 0) // continue immediately, no wait
		}).pipe(
			// token → full page on every fetch (the last responder repeats for all
			// subsequent pages), so the only stop condition is the page budget.
			Effect.provide(stubbedProviderLayer([tokenResponse, () => commitsResponse(hexShas(100))])),
		),
	)
})
