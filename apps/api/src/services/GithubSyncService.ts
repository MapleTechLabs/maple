import { randomUUID } from "node:crypto"
import {
	type GithubCommitInsert,
	type GithubInstallationInsert,
	type GithubInstallationRow,
	type GithubRepositoryInsert,
} from "@maple/db"
import {
	GithubPersistenceError,
	GithubUpstreamError,
	GithubValidationError,
	type OrgId,
} from "@maple/domain/http"
import { Clock, Context, Effect, Exit, Layer } from "effect"
import { GithubAppJwtService } from "./GithubAppJwtService"
import { GithubCommitRepo } from "./GithubCommitRepo"
import { GithubInstallationClient, type GithubCommit } from "./GithubInstallationClient"
import { GithubInstallationRepo } from "./GithubInstallationRepo"
import { GithubRepositoryRepo } from "./GithubRepositoryRepo"

const RESOLVE_MAX_ATTEMPTS = 3
const SHA_REGEX = /^[0-9a-f]{7,40}$/i

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
		{
			readonly repositoryCount: number
			// The local installation row reconcile resolved/upserted. `null` when
			// metadata fetch failed (likely suspended/revoked) so callers can skip
			// downstream work that needs an active installation.
			readonly installation: GithubInstallationRow | null
		},
		GithubPersistenceError | GithubUpstreamError | GithubValidationError
	>
}

export class GithubSyncService extends Context.Service<GithubSyncService, GithubSyncServiceShape>()(
	"GithubSyncService",
	{
		make: Effect.gen(function* () {
			const client = yield* GithubInstallationClient
			const installationRepo = yield* GithubInstallationRepo
			const repositoryRepo = yield* GithubRepositoryRepo
			const commitRepo = yield* GithubCommitRepo

			// Upserts a batch of commits and clears any tombstones for the SHAs
			// we just wrote. Pass `branches` to record which branch the commits
			// appear on (push webhook); omit for paths that don't know.
			const insertCommits = Effect.fn("GithubSyncService.insertCommits")(function* (
				orgId: OrgId,
				repoId: string,
				commits: ReadonlyArray<GithubCommit>,
				branches: ReadonlyArray<string> = [],
			) {
				if (commits.length === 0) return 0
				const syncedAt = yield* Clock.currentTimeMillis
				const refreshBranches = branches.length > 0
				yield* Effect.forEach(commits, (commit) => {
					const insert = mapCommitToInsert(orgId, repoId, commit, branches, syncedAt)
					return commitRepo.upsertCommit(insert, { refreshBranches })
				})
				yield* commitRepo.deleteUnresolvedShasByOrgAndShas(
					orgId,
					commits.map((c) => c.sha),
				)
				return commits.length
			})

			const upsertTombstone = Effect.fn("GithubSyncService.upsertTombstone")(function* (
				orgId: OrgId,
				sha: string,
				permanent: boolean,
				attempt = 1,
			) {
				const now = yield* Clock.currentTimeMillis
				yield* commitRepo.upsertUnresolvedSha({
					id: randomUUID(),
					orgId,
					sha,
					permanent,
					attempt,
					now,
				})
			})

			const runBackfill = Effect.fn("GithubSyncService.runBackfill")(function* (params: {
				readonly orgId: string
				readonly repoId: string
				readonly sinceUnixMs: number
				readonly cursor: string | null
			}) {
				const orgId = params.orgId as OrgId
				const repo = yield* repositoryRepo.findByOrgAndDbId(orgId, params.repoId)
				if (!repo) {
					return { orgId: params.orgId, repoId: params.repoId, cursor: null, done: true }
				}
				const installation = yield* installationRepo.findByOrgAndDbId(orgId, repo.installationId)
				if (!installation) {
					return { orgId: params.orgId, repoId: params.repoId, cursor: null, done: true }
				}
				if (installation.suspendedAt) {
					return { orgId: params.orgId, repoId: params.repoId, cursor: null, done: true }
				}
				if (!params.cursor) {
					const updatedAt = yield* Clock.currentTimeMillis
					yield* repositoryRepo.updateById(repo.id, {
						backfillStatus: "running",
						backfillError: null,
						updatedAt,
					})
				}
				const since = new Date(params.sinceUnixMs).toISOString()
				const page = yield* client.listCommitsPaginated(installation.installationId, {
					owner: repo.owner,
					name: repo.name,
					sha: repo.defaultBranch,
					since,
					cursor: params.cursor,
				})
				yield* insertCommits(orgId, repo.id, page.commits)
				const done = page.nextCursor === null
				const now = yield* Clock.currentTimeMillis
				yield* repositoryRepo.updateById(repo.id, {
					lastSyncedAt: now,
					lastFullBackfillAt: done ? now : repo.lastFullBackfillAt,
					backfillStatus: done ? "complete" : "running",
					updatedAt: now,
				})
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
				const orgId = params.orgId as OrgId
				const repo = yield* repositoryRepo.findByOrgAndOwnerName(orgId, params.owner, params.name)
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
					orgId,
					repo.id,
					commits,
					branchName ? [branchName] : [],
				)
				const syncedAt = yield* Clock.currentTimeMillis
				yield* repositoryRepo.updateById(repo.id, {
					lastSyncedAt: syncedAt,
					updatedAt: syncedAt,
				})
				return { written }
			})

			const runResolveUnknownSha = Effect.fn("GithubSyncService.runResolveUnknownSha")(
				function* (params: { readonly orgId: string; readonly sha: string }) {
					if (!SHA_REGEX.test(params.sha)) {
						return { resolved: false }
					}
					const orgId = params.orgId as OrgId
					const tombstone = yield* commitRepo.findUnresolvedSha(orgId, params.sha)
					if (tombstone?.permanent) return { resolved: false }

					// Use GitHub's commit search API: one call per installation finds
					// the SHA across every accessible repo, regardless of how many.
					// (Beats iterating repos and calling getCommit per-repo.)
					const installations = yield* installationRepo.listByOrg(orgId)

					if (installations.length === 0) {
						yield* upsertTombstone(orgId, params.sha, false)
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
						const repo = yield* repositoryRepo.findByOrgAndGithubRepoId(
							orgId,
							hit.repository.id,
						)
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
						yield* insertCommits(orgId, repo.id, [synthetic])
						return { resolved: true }
					}

					const attempt = (tombstone?.attemptCount ?? 0) + 1
					yield* upsertTombstone(orgId, params.sha, attempt >= RESOLVE_MAX_ATTEMPTS, attempt)
					return { resolved: false }
				},
			)

			const runReconcile = Effect.fn("GithubSyncService.runReconcile")(function* (params: {
				readonly orgId: string
				readonly installationId: number
			}) {
				const orgId = params.orgId as OrgId
				const metadataExit = yield* Effect.exit(
					client.getInstallationMetadata(params.installationId),
				)

				if (Exit.isFailure(metadataExit)) {
					// Likely suspended or revoked
					const suspendedAt = yield* Clock.currentTimeMillis
					yield* installationRepo.updateSuspended(orgId, params.installationId, suspendedAt)
					return { repositoryCount: 0, installation: null }
				}

				const metadata = metadataExit.value
				const now = yield* Clock.currentTimeMillis

				let installation = yield* installationRepo.findByOrgAndInstallationId(
					orgId,
					params.installationId,
				)

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
					yield* installationRepo.updateById(installation.id, installationUpdate)
				} else {
					const insertRow: GithubInstallationInsert = {
						id: randomUUID(),
						orgId,
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
					yield* installationRepo.insert(insertRow)
					// Re-fetch through the repo so the row goes through the same
					// enum-decode pipeline as any other read — keeps the runtime
					// invariant ("all returned rows have validated enums") intact.
					installation = yield* installationRepo.findByOrgAndInstallationId(
						orgId,
						params.installationId,
					)
					if (!installation) {
						return yield* Effect.fail(
							new GithubPersistenceError({
								code: "InstallationMissingAfterInsert",
								message: `Failed to load installation ${params.installationId} after insert`,
							}),
						)
					}
				}

				if (installation.suspendedAt) {
					return { repositoryCount: 0, installation }
				}

				const repos = yield* client.listInstallationRepositories(params.installationId)
				const existing = yield* repositoryRepo.listByOrgAndInstallation(orgId, installation.id)
				const existingByGithubId = new Map(existing.map((r) => [r.githubRepoId, r]))
				const seen = new Set<number>()

				for (const repo of repos) {
					seen.add(repo.id)
					const prev = existingByGithubId.get(repo.id)
					if (prev) {
						yield* repositoryRepo.updateById(prev.id, {
							owner: repo.owner.login,
							name: repo.name,
							defaultBranch: repo.default_branch,
							private: repo.private,
							htmlUrl: repo.html_url,
							updatedAt: now,
						})
					} else {
						const repoInsert: GithubRepositoryInsert = {
							id: randomUUID(),
							orgId,
							installationId: installation.id,
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
						}
						yield* repositoryRepo.insert(repoInsert)
					}
				}
				// Mark removed repos as disabled — do NOT delete commit history
				const removed = existing.filter((r) => !seen.has(r.githubRepoId))
				for (const repo of removed) {
					yield* repositoryRepo.updateById(repo.id, {
						syncEnabled: false,
						updatedAt: now,
					})
				}
				return { repositoryCount: repos.length, installation }
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
	// `bareLayer` lets tests substitute the GithubInstallationClient dep. Repos
	// are still provided here (they have no test-relevant behavior), so tests
	// only need to wire the mock client + jwt service + a real Database.
	static readonly bareLayer = Layer.effect(this, this.make).pipe(
		Layer.provide(GithubInstallationRepo.layer),
		Layer.provide(GithubRepositoryRepo.layer),
		Layer.provide(GithubCommitRepo.layer),
	)
	static readonly layer = this.bareLayer.pipe(
		Layer.provide(GithubInstallationClient.layer),
		Layer.provide(GithubAppJwtService.layer),
	)
}

export type { OrgId }
