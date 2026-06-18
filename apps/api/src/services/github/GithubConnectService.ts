import { randomBytes } from "node:crypto"
import {
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	isInstallationProcessable,
	type OrgId,
	type UserId,
	type VcsAccountType,
	type VcsRepoSelection,
	type VcsRepositoryId,
	type VcsRepoStatus,
	type VcsRepoSyncStatus,
	type VcsSyncJob,
} from "@maple/domain/http"
import { Clock, Context, Effect, Layer, Option } from "effect"
import { Env } from "../../lib/Env"
import { OAuthStateRepository } from "../OAuthStateRepository"
import { VcsRepository } from "../vcs/VcsRepository"
import { BACKFILL_WINDOW_MS } from "../vcs/VcsSyncService"
import { VcsSyncQueue } from "../vcs/VcsSyncQueue"
import { GithubAppClient, type GithubAppError } from "./GithubAppClient"

// ---------------------------------------------------------------------------
// The dashboard connect flow for the GitHub App. Bridges a real GitHub
// installation into a `vcs_installations` row owned by a Maple org, then hands
// off to the existing sync engine (enqueues an InstallationSyncJob).
//
// Flow: the dashboard opens the GitHub App install URL (carrying our `state`).
// After install GitHub redirects to the callback with `installation_id` and the
// `state` echoed back in the query; the callback validates `state` (→ org) and
// finishes here. No OAuth `code` exchange is needed — account metadata comes from
// the App JWT (`GET /app/installations/{id}`); sync later mints its own
// installation tokens.
// ---------------------------------------------------------------------------

const GITHUB_PROVIDER = "github" as const
const GITHUB_WEB_BASE = "https://github.com"
const STATE_TTL_MS = 10 * 60_000 // 10 minutes

// ---- Service shape --------------------------------------------------------

export interface GithubBranchStatus {
	readonly name: string
	readonly isDefault: boolean
}

export interface GithubRepoStatus {
	readonly id: VcsRepositoryId
	readonly fullName: string
	readonly htmlUrl: string
	readonly isPrivate: boolean
	readonly status: VcsRepoStatus
	readonly syncStatus: VcsRepoSyncStatus
	readonly lastSyncedAt: number | null
	readonly lastSyncError: string | null
	/** The single branch this repo tracks (falls back to its default branch). */
	readonly trackedBranch: string | null
	/** All branch names the user can choose to track, for the picker. */
	readonly branches: ReadonlyArray<GithubBranchStatus>
}

export interface GithubConnectStatus {
	readonly connected: boolean
	readonly accountLogin: string | null
	readonly accountType: VcsAccountType | null
	readonly repositorySelection: VcsRepoSelection | null
	readonly repositories: ReadonlyArray<GithubRepoStatus>
}

export interface GithubConnectServiceShape {
	/** Create a single-use state row and the GitHub install URL to open. */
	readonly startConnect: (
		orgId: OrgId,
		userId: UserId,
		options: { readonly callbackUrl: string; readonly returnTo?: string },
	) => Effect.Effect<
		{ readonly redirectUrl: string; readonly state: string },
		IntegrationsValidationError | IntegrationsPersistenceError
	>
	readonly completeConnect: (
		installationId: string,
		state: string,
	) => Effect.Effect<
		{ readonly orgId: OrgId; readonly returnTo: string | null },
		IntegrationsValidationError | IntegrationsUpstreamError | IntegrationsPersistenceError
	>
	readonly getStatus: (orgId: OrgId) => Effect.Effect<GithubConnectStatus, IntegrationsPersistenceError>
	readonly disconnect: (
		orgId: OrgId,
	) => Effect.Effect<{ readonly disconnected: boolean }, IntegrationsPersistenceError>
	/**
	 * Hard-delete a single repository and all of its synced commits from Maple,
	 * addressed by Maple's own repository id (the dashboard's handle). User-initiated
	 * (the "delete from Maple" action) — distinct from a provider-side removal, which
	 * only soft-deletes. Scoped to the org, so it cannot touch another tenant's data.
	 */
	readonly deleteRepository: (
		orgId: OrgId,
		repositoryId: VcsRepositoryId,
	) => Effect.Effect<
		{ readonly deleted: boolean },
		IntegrationsPersistenceError | IntegrationsValidationError
	>
	/**
	 * Set the single branch a repo tracks. Changing it is destructive by design:
	 * the repo's stored commits (the old branch's history) are wiped and a fresh
	 * 90-day backfill of the new branch is enqueued, so the stored set always
	 * reflects exactly the current tracked branch. A no-op (same branch) neither
	 * wipes nor resyncs.
	 */
	readonly setTrackedBranch: (
		orgId: OrgId,
		repositoryId: VcsRepositoryId,
		trackedBranch: string,
	) => Effect.Effect<
		{ readonly trackedBranch: string; readonly backfillQueued: boolean },
		IntegrationsPersistenceError | IntegrationsValidationError
	>
}

// Repo / queue / state errors all carry a `message`; collapse them to the
// integration persistence error the HTTP layer speaks.
const asPersistence = <A, E extends { readonly message: string }>(
	eff: Effect.Effect<A, E>,
): Effect.Effect<A, IntegrationsPersistenceError> =>
	eff.pipe(Effect.mapError((error) => new IntegrationsPersistenceError({ message: error.message })))

// A gone/missing installation is a user-actionable validation error; anything
// else from GitHub is an upstream failure.
const fromGithubError = (error: GithubAppError) =>
	error.status === 404 || error.status === 410
		? new IntegrationsValidationError({
				message: "GitHub installation not found — it may have been removed. Restart the connect flow.",
			})
		: new IntegrationsUpstreamError({
				message: error.message,
				...(error.status === undefined ? {} : { status: error.status }),
			})

export class GithubConnectService extends Context.Service<GithubConnectService, GithubConnectServiceShape>()(
	"@maple/api/services/github/GithubConnectService",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const states = yield* OAuthStateRepository
			const repo = yield* VcsRepository
			const queue = yield* VcsSyncQueue
			const githubApp = yield* GithubAppClient

			const startConnect = Effect.fn("GithubConnectService.startConnect")(function* (
				orgId: OrgId,
				userId: UserId,
				options: { readonly callbackUrl: string; readonly returnTo?: string },
			) {
				const slug = Option.getOrUndefined(env.GITHUB_APP_SLUG)
				if (!slug) {
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.connect.outcome": "app_not_configured",
						"vcs.connect.reason": "GITHUB_APP_SLUG missing",
					})
					return yield* new IntegrationsValidationError({
						message: "GitHub App is not configured (set GITHUB_APP_SLUG)",
					})
				}
				const now = yield* Clock.currentTimeMillis
				const state = randomBytes(24).toString("base64url")
				yield* asPersistence(states.purgeExpired(now))
				yield* asPersistence(
					states.insert({
						state,
						orgId,
						provider: GITHUB_PROVIDER,
						initiatedByUserId: userId,
						redirectUri: options.callbackUrl,
						returnTo: options.returnTo ?? null,
						createdAt: now,
						expiresAt: now + STATE_TTL_MS,
					}),
				)
				yield* Effect.annotateCurrentSpan({
					orgId,
					"vcs.connect.outcome": "started",
				})
				// GitHub echoes `state` back to the post-install redirect; the callback
				// reads it from the query.
				const params = new URLSearchParams({ state })
				return {
					redirectUrl: `${GITHUB_WEB_BASE}/apps/${slug}/installations/new?${params.toString()}`,
					state,
				}
			})

			const completeConnect = Effect.fn("GithubConnectService.completeConnect")(function* (
				installationId: string,
				state: string,
			) {
				const now = yield* Clock.currentTimeMillis
				const stateRowOpt = yield* asPersistence(states.findByState(state))
				if (Option.isNone(stateRowOpt)) {
					yield* Effect.annotateCurrentSpan({
						"vcs.connect.outcome": "state_not_found",
						"vcs.connect.reason": "no state row for supplied secret",
					})
					return yield* new IntegrationsValidationError({
						message: "Connect session not recognized — restart the connect flow",
					})
				}
				const stateRow = stateRowOpt.value
				// Single-use: consume immediately, before any upstream call.
				yield* asPersistence(states.deleteByState(state))
				if (stateRow.provider !== GITHUB_PROVIDER) {
					yield* Effect.annotateCurrentSpan({
						orgId: stateRow.orgId,
						"vcs.connect.outcome": "provider_mismatch",
						"vcs.connect.reason": `state provider "${stateRow.provider}" != "${GITHUB_PROVIDER}"`,
					})
					return yield* new IntegrationsValidationError({
						message: "Connect session provider mismatch — restart the connect flow",
					})
				}
				if (stateRow.expiresAt < now) {
					yield* Effect.annotateCurrentSpan({
						orgId: stateRow.orgId,
						"vcs.connect.outcome": "state_expired",
						"vcs.connect.reason": "state TTL elapsed before callback",
					})
					return yield* new IntegrationsValidationError({
						message: "Connect session expired — restart the connect flow",
					})
				}

				const detail = yield* githubApp.getInstallation(installationId).pipe(
					Effect.tapError((error) =>
						Effect.annotateCurrentSpan({
							orgId: stateRow.orgId,
							"vcs.connect.outcome": "upstream_github_error",
							"vcs.connect.reason":
								error.status === 404 || error.status === 410
									? "installation gone/missing"
									: "github upstream failure",
							...(error.status === undefined
								? {}
								: { "vcs.github.status": error.status }),
						}),
					),
					Effect.mapError(fromGithubError),
				)
				if (!detail.account) {
					yield* Effect.annotateCurrentSpan({
						orgId: stateRow.orgId,
						"vcs.connect.outcome": "upstream_github_error",
						"vcs.connect.reason": "installation has no account",
					})
					return yield* new IntegrationsValidationError({
						message: "GitHub installation has no account — restart the connect flow",
					})
				}
				const account = detail.account
				const accountType: VcsAccountType =
					account.type === "Organization" ? "organization" : "user"
				const repositorySelection: VcsRepoSelection =
					detail.repository_selection === "selected" ? "selected" : "all"

				yield* asPersistence(
					repo.upsertInstallation({
						orgId: stateRow.orgId as OrgId,
						provider: GITHUB_PROVIDER,
						externalInstallationId: installationId,
						accountLogin: account.login,
						accountType,
						externalAccountId: String(account.id),
						accountAvatarUrl: account.avatar_url ?? null,
						repositorySelection,
						installedByUserId: stateRow.initiatedByUserId as UserId,
					}),
				)

				yield* asPersistence(
					queue.send({
						kind: "installation-sync",
						provider: GITHUB_PROVIDER,
						externalInstallationId: installationId,
						reason: "created",
					}),
				)

				yield* Effect.annotateCurrentSpan({
					orgId: stateRow.orgId,
					"vcs.connect.outcome": "connected",
					"vcs.account.type": accountType,
					"vcs.repository.selection": repositorySelection,
				})
				return { orgId: stateRow.orgId as OrgId, returnTo: stateRow.returnTo ?? null }
			})

			const getStatus = Effect.fn("GithubConnectService.getStatus")(function* (orgId: OrgId) {
				const installations = yield* asPersistence(repo.listInstallationsByOrg(orgId))
				const active = installations.find(
					(i) => i.provider === GITHUB_PROVIDER && i.status === "active",
				)
				if (!active) {
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.status.outcome": "ok",
						"vcs.status.connected": false,
					})
					return {
						connected: false,
						accountLogin: null,
						accountType: null,
						repositorySelection: null,
						repositories: [],
					} satisfies GithubConnectStatus
				}
				// "all": the dashboard surfaces provider-removed repos too, with the
				// "re-enable access / delete from Maple" affordances.
				const repos = yield* asPersistence(repo.listRepositoriesByInstallation(active.id, "all"))
				// One branch query per repo — fine at current scale (tens of repos).
				const repositories = yield* Effect.forEach(repos, (r) =>
					Effect.gen(function* () {
						const branches = yield* asPersistence(repo.listBranchesByRepository(r.id))
						return {
							id: r.id,
							fullName: r.fullName,
							htmlUrl: r.htmlUrl,
							isPrivate: r.isPrivate,
							status: r.status,
							syncStatus: r.syncStatus,
							lastSyncedAt: r.lastSyncedAt,
							lastSyncError: r.lastSyncError,
							// Fall back to the default for a legacy row whose tracked branch
							// was never set, mirroring the sync engine's resolution.
							trackedBranch: r.trackedBranch ?? r.defaultBranch,
							branches: branches.map((b) => ({
								name: b.name,
								isDefault: b.isDefault,
							})),
						}
					}),
				)
				yield* Effect.annotateCurrentSpan({
					orgId,
					"vcs.status.outcome": "ok",
					"vcs.status.connected": true,
					"vcs.account.type": active.accountType,
					"vcs.repository.selection": active.repositorySelection,
					"vcs.repository.count": repositories.length,
				})
				return {
					connected: true,
					accountLogin: active.accountLogin,
					accountType: active.accountType,
					repositorySelection: active.repositorySelection,
					repositories,
				} satisfies GithubConnectStatus
			})

			const disconnect = Effect.fn("GithubConnectService.disconnect")(function* (orgId: OrgId) {
				const installations = yield* asPersistence(repo.listInstallationsByOrg(orgId))
				const targets = installations.filter((i) => i.provider === GITHUB_PROVIDER)
				// Fully remove each installation and its repos/commits — a disconnect
				// must not strand the org's VCS data. Deleting the row (rather than only
				// flipping its status to "disconnected") also lets a later reconnect
				// re-sync cleanly: upsertInstallation never resets status on conflict, so
				// a lingering "disconnected" row would gate the reconnected installation
				// out of the sync engine.
				yield* Effect.forEach(
					targets,
					(i) => asPersistence(repo.purgeInstallation(orgId, i.id)),
					{ discard: true },
				)
				const disconnected = targets.length > 0
				yield* Effect.annotateCurrentSpan({
					orgId,
					"vcs.disconnect.outcome": disconnected ? "disconnected" : "nothing_to_disconnect",
					"vcs.disconnect.installation_count": targets.length,
				})
				return { disconnected }
			})

			const deleteRepository = Effect.fn("GithubConnectService.deleteRepository")(function* (
				orgId: OrgId,
				repositoryId: VcsRepositoryId,
			) {
				// Deletion is only for repos whose provider access was already removed
				// (the dashboard shows the button only on those). Enforce it server-side
				// too: purging an *active* repo is both wrong (active repos are managed
				// via GitHub access, not deleted) and futile — the next installation-sync
				// re-adds and re-backfills it. The lookup is org-scoped, so an id from
				// another tenant reads as absent and an absent repo is treated as
				// already-deleted (idempotent).
				const existing = yield* asPersistence(repo.getRepositoryById(orgId, repositoryId))
				if (Option.isNone(existing)) {
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.repository.id": repositoryId,
						"vcs.delete_repository.outcome": "not_found",
						"vcs.delete_repository.reason": "absent for org — treated as idempotent delete",
					})
					return { deleted: false }
				}
				if (existing.value.status !== "removed") {
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.repository.id": repositoryId,
						"vcs.delete_repository.outcome": "still_active_rejected",
						"vcs.delete_repository.reason": `repo status "${existing.value.status}" != "removed"`,
					})
					return yield* new IntegrationsValidationError({
						message:
							"This repository is still active. Remove its access in GitHub first — only repositories whose access was removed can be deleted from Maple.",
					})
				}
				const deleted = yield* asPersistence(repo.purgeRepository(orgId, repositoryId))
				yield* Effect.annotateCurrentSpan({
					orgId,
					"vcs.repository.id": repositoryId,
					"vcs.delete_repository.outcome": "deleted",
				})
				return { deleted }
			})

			const setTrackedBranch = Effect.fn("GithubConnectService.setTrackedBranch")(function* (
				orgId: OrgId,
				repositoryId: VcsRepositoryId,
				trackedBranch: string,
			) {
				const existing = yield* asPersistence(repo.getRepositoryById(orgId, repositoryId))
				if (Option.isNone(existing)) {
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.repository.id": repositoryId,
						"vcs.set_tracked_branch.outcome": "repository_not_found",
						"vcs.set_tracked_branch.reason": "absent for org",
					})
					return yield* new IntegrationsValidationError({ message: "Repository not found" })
				}
				const repository = existing.value

				const installationOpt = yield* asPersistence(
					repo.getInstallationById(orgId, repository.installationId),
				)
				if (Option.isSome(installationOpt) && !isInstallationProcessable(installationOpt.value)) {
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.repository.id": repositoryId,
						"vcs.set_tracked_branch.outcome": "installation_suspended",
						"vcs.set_tracked_branch.reason": "installation not processable (suspended)",
					})
					return yield* new IntegrationsValidationError({
						message:
							"This integration is suspended. Reactivate it on GitHub before changing the tracked branch.",
					})
				}

				// The chosen branch must be one the repo actually knows about (the picker's
				// list), so we don't point the tracker at a non-existent ref. The default
				// branch always qualifies (it's listed and is the seeded default).
				const branches = yield* asPersistence(repo.listBranchesByRepository(repositoryId))
				if (!branches.some((b) => b.name === trackedBranch)) {
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.repository.id": repositoryId,
						"vcs.set_tracked_branch.outcome": "unknown_branch",
						"vcs.set_tracked_branch.reason": "requested branch not in repository's known branches",
					})
					return yield* new IntegrationsValidationError({
						message: `Branch "${trackedBranch}" is not a known branch of this repository.`,
					})
				}

				const current = repository.trackedBranch ?? repository.defaultBranch
				// No-op when unchanged: don't wipe + resync for a redundant selection.
				if (trackedBranch === current) {
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.repository.id": repositoryId,
						"vcs.set_tracked_branch.outcome": "unchanged_noop",
						"vcs.set_tracked_branch.reason": "requested branch equals current tracked branch",
						"vcs.branches.tracked": trackedBranch,
						"vcs.branches.changed": false,
					})
					return { trackedBranch, backfillQueued: false }
				}

				// Change is destructive: point the tracker at the new branch AND wipe the
				// repo's stored (old-branch) commits, then backfill the new branch so the
				// stored set reflects exactly the current tracked branch.
				yield* asPersistence(repo.changeTrackedBranch(orgId, repositoryId, trackedBranch))

				let backfillQueued = false
				if (Option.isSome(installationOpt)) {
					const installation = installationOpt.value
					const sinceMs = (yield* Clock.currentTimeMillis) - BACKFILL_WINDOW_MS
					yield* asPersistence(
						queue.send({
							kind: "sync-commits",
							provider: GITHUB_PROVIDER,
							externalInstallationId: installation.externalInstallationId,
							externalRepoId: repository.externalRepoId,
							owner: repository.owner,
							name: repository.name,
							branch: trackedBranch,
							sinceMs,
						} satisfies VcsSyncJob),
					)
					backfillQueued = true
				} else {
					// The repo's installation row is missing — an invariant violation (a
					// cascade delete should remove repos with their installation). The tracked
					// branch is set and commits wiped, but without the external id we can't
					// enqueue a backfill; report the truth (nothing queued) rather than claim it.
					yield* Effect.logWarning(
						"[GitHub] Tracked branch changed but installation missing — backfill not enqueued",
					).pipe(
						Effect.annotateLogs({
							orgId,
							repositoryId,
							installationId: repository.installationId,
							trackedBranch,
						}),
					)
				}
				yield* Effect.annotateCurrentSpan({
					orgId,
					"vcs.repository.id": repositoryId,
					"vcs.set_tracked_branch.outcome": "changed",
					"vcs.set_tracked_branch.reason": backfillQueued
						? "branch changed; backfill enqueued"
						: "branch changed; installation missing — backfill not enqueued",
					"vcs.set_tracked_branch.installation_missing": !backfillQueued,
					"vcs.branches.tracked": trackedBranch,
					"vcs.branches.changed": true,
					"vcs.branches.backfill_queued": backfillQueued,
				})
				return { trackedBranch, backfillQueued }
			})

			return {
				startConnect,
				completeConnect,
				getStatus,
				disconnect,
				deleteRepository,
				setTrackedBranch,
			} satisfies GithubConnectServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
