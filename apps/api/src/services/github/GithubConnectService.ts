import { randomBytes } from "node:crypto"
import {
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	type OrgId,
	type UserId,
	type VcsAccountType,
	type VcsRepoSelection,
	type VcsRepositoryId,
	type VcsRepoStatus,
	type VcsRepoSyncStatus,
} from "@maple/domain/http"
import { Clock, Context, Effect, Layer, Option } from "effect"
import { Env } from "../../lib/Env"
import { OAuthStateRepository } from "../OAuthStateRepository"
import { VcsRepository } from "../vcs/VcsRepository"
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

export interface GithubRepoStatus {
	readonly id: VcsRepositoryId
	readonly fullName: string
	readonly htmlUrl: string
	readonly isPrivate: boolean
	readonly status: VcsRepoStatus
	readonly syncStatus: VcsRepoSyncStatus
	readonly lastSyncedAt: number | null
	readonly lastSyncError: string | null
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
					return yield* new IntegrationsValidationError({
						message: "Connect session not recognized — restart the connect flow",
					})
				}
				const stateRow = stateRowOpt.value
				// Single-use: consume immediately, before any upstream call.
				yield* asPersistence(states.deleteByState(state))
				if (stateRow.provider !== GITHUB_PROVIDER) {
					return yield* new IntegrationsValidationError({
						message: "Connect session provider mismatch — restart the connect flow",
					})
				}
				if (stateRow.expiresAt < now) {
					return yield* new IntegrationsValidationError({
						message: "Connect session expired — restart the connect flow",
					})
				}

				const detail = yield* githubApp
					.getInstallation(installationId)
					.pipe(Effect.mapError(fromGithubError))
				if (!detail.account) {
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

				return { orgId: stateRow.orgId as OrgId, returnTo: stateRow.returnTo ?? null }
			})

			const getStatus = Effect.fn("GithubConnectService.getStatus")(function* (orgId: OrgId) {
				const installations = yield* asPersistence(repo.listInstallationsByOrg(orgId))
				const active = installations.find(
					(i) => i.provider === GITHUB_PROVIDER && i.status === "active",
				)
				if (!active) {
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
				const repos = yield* asPersistence(
					repo.listRepositoriesByInstallation(GITHUB_PROVIDER, active.externalInstallationId, "all"),
				)
				return {
					connected: true,
					accountLogin: active.accountLogin,
					accountType: active.accountType,
					repositorySelection: active.repositorySelection,
					repositories: repos.map((r) => ({
						id: r.id,
						fullName: r.fullName,
						htmlUrl: r.htmlUrl,
						isPrivate: r.isPrivate,
						status: r.status,
						syncStatus: r.syncStatus,
						lastSyncedAt: r.lastSyncedAt,
						lastSyncError: r.lastSyncError,
					})),
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
					(i) => asPersistence(repo.purgeInstallation(orgId, GITHUB_PROVIDER, i.externalInstallationId)),
					{ discard: true },
				)
				return { disconnected: targets.length > 0 }
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
				if (Option.isNone(existing)) return { deleted: false }
				if (existing.value.status !== "removed") {
					return yield* new IntegrationsValidationError({
						message:
							"This repository is still active. Remove its access in GitHub first — only repositories whose access was removed can be deleted from Maple.",
					})
				}
				const deleted = yield* asPersistence(repo.purgeRepository(orgId, repositoryId))
				return { deleted }
			})

			return {
				startConnect,
				completeConnect,
				getStatus,
				disconnect,
				deleteRepository,
			} satisfies GithubConnectServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
