import { randomUUID } from "node:crypto"
import {
	githubCommits,
	githubInstallations,
	githubRepositories,
	githubUnresolvedShas,
	type GithubCommitInsert,
	type GithubInstallationInsert,
	type GithubInstallationRow,
	type GithubRepositoryInsert,
	type GithubRepositoryRow,
} from "@maple/db"
import {
	GithubPersistenceError,
	GithubUpstreamError,
	GithubValidationError,
	type OrgId,
} from "@maple/domain/http"
import { and, eq, inArray, sql } from "drizzle-orm"
import { Context, Effect, Exit, Layer } from "effect"
import { Database, type DatabaseClient } from "./DatabaseLive"
import { GithubAppJwtService } from "./GithubAppJwtService"
import { GithubInstallationClient, type GithubCommit } from "./GithubInstallationClient"

const RESOLVE_MAX_ATTEMPTS = 3
const SHA_REGEX = /^[0-9a-f]{7,40}$/i

const toPersistenceError = (error: unknown) =>
	new GithubPersistenceError({
		message: error instanceof Error ? error.message : "GitHub sync database error",
	})

const shortSha = (sha: string) => sha.slice(0, 7)

const mapCommitToInsert = (
	orgId: string,
	repoId: string,
	commit: GithubCommit,
	branches: ReadonlyArray<string>,
	syncedAt: number,
): GithubCommitInsert => {
	const author = commit.author
	const committer = commit.committer
	const authoredAtIso = commit.commit.author?.date
	const committedAtIso = commit.commit.committer?.date ?? commit.commit.author?.date
	const authoredAt = authoredAtIso ? Date.parse(authoredAtIso) : syncedAt
	const committedAt = committedAtIso ? Date.parse(committedAtIso) : authoredAt
	return {
		id: randomUUID(),
		orgId,
		repoId,
		sha: commit.sha,
		shortSha: shortSha(commit.sha),
		message: commit.commit.message,
		authorLogin: author?.login ?? null,
		authorName: commit.commit.author?.name ?? null,
		authorEmail: commit.commit.author?.email ?? null,
		authorAvatarUrl: author?.avatar_url ?? null,
		committerLogin: committer?.login ?? null,
		committerName: commit.commit.committer?.name ?? null,
		committerEmail: commit.commit.committer?.email ?? null,
		committerAvatarUrl: committer?.avatar_url ?? null,
		authoredAt: Number.isFinite(authoredAt) ? authoredAt : syncedAt,
		committedAt: Number.isFinite(committedAt) ? committedAt : syncedAt,
		htmlUrl: commit.html_url,
		branchesJson: JSON.stringify(branches),
		prNumber: null,
		syncedAt,
		createdAt: syncedAt,
	}
}

/**
 * Map the lighter-weight webhook payload commit shape into the same internal
 * shape returned by GitHub's REST API. We lose avatar URLs and numeric user
 * IDs vs `getCommit`; the chip falls back to author initials in that case,
 * which is fine because (a) the webhook fast path runs synchronously and
 * we don't want to block on extra API calls, and (b) the cron sweep + manual
 * backfill paths use the REST API and will fill in avatars eventually.
 */
const webhookCommitToGithubCommit = (c: WebhookPushCommit): GithubCommit => ({
	sha: c.sha,
	html_url: c.url,
	commit: {
		message: c.message,
		author: c.author
			? {
					name: c.author.name ?? undefined,
					email: c.author.email ?? undefined,
					date: c.timestamp ?? undefined,
				}
			: undefined,
		committer: c.committer
			? {
					name: c.committer.name ?? undefined,
					email: c.committer.email ?? undefined,
					date: c.timestamp ?? undefined,
				}
			: undefined,
	},
	author: c.author?.login
		? { login: c.author.login, id: 0, avatar_url: undefined, type: undefined }
		: null,
	committer: c.committer?.login
		? { login: c.committer.login, id: 0, avatar_url: undefined, type: undefined }
		: null,
})

export interface SyncBackfillProgress {
	readonly orgId: string
	readonly repoId: string
	readonly cursor: string | null
	readonly done: boolean
}

/**
 * Commit data carried inline in the GitHub `push` webhook payload. The
 * payload doesn't include avatar URLs or numeric user IDs but otherwise
 * has everything we persist — using it lets the inline webhook path
 * avoid every GitHub API call.
 */
export interface WebhookPushCommit {
	readonly sha: string
	readonly message: string
	readonly url: string
	readonly timestamp: string | null
	readonly author: { readonly name: string | null; readonly email: string | null; readonly login: string | null } | null
	readonly committer: { readonly name: string | null; readonly email: string | null; readonly login: string | null } | null
}

export interface GithubSyncServiceShape {
	readonly runBackfill: (params: {
		readonly orgId: string
		readonly repoId: string
		readonly sinceUnixMs: number
		readonly cursor: string | null
	}) => Effect.Effect<
		SyncBackfillProgress,
		GithubPersistenceError | GithubUpstreamError | GithubValidationError
	>
	readonly runWebhookPush: (params: {
		readonly orgId: string
		readonly installationId: number
		readonly owner: string
		readonly name: string
		readonly ref: string
		readonly before: string
		readonly after: string
		readonly forced: boolean
		/** Either the embedded webhook commits (inline path, no API call) or
		 * just the SHAs (queue consumer path — falls back to compareRefs). */
		readonly commits?: ReadonlyArray<WebhookPushCommit>
		readonly commitShas?: ReadonlyArray<string>
	}) => Effect.Effect<
		{ readonly written: number },
		GithubPersistenceError | GithubUpstreamError | GithubValidationError
	>
	readonly runResolveUnknownSha: (params: {
		readonly orgId: string
		readonly sha: string
	}) => Effect.Effect<
		{ readonly resolved: boolean },
		GithubPersistenceError | GithubUpstreamError | GithubValidationError
	>
	readonly runReconcile: (params: {
		readonly orgId: string
		readonly installationId: number
	}) => Effect.Effect<
		{ readonly repositoryCount: number },
		GithubPersistenceError | GithubUpstreamError | GithubValidationError
	>
}

export class GithubSyncService extends Context.Service<GithubSyncService, GithubSyncServiceShape>()(
	"GithubSyncService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const client = yield* GithubInstallationClient
			const jwtService = yield* GithubAppJwtService

			const dbExecute = <T>(fn: (db: DatabaseClient) => Promise<T>) =>
				database.execute(fn).pipe(Effect.mapError(toPersistenceError))

			const loadRepoForOrg = (orgId: string, repoId: string) =>
				dbExecute((db) =>
					db
						.select()
						.from(githubRepositories)
						.where(and(eq(githubRepositories.orgId, orgId), eq(githubRepositories.id, repoId)))
						.limit(1),
				).pipe(Effect.map((rows) => (rows[0] ?? null) as GithubRepositoryRow | null))

			const loadInstallation = (orgId: string, installationDbId: string) =>
				dbExecute((db) =>
					db
						.select()
						.from(githubInstallations)
						.where(
							and(
								eq(githubInstallations.orgId, orgId),
								eq(githubInstallations.id, installationDbId),
							),
						)
						.limit(1),
				).pipe(Effect.map((rows) => (rows[0] ?? null) as GithubInstallationRow | null))

			// Upserts a batch of commits and clears any tombstones for the SHAs
			// we just wrote. Pass `branches` to record which branch the commits
			// appear on (push webhook); omit for paths that don't know.
			const insertCommits = (
				orgId: string,
				repoId: string,
				commits: ReadonlyArray<GithubCommit>,
				branches: ReadonlyArray<string> = [],
			) =>
				Effect.gen(function* () {
					if (commits.length === 0) return 0
					const syncedAt = Date.now()
					for (const commit of commits) {
						const insert = mapCommitToInsert(orgId, repoId, commit, branches, syncedAt)
						const updateSet: Partial<GithubCommitInsert> = {
							message: insert.message,
							authorLogin: insert.authorLogin,
							authorName: insert.authorName,
							authorEmail: insert.authorEmail,
							authorAvatarUrl: insert.authorAvatarUrl,
							committerLogin: insert.committerLogin,
							committerName: insert.committerName,
							committerEmail: insert.committerEmail,
							committerAvatarUrl: insert.committerAvatarUrl,
							authoredAt: insert.authoredAt,
							committedAt: insert.committedAt,
							htmlUrl: insert.htmlUrl,
							syncedAt,
						}
						// Only refresh branchesJson when the caller knew which branch
						// these commits live on — otherwise preserve whatever's there.
						if (branches.length > 0) updateSet.branchesJson = insert.branchesJson
						yield* dbExecute((db) =>
							db.insert(githubCommits).values(insert).onConflictDoUpdate({
								target: [githubCommits.orgId, githubCommits.sha],
								set: updateSet,
							}),
						)
					}
					yield* dbExecute((db) =>
						db
							.delete(githubUnresolvedShas)
							.where(
								and(
									eq(githubUnresolvedShas.orgId, orgId),
									inArray(githubUnresolvedShas.sha, commits.map((c) => c.sha)),
								),
							),
					)
					return commits.length
				})

			const touchRepoSynced = (repoId: string, syncedAt: number) =>
				dbExecute((db) =>
					db
						.update(githubRepositories)
						.set({ lastSyncedAt: syncedAt, updatedAt: syncedAt })
						.where(eq(githubRepositories.id, repoId)),
				)

			const runBackfill = Effect.fn("GithubSyncService.runBackfill")(function* (params: {
				readonly orgId: string
				readonly repoId: string
				readonly sinceUnixMs: number
				readonly cursor: string | null
			}) {
				const repo = yield* loadRepoForOrg(params.orgId, params.repoId)
				if (!repo) {
					return { orgId: params.orgId, repoId: params.repoId, cursor: null, done: true }
				}
				const installation = yield* loadInstallation(params.orgId, repo.installationId)
				if (!installation) {
					return { orgId: params.orgId, repoId: params.repoId, cursor: null, done: true }
				}
				if (installation.suspendedAt) {
					return { orgId: params.orgId, repoId: params.repoId, cursor: null, done: true }
				}
				if (!params.cursor) {
					yield* dbExecute((db) =>
						db
							.update(githubRepositories)
							.set({ backfillStatus: "running", backfillError: null, updatedAt: Date.now() })
							.where(eq(githubRepositories.id, repo.id)),
					)
				}
				const since = new Date(params.sinceUnixMs).toISOString()
				const page = yield* client.listCommitsPaginated(installation.installationId, {
					owner: repo.owner,
					name: repo.name,
					sha: repo.defaultBranch,
					since,
					cursor: params.cursor,
				})
				yield* insertCommits(params.orgId, repo.id, page.commits)
				const done = page.nextCursor === null
				const now = Date.now()
				yield* dbExecute((db) =>
					db
						.update(githubRepositories)
						.set({
							lastSyncedAt: now,
							lastFullBackfillAt: done ? now : repo.lastFullBackfillAt,
							backfillStatus: done ? "complete" : "running",
							updatedAt: now,
						})
						.where(eq(githubRepositories.id, repo.id)),
				)
				return {
					orgId: params.orgId,
					repoId: params.repoId,
					cursor: page.nextCursor,
					done,
				} satisfies SyncBackfillProgress
			})

			const runWebhookPush = Effect.fn("GithubSyncService.runWebhookPush")(function* (params: {
				readonly orgId: string
				readonly installationId: number
				readonly owner: string
				readonly name: string
				readonly ref: string
				readonly before: string
				readonly after: string
				readonly forced: boolean
				readonly commits?: ReadonlyArray<WebhookPushCommit>
				readonly commitShas?: ReadonlyArray<string>
			}) {
				const rows = yield* dbExecute((db) =>
					db
						.select()
						.from(githubRepositories)
						.where(
							and(
								eq(githubRepositories.orgId, params.orgId),
								eq(githubRepositories.owner, params.owner),
								eq(githubRepositories.name, params.name),
							),
						)
						.limit(1),
				)
				const repo = (rows[0] ?? null) as GithubRepositoryRow | null
				if (!repo || !repo.syncEnabled) return { written: 0 }

				const branchName = params.ref.replace(/^refs\/heads\//, "")

				// 1. Inline path: the webhook handler passed the embedded commit
				//    objects from the push payload. No API calls needed.
				// 2. Queue / fallback path: only SHAs are known, OR the push was
				//    forced / had an empty commits array. compareRefs returns up to
				//    250 commits with full data in one call.
				let commits: ReadonlyArray<GithubCommit>
				if (params.commits && params.commits.length > 0) {
					commits = params.commits.map(webhookCommitToGithubCommit)
				} else {
					commits = yield* client.compareRefs(
						params.installationId,
						params.owner,
						params.name,
						params.before,
						params.after,
					)
				}
				const written = yield* insertCommits(
					params.orgId,
					repo.id,
					commits,
					branchName ? [branchName] : [],
				)
				yield* touchRepoSynced(repo.id, Date.now())
				return { written }
			})

			const runResolveUnknownSha = Effect.fn("GithubSyncService.runResolveUnknownSha")(
				function* (params: { readonly orgId: string; readonly sha: string }) {
					if (!SHA_REGEX.test(params.sha)) {
						return { resolved: false }
					}
					const tombstoneRows = yield* dbExecute((db) =>
						db
							.select()
							.from(githubUnresolvedShas)
							.where(
								and(
									eq(githubUnresolvedShas.orgId, params.orgId),
									eq(githubUnresolvedShas.sha, params.sha),
								),
							)
							.limit(1),
					)
					const tombstone = tombstoneRows[0] ?? null
					if (tombstone?.permanent) return { resolved: false }

					// Use GitHub's commit search API: one call per installation finds
					// the SHA across every accessible repo, regardless of how many.
					// (Beats iterating repos and calling getCommit per-repo.)
					const installations = (yield* dbExecute((db) =>
						db
							.select()
							.from(githubInstallations)
							.where(eq(githubInstallations.orgId, params.orgId)),
					)) as ReadonlyArray<GithubInstallationRow>

					if (installations.length === 0) {
						yield* upsertTombstone(params.orgId, params.sha, false)
						return { resolved: false }
					}

					for (const installation of installations) {
						if (installation.suspendedAt) continue
						const hit = yield* client.searchCommitBySha(
							installation.installationId,
							params.sha,
						)
						if (!hit) continue
						// Map the search result to a connected repo row in our DB. If
						// the user has sync disabled for the repo, treat as unresolved.
						const repoRows = (yield* dbExecute((db) =>
							db
								.select()
								.from(githubRepositories)
								.where(
									and(
										eq(githubRepositories.orgId, params.orgId),
										eq(githubRepositories.githubRepoId, hit.repository.id),
									),
								)
								.limit(1),
						)) as ReadonlyArray<GithubRepositoryRow>
						const repo = repoRows[0]
						if (!repo || !repo.syncEnabled) continue
						// Search response includes everything getCommit would return,
						// so we can upsert directly without a follow-up call.
						const synthetic: GithubCommit = {
							sha: hit.sha,
							html_url: hit.html_url,
							commit: hit.commit,
							author: hit.author,
							committer: hit.committer,
						}
						yield* insertCommits(params.orgId, repo.id, [synthetic])
						return { resolved: true }
					}

					const attempt = (tombstone?.attemptCount ?? 0) + 1
					yield* upsertTombstone(params.orgId, params.sha, attempt >= RESOLVE_MAX_ATTEMPTS, attempt)
					return { resolved: false }
				},
			)

			const upsertTombstone = (
				orgId: string,
				sha: string,
				permanent: boolean,
				attempt = 1,
			) =>
				Effect.gen(function* () {
					const now = Date.now()
					yield* dbExecute((db) =>
						db
							.insert(githubUnresolvedShas)
							.values({
								id: randomUUID(),
								orgId,
								sha,
								attemptCount: attempt,
								lastAttemptAt: now,
								permanent,
								createdAt: now,
								updatedAt: now,
							})
							.onConflictDoUpdate({
								target: [githubUnresolvedShas.orgId, githubUnresolvedShas.sha],
								set: {
									attemptCount: sql`${githubUnresolvedShas.attemptCount} + 1`,
									lastAttemptAt: now,
									permanent,
									updatedAt: now,
								},
							}),
					)
				})

			const runReconcile = Effect.fn("GithubSyncService.runReconcile")(function* (params: {
				readonly orgId: string
				readonly installationId: number
			}) {
				yield* jwtService.invalidateInstallationToken(params.installationId)
				const metadataExit = yield* Effect.exit(
					client.getInstallationMetadata(params.installationId),
				)

				if (Exit.isFailure(metadataExit)) {
					// Likely suspended or revoked
					yield* dbExecute((db) =>
						db
							.update(githubInstallations)
							.set({ suspendedAt: Date.now(), updatedAt: Date.now() })
							.where(
								and(
									eq(githubInstallations.orgId, params.orgId),
									eq(githubInstallations.installationId, params.installationId),
								),
							),
					)
					return { repositoryCount: 0 }
				}

				const metadata = metadataExit.value
				const now = Date.now()

				const installationRows = yield* dbExecute((db) =>
					db
						.select()
						.from(githubInstallations)
						.where(
							and(
								eq(githubInstallations.orgId, params.orgId),
								eq(githubInstallations.installationId, params.installationId),
							),
						)
						.limit(1),
				)
				let installation = (installationRows[0] ?? null) as GithubInstallationRow | null

				const installationUpdate: Partial<GithubInstallationInsert> = {
					appSlug: metadata.app_slug,
					accountId: metadata.account.id,
					accountLogin: metadata.account.login,
					accountAvatarUrl: metadata.account.avatar_url ?? null,
					accountType: metadata.account.type,
					targetType: metadata.target_type,
					repositorySelection: metadata.repository_selection,
					permissionsJson: JSON.stringify(metadata.permissions ?? {}),
					eventsJson: JSON.stringify(metadata.events ?? []),
					suspendedAt: metadata.suspended_at ? Date.parse(metadata.suspended_at) : null,
					updatedAt: now,
				}

				if (installation) {
					yield* dbExecute((db) =>
						db
							.update(githubInstallations)
							.set(installationUpdate)
							.where(eq(githubInstallations.id, installation!.id)),
					)
				} else {
					const id = randomUUID()
					yield* dbExecute((db) =>
						db.insert(githubInstallations).values({
							id,
							orgId: params.orgId,
							installationId: params.installationId,
							appSlug: metadata.app_slug,
							accountId: metadata.account.id,
							accountLogin: metadata.account.login,
							accountAvatarUrl: metadata.account.avatar_url ?? null,
							accountType: metadata.account.type,
							targetType: metadata.target_type,
							repositorySelection: metadata.repository_selection,
							permissionsJson: JSON.stringify(metadata.permissions ?? {}),
							eventsJson: JSON.stringify(metadata.events ?? []),
							suspendedAt: metadata.suspended_at ? Date.parse(metadata.suspended_at) : null,
							installedByUserId: "system",
							createdAt: now,
							updatedAt: now,
						} satisfies GithubInstallationInsert),
					)
					installation = {
						id,
						orgId: params.orgId,
						installationId: params.installationId,
						appSlug: metadata.app_slug,
						accountId: metadata.account.id,
						accountLogin: metadata.account.login,
						accountAvatarUrl: metadata.account.avatar_url ?? null,
						accountType: metadata.account.type,
						targetType: metadata.target_type,
						repositorySelection: metadata.repository_selection,
						permissionsJson: JSON.stringify(metadata.permissions ?? {}),
						eventsJson: JSON.stringify(metadata.events ?? []),
						suspendedAt: metadata.suspended_at ? Date.parse(metadata.suspended_at) : null,
						installedByUserId: "system",
						createdAt: now,
						updatedAt: now,
					}
				}

				if (installation.suspendedAt) {
					return { repositoryCount: 0 }
				}

				const repos = yield* client.listInstallationRepositories(params.installationId)
				const existing = (yield* dbExecute((db) =>
					db
						.select()
						.from(githubRepositories)
						.where(
							and(
								eq(githubRepositories.orgId, params.orgId),
								eq(githubRepositories.installationId, installation!.id),
							),
						),
				)) as ReadonlyArray<GithubRepositoryRow>
				const existingByGithubId = new Map(existing.map((r) => [r.githubRepoId, r]))
				const seen = new Set<number>()

				for (const repo of repos) {
					seen.add(repo.id)
					const prev = existingByGithubId.get(repo.id)
					if (prev) {
						yield* dbExecute((db) =>
							db
								.update(githubRepositories)
								.set({
									owner: repo.owner.login,
									name: repo.name,
									defaultBranch: repo.default_branch,
									private: repo.private,
									htmlUrl: repo.html_url,
									updatedAt: now,
								})
								.where(eq(githubRepositories.id, prev.id)),
						)
					} else {
						yield* dbExecute((db) =>
							db.insert(githubRepositories).values({
								id: randomUUID(),
								orgId: params.orgId,
								installationId: installation!.id,
								githubRepoId: repo.id,
								owner: repo.owner.login,
								name: repo.name,
								defaultBranch: repo.default_branch,
								private: repo.private,
								htmlUrl: repo.html_url,
								syncEnabled: true,
								backfillStatus: "pending",
								createdAt: now,
								updatedAt: now,
							} satisfies GithubRepositoryInsert),
						)
					}
				}
				// Mark removed repos as disabled — do NOT delete commit history
				const removed = existing.filter((r) => !seen.has(r.githubRepoId))
				for (const repo of removed) {
					yield* dbExecute((db) =>
						db
							.update(githubRepositories)
							.set({ syncEnabled: false, updatedAt: now })
							.where(eq(githubRepositories.id, repo.id)),
					)
				}
				return { repositoryCount: repos.length }
			})

			return {
				runBackfill,
				runWebhookPush,
				runResolveUnknownSha,
				runReconcile,
			} satisfies GithubSyncServiceShape
		}),
	},
) {
	// `bareLayer` lets tests substitute the GithubInstallationClient dep. The
	// production `layer` bundles the real client so app.ts only has to merge
	// it once.
	static readonly bareLayer = Layer.effect(this, this.make)
	static readonly layer = this.bareLayer.pipe(
		Layer.provide(GithubInstallationClient.layer),
		Layer.provide(GithubAppJwtService.layer),
	)
	static readonly Default = this.layer
}

export type { OrgId }
