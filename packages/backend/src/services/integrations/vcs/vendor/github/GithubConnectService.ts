import {
	type GithubConnectionState,
	GithubInstallationChoice,
	GithubInstallationSelection,
	type VcsRepositoryDiscovery,
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	isInstallationProcessable,
	type OrgId,
	PrReviewOrgSettings,
	PrReviewRepositoryConfig,
	type UserId,
	type VcsAccountType,
	type VcsInstallationId,
	type VcsRepoSelection,
	type VcsRepositoryId,
	type VcsRepoStatus,
	type VcsRepoSyncStatus,
	type VcsSyncJob,
} from "@maple/domain/http"
import { Clock, Context, Effect, Layer, Option } from "effect"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Base64Url from "effect/encoding/Base64Url"
import type { OAuthAuthStateRow } from "@maple/db/tables"
import { Env } from "@maple/backend/platform/Env"
import { OAuthStateRepository } from "@maple/backend/services/auth/OAuthStateRepository"
import type { OAuthFlowInitiator } from "@maple/backend/services/auth/oauth/oauth-state"
import { VcsRepository } from "@maple/backend/services/integrations/vcs/VcsRepository"
import { BACKFILL_WINDOW_MS } from "@maple/backend/services/integrations/vcs/VcsSyncService"
import { VcsSyncQueue } from "@maple/backend/services/integrations/vcs/VcsSyncQueue"
import { GithubAppClient, type GithubAppError } from "./GithubAppClient"
import { githubWebBaseUrl } from "./github-hosts"

// The dashboard connect flow for the GitHub App. Bridges a real GitHub
// installation into a `vcs_installations` row owned by a Maple org, then hands
// off to the existing sync engine (enqueues an InstallationSyncJob).
//
// Flow: the dashboard opens GitHub user authorization (carrying our `state`), which
// always returns to the callback, even when the app is already installed. Discovery
// lists the installations this user administers: the user picks one to bind, or,
// with none, is sent on to the App install page, whose return carries
// `installation_id` + `code` + `state`. The signed-in dashboard posts each return
// back, redeeming `state` only for the Maple user who started it.
// Account metadata comes from the App JWT
// (`GET /app/installations/{id}`); sync later mints its own installation tokens.
//
// Security: anyone can guess an `installation_id` (it's a small number), so before
// we sync someone's private repos we prove they own it. Two checks: (1) the OAuth
// `code` must show the user can manage that installation, and (2) we never bind an
// installation that already belongs to a different org.

const GITHUB_PROVIDER = "github" as const
const AUTHORIZE_PROVIDER = "github-authorize"
const SELECTION_PROVIDER = "github-selection"
const STATE_TTL_MS = 10 * 60_000 // 10 minutes

interface GithubBranchStatus {
	readonly name: string
	readonly isDefault: boolean
}

interface GithubRepoStatus {
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
	readonly prReviewEnabled: boolean
	/** All branch names the user can choose to track, for the picker. */
	readonly branches: ReadonlyArray<GithubBranchStatus>
}

interface GithubConnectStatus {
	readonly connected: boolean
	readonly state: GithubConnectionState
	readonly accountLogin: string | null
	readonly accountType: VcsAccountType | null
	readonly repositorySelection: VcsRepoSelection | null
	readonly ciTracesEnabled: boolean
	readonly repositoryDiscovery: VcsRepositoryDiscovery | null
	readonly repositories: ReadonlyArray<GithubRepoStatus>
}

export interface GithubConnectServiceApi {
	/**
	 * Create a single-use state row and the GitHub URL to open: user authorization by
	 * default, or the App install page for "Install on another GitHub account".
	 */
	readonly startConnect: (
		orgId: OrgId,
		userId: UserId,
		options: {
			readonly callbackUrl: string
			readonly returnTo?: string
			readonly mode?: "install"
		},
	) => Effect.Effect<
		{ readonly redirectUrl: string; readonly state: string },
		IntegrationsValidationError | IntegrationsPersistenceError
	>
	readonly completeConnect: (
		installationId: string,
		state: string,
		/**
		 * OAuth `code` from the callback. We exchange it to confirm the user can
		 * manage `installationId`. Required to connect a new installation.
		 */
		code: string | undefined,
		/** The signed-in Maple user finishing the connect; must be the one who started it. */
		initiator: OAuthFlowInitiator,
	) => Effect.Effect<
		{ readonly orgId: OrgId; readonly returnTo: string | null },
		IntegrationsValidationError | IntegrationsUpstreamError | IntegrationsPersistenceError
	>
	readonly getStatus: (orgId: OrgId) => Effect.Effect<GithubConnectStatus, IntegrationsPersistenceError>
	readonly discoverInstallations: (
		code: string,
		state: string,
		initiator: OAuthFlowInitiator,
	) => Effect.Effect<
		GithubInstallationSelection,
		IntegrationsValidationError | IntegrationsUpstreamError | IntegrationsPersistenceError
	>
	readonly selectInstallation: (
		installationId: string,
		state: string,
		initiator: OAuthFlowInitiator,
	) => Effect.Effect<
		{ readonly connected: true },
		IntegrationsValidationError | IntegrationsUpstreamError | IntegrationsPersistenceError
	>
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
	/** Turn CI traces from GitHub Actions on or off for the org's active installation. */
	readonly setCiTracesEnabled: (
		orgId: OrgId,
		enabled: boolean,
	) => Effect.Effect<
		{ readonly enabled: boolean },
		IntegrationsPersistenceError | IntegrationsValidationError
	>
	/**
	 * Turn the pull request review on or off for one repository.
	 * Rejected for a repository the provider has removed: there is nothing to
	 * review and no permission to post with.
	 */
	readonly setPrReviewEnabled: (
		orgId: OrgId,
		repositoryId: VcsRepositoryId,
		enabled: boolean,
	) => Effect.Effect<
		{ readonly enabled: boolean },
		IntegrationsPersistenceError | IntegrationsValidationError
	>
	readonly getPrReviewConfig: (
		orgId: OrgId,
		repositoryId: VcsRepositoryId,
	) => Effect.Effect<PrReviewRepositoryConfig, IntegrationsPersistenceError | IntegrationsValidationError>
	readonly setPrReviewConfig: (
		orgId: OrgId,
		repositoryId: VcsRepositoryId,
		config: PrReviewRepositoryConfig,
	) => Effect.Effect<PrReviewRepositoryConfig, IntegrationsPersistenceError | IntegrationsValidationError>
	readonly getPrReviewSettings: (
		orgId: OrgId,
	) => Effect.Effect<PrReviewOrgSettings, IntegrationsPersistenceError>
	readonly setPrReviewSettings: (
		orgId: OrgId,
		settings: PrReviewOrgSettings,
		updatedBy: UserId,
	) => Effect.Effect<PrReviewOrgSettings, IntegrationsPersistenceError | IntegrationsValidationError>
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
				message:
					"GitHub installation not found — it may have been removed. Restart the connect flow.",
			})
		: new IntegrationsUpstreamError({
				message: error.message,
				...(!(error.status === undefined) ? { status: error.status } : undefined),
			})

/**
 * Refuses a connect. The callback still answers 200 with this copy, so the refusal is also flagged
 * with `maple.vcs.connect.refused` and a span event that an alert can count by `vcs.connect.outcome`.
 */
const refuseConnect = (orgId: OrgId, outcome: string, reason: string, message: string) =>
	Effect.gen(function* () {
		const attributes = { "vcs.connect.outcome": outcome, "vcs.connect.reason": reason }
		yield* Effect.annotateCurrentSpan({ orgId, "maple.vcs.connect.refused": true, ...attributes })
		const at = yield* Clock.currentTimeNanos
		yield* Effect.currentSpan.pipe(
			Effect.map((span) => span.event("maple.vcs.connect.refused", at, attributes)),
			Effect.ignore,
		)
		return yield* new IntegrationsValidationError({ message })
	})

/** Trims and de-duplicates a review config, dropping empty fields so a later default reaches it. */
const cleanPrReviewConfig = Effect.fn("GithubConnectService.cleanPrReviewConfig")(function* (
	config: PrReviewRepositoryConfig,
) {
	const ignorePaths = [...new Set((config.ignorePaths ?? []).map((p) => p.trim()).filter((p) => p !== ""))]
	if (ignorePaths.length > 50)
		return yield* new IntegrationsValidationError({ message: "At most 50 ignored paths." })
	const instructions = config.instructions?.trim()
	return new PrReviewRepositoryConfig({
		...(instructions ? { instructions } : undefined),
		...(ignorePaths.length > 0 ? { ignorePaths } : undefined),
		...(config.categories === undefined ? undefined : { categories: config.categories }),
		...(config.minInlineSeverity === undefined
			? undefined
			: { minInlineSeverity: config.minInlineSeverity }),
		...(config.reviewDrafts === undefined ? undefined : { reviewDrafts: config.reviewDrafts }),
		...(config.reviewExternalContributors === undefined
			? undefined
			: { reviewExternalContributors: config.reviewExternalContributors }),
		...(config.dailyLimit === undefined ? undefined : { dailyLimit: config.dailyLimit }),
		...(config.automaticReviewLimit === undefined
			? undefined
			: { automaticReviewLimit: config.automaticReviewLimit }),
		...(config.feedbackScope === undefined ? undefined : { feedbackScope: config.feedbackScope }),
		...(config.blockOnContractBreaks === undefined
			? undefined
			: { blockOnContractBreaks: config.blockOnContractBreaks }),
		...(config.postMergeCheck === undefined ? undefined : { postMergeCheck: config.postMergeCheck }),
	})
})

export class GithubConnectService extends Context.Service<GithubConnectService, GithubConnectServiceApi>()(
	"@maple/backend/services/vcs/vendor/github/GithubConnectService",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const states = yield* OAuthStateRepository
			const repo = yield* VcsRepository
			const queue = yield* VcsSyncQueue
			const githubApp = yield* GithubAppClient
			const random = yield* SecureRandom.SecureRandom
			const newState = Effect.map(random.randomBytes(24), Base64Url.encode)

			const consumeState = (state: string, provider: string, initiator: OAuthFlowInitiator) =>
				states
					.consume({ state, provider, initiator })
					.pipe(
						Effect.catchTag("@maple/http/errors/OAuthStatePersistenceError", (error) =>
							Effect.fail(new IntegrationsPersistenceError({ message: error.message })),
						),
					)

			const ownedInstallation = Effect.fnUntraced(function* (orgId: OrgId, installationId: string) {
				const existing = yield* asPersistence(
					repo.resolveInstallation(GITHUB_PROVIDER, installationId),
				)
				if (Option.isSome(existing) && existing.value.orgId !== orgId) {
					return yield* refuseConnect(
						orgId,
						"installation_cross_org_rejected",
						"installation_id already belongs to a different org",
						"This GitHub installation is already connected to another Maple organization.",
					)
				}
				return existing
			})

			const bindInstallation = Effect.fnUntraced(function* (
				installationId: string,
				stateRow: OAuthAuthStateRow,
				detail: Effect.Success<ReturnType<GithubAppClient["Service"]["getInstallation"]>>,
				isSameOrgReconnect: boolean,
			) {
				const account = detail.account
				if (account === null) {
					return yield* new IntegrationsValidationError({
						message: "GitHub installation has no account — restart the connect flow",
					})
				}
				const accountType: VcsAccountType = account.type === "Organization" ? "organization" : "user"
				const repositorySelection: VcsRepoSelection =
					detail.repository_selection === "selected" ? "selected" : "all"
				const requestId = yield* newState
				const installation = yield* asPersistence(
					repo.upsertInstallation({
						orgId: stateRow.orgId,
						provider: GITHUB_PROVIDER,
						externalInstallationId: installationId,
						accountLogin: account.login,
						accountType,
						externalAccountId: String(account.id),
						accountAvatarUrl: account.avatar_url ?? null,
						repositorySelection,
						installedByUserId: stateRow.initiatedByUserId,
						repositoryDiscovery: { _tag: "Pending", requestId },
					}),
				)
				yield* asPersistence(
					queue
						.send({
							kind: "installation-sync",
							provider: GITHUB_PROVIDER,
							externalInstallationId: installationId,
							reason: isSameOrgReconnect ? "updated" : "created",
							requestId,
						})
						.pipe(
							Effect.tapError(() =>
								repo.finishRepositoryDiscovery(installation.id, {
									_tag: "Failed",
									requestId,
									message: "Repository discovery could not be queued. Reconnect to retry.",
								}),
							),
						),
				)
				yield* Effect.annotateCurrentSpan({
					orgId: stateRow.orgId,
					"vcs.connect.outcome": "connected",
					"vcs.account.type": accountType,
					"vcs.repository.selection": repositorySelection,
				})
				return { orgId: stateRow.orgId, returnTo: stateRow.returnTo }
			})

			const githubWeb = githubWebBaseUrl(env.GITHUB_API_BASE_URL)

			const insertState = Effect.fnUntraced(function* (row: {
				readonly orgId: OrgId
				readonly userId: UserId
				readonly provider: string
				readonly redirectUri: string
				readonly returnTo: string | null
				readonly githubInstallationIds?: ReadonlyArray<string>
			}) {
				const now = yield* Clock.currentTimeMillis
				const state = yield* newState
				yield* asPersistence(states.purgeExpired(now))
				yield* asPersistence(
					states.insert({
						state,
						orgId: row.orgId,
						provider: row.provider,
						initiatedByUserId: row.userId,
						redirectUri: row.redirectUri,
						returnTo: row.returnTo,
						githubInstallationIds:
							row.githubInstallationIds === undefined ? null : [...row.githubInstallationIds],
						createdAt: now,
						expiresAt: now + STATE_TTL_MS,
					}),
				)
				return state
			})

			const appConfig = Effect.fnUntraced(function* (orgId: OrgId) {
				const slug = Option.getOrUndefined(env.GITHUB_APP_SLUG)
				const clientId = Option.getOrUndefined(env.GITHUB_APP_CLIENT_ID)
				if (!slug || !clientId) {
					const missing = !slug ? "GITHUB_APP_SLUG" : "GITHUB_APP_CLIENT_ID"
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.connect.outcome": "app_not_configured",
						"vcs.connect.reason": `${missing} missing`,
					})
					return yield* new IntegrationsValidationError({
						message: `GitHub App is not configured (set ${missing})`,
					})
				}
				return { slug, clientId }
			})

			const installUrlOf = (slug: string, state: string) =>
				`${githubWeb}/apps/${slug}/installations/new?${new URLSearchParams({ state }).toString()}`

			const startConnect = Effect.fn("GithubConnectService.startConnect")(function* (
				orgId: OrgId,
				userId: UserId,
				options: {
					readonly callbackUrl: string
					readonly returnTo?: string
					readonly mode?: "install"
				},
			) {
				const { slug, clientId } = yield* appConfig(orgId)
				const isInstall = options.mode === "install"
				const state = yield* insertState({
					orgId,
					userId,
					provider: isInstall ? GITHUB_PROVIDER : AUTHORIZE_PROVIDER,
					redirectUri: options.callbackUrl,
					returnTo: options.returnTo ?? null,
				})
				yield* Effect.annotateCurrentSpan({
					orgId,
					"vcs.connect.outcome": "started",
					"vcs.connect.mode": isInstall ? "install" : "authorize",
				})
				if (isInstall) return { redirectUrl: installUrlOf(slug, state), state }
				const params = new URLSearchParams({
					client_id: clientId,
					redirect_uri: options.callbackUrl,
					state,
				})
				return { redirectUrl: `${githubWeb}/login/oauth/authorize?${params.toString()}`, state }
			})

			const completeConnect = Effect.fn("GithubConnectService.completeConnect")(function* (
				installationId: string,
				state: string,
				code: string | undefined,
				initiator: OAuthFlowInitiator,
			) {
				// Single-use, and only for the Maple user and org that started it: consumed before
				// any upstream call. Unknown, foreign and expired states all fail here.
				const stateRow = yield* states.consume({ state, provider: GITHUB_PROVIDER, initiator }).pipe(
					Effect.catchTag("@maple/http/errors/OAuthStatePersistenceError", (error) =>
						Effect.fail(new IntegrationsPersistenceError({ message: error.message })),
					),
					Effect.tapError(() =>
						Effect.annotateCurrentSpan({
							"vcs.connect.outcome": "state_rejected",
							"vcs.connect.reason": "state unknown, expired, or minted by another identity",
						}),
					),
				)

				// Don't let one org claim an installation another org already owns.
				// (Same org is fine — that's just reconnecting your own.)
				const existingInstallation = yield* ownedInstallation(stateRow.orgId, installationId)

				// Connecting a brand-new installation? Require the OAuth `code` and check
				// the user can actually manage it. No code → reject (don't guess-and-trust).
				// Reconnecting one this org already owns is allowed without a code.
				const isSameOrgReconnect = Option.isSome(existingInstallation)
				const hasCode = code !== undefined && code.length > 0
				const userToken = hasCode
					? Option.some(
							yield* githubApp.exchangeUserOAuthCode(code).pipe(
								Effect.tapError(() =>
									Effect.annotateCurrentSpan({
										orgId: stateRow.orgId,
										"vcs.connect.outcome": "oauth_exchange_failed",
										"vcs.connect.reason":
											"could not exchange OAuth code for a user token",
									}),
								),
								Effect.mapError(fromGithubError),
							),
						)
					: Option.none<string>()
				if (Option.isSome(userToken)) {
					const accessibleInstallationIds = yield* githubApp
						.listUserInstallationIds(userToken.value)
						.pipe(
							Effect.tapError(() =>
								Effect.annotateCurrentSpan({
									orgId: stateRow.orgId,
									"vcs.connect.outcome": "oauth_installations_failed",
									"vcs.connect.reason": "could not list the user's installations",
								}),
							),
							Effect.mapError(fromGithubError),
						)
					if (!accessibleInstallationIds.has(installationId)) {
						return yield* refuseConnect(
							stateRow.orgId,
							"installation_not_administrable",
							"authenticated user cannot administer the supplied installation_id",
							"You are not authorized to connect this GitHub installation. Restart the connect flow.",
						)
					}
				} else if (!isSameOrgReconnect) {
					// New installation, no `code` to prove ownership — refuse. (Needs the
					// App's OAuth-on-install setting enabled; see docs/github-app-setup.md.)
					return yield* refuseConnect(
						stateRow.orgId,
						"oauth_code_required",
						"new installation binding requires an OAuth code to prove ownership",
						"Could not verify you own this GitHub installation. Restart the connect flow from Maple, and ensure the GitHub App has user authorization during installation enabled.",
					)
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
							...(!(error.status === undefined)
								? { "vcs.github.status": error.status }
								: undefined),
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
				// Access to an installation is not ownership: a new binding needs an admin of its account.
				if (Option.isSome(userToken) && !isSameOrgReconnect) {
					const adminCheck = yield* githubApp.checkAccountAdmin(userToken.value, account).pipe(
						Effect.tapError(() =>
							Effect.annotateCurrentSpan({
								orgId: stateRow.orgId,
								"vcs.connect.outcome": "oauth_admin_check_failed",
								"vcs.connect.reason":
									"could not read the user's role on the installation account",
							}),
						),
						Effect.mapError(fromGithubError),
					)
					// A 403 on the role read is not a "no": GitHub withheld the org role from the App.
					if (adminCheck === "unverifiable") {
						return yield* refuseConnect(
							stateRow.orgId,
							"installation_admin_unverifiable",
							"GitHub refused to share the user's role on the installation account (403)",
							`Maple could not confirm you are an owner of ${account.login}: GitHub did not share organization roles with the Maple app. An owner of ${account.login} can approve the app's pending permission request (organization Settings > GitHub Apps > Review request), then retry. Or ask an owner to connect it.`,
						)
					}
					if (adminCheck === "not-admin") {
						return yield* refuseConnect(
							stateRow.orgId,
							"installation_not_administrable",
							"user is not an admin of the installation account (not-admin)",
							"Only an admin of this GitHub account can connect its installation. Ask an admin to connect it.",
						)
					}
				}
				return yield* bindInstallation(installationId, stateRow, detail, isSameOrgReconnect)
			})

			// One installation the user can see: a connectable choice, an account whose org
			// withheld the user's role (needs the app's permission request approved), or nothing.
			// An upstream failure skips that installation instead of failing the whole list.
			const classifyInstallation = (orgId: OrgId, userToken: string, id: string) =>
				Effect.gen(function* () {
					const detail = yield* githubApp.getInstallation(id)
					if (detail.account === null) return { _tag: "Skipped" as const }
					const admin = yield* githubApp.checkAccountAdmin(userToken, detail.account)
					if (admin === "unverifiable")
						return { _tag: "NeedsApproval" as const, accountLogin: detail.account.login }
					if (admin !== "admin") return { _tag: "Skipped" as const }
					const existing = yield* asPersistence(repo.resolveInstallation(GITHUB_PROVIDER, id))
					if (Option.isSome(existing) && existing.value.orgId !== orgId)
						return { _tag: "Skipped" as const }
					return {
						_tag: "Choice" as const,
						choice: new GithubInstallationChoice({
							id,
							accountLogin: detail.account.login,
							accountType: detail.account.type === "Organization" ? "organization" : "user",
							repositorySelection:
								detail.repository_selection === "selected" ? "selected" : "all",
						}),
					}
				}).pipe(
					Effect.catchTag("@maple/backend/vcs/GithubAppError", () =>
						Effect.succeed({ _tag: "Failed" as const }),
					),
				)

			const discoverInstallations = Effect.fn("GithubConnectService.discoverInstallations")(function* (
				code: string,
				state: string,
				initiator: OAuthFlowInitiator,
			) {
				const stateRow = yield* consumeState(state, AUTHORIZE_PROVIDER, initiator).pipe(
					Effect.tapError(() =>
						Effect.annotateCurrentSpan({
							"vcs.connect.outcome": "state_rejected",
							"vcs.connect.reason": "state unknown, expired, or minted by another identity",
						}),
					),
				)
				const { slug } = yield* appConfig(stateRow.orgId)
				const userToken = yield* githubApp.exchangeUserOAuthCode(code).pipe(
					Effect.tapError(() =>
						Effect.annotateCurrentSpan({
							orgId: stateRow.orgId,
							"vcs.connect.outcome": "oauth_exchange_failed",
							"vcs.connect.reason": "could not exchange OAuth code for a user token",
						}),
					),
					Effect.mapError(fromGithubError),
				)
				const ids = yield* githubApp.listUserInstallationIds(userToken).pipe(
					Effect.tapError(() =>
						Effect.annotateCurrentSpan({
							orgId: stateRow.orgId,
							"vcs.connect.outcome": "oauth_installations_failed",
							"vcs.connect.reason": "could not list the user's installations",
						}),
					),
					Effect.mapError(fromGithubError),
				)
				const results = yield* Effect.forEach(
					ids,
					(id) => classifyInstallation(stateRow.orgId, userToken, id),
					{ concurrency: 4 },
				)
				const installations = results
					.flatMap((result) => (result._tag === "Choice" ? [result.choice] : []))
					.sort((a, b) => a.accountLogin.localeCompare(b.accountLogin))
				const needsApproval = results
					.flatMap((result) => (result._tag === "NeedsApproval" ? [result.accountLogin] : []))
					.sort((a, b) => a.localeCompare(b))
				const failed = results.filter((result) => result._tag === "Failed").length
				const rowBase = {
					orgId: stateRow.orgId,
					userId: stateRow.initiatedByUserId,
					redirectUri: stateRow.redirectUri,
					returnTo: stateRow.returnTo,
				}
				const installState = yield* insertState({ ...rowBase, provider: GITHUB_PROVIDER })
				const selectionState = yield* insertState({
					...rowBase,
					provider: SELECTION_PROVIDER,
					githubInstallationIds: installations.map((installation) => installation.id),
				})
				yield* Effect.annotateCurrentSpan({
					orgId: stateRow.orgId,
					"vcs.connect.outcome":
						installations.length > 0
							? "installations_discovered"
							: needsApproval.length > 0
								? "installation_admin_unverifiable"
								: "no_installation",
					"vcs.connect.installations_seen": ids.size,
					"vcs.connect.installations_connectable": installations.length,
					"vcs.connect.installations_needing_approval": needsApproval.length,
					"vcs.connect.installations_failed": failed,
				})
				return new GithubInstallationSelection({
					state: selectionState,
					installations,
					needsApproval,
					installUrl: installUrlOf(slug, installState),
				})
			})

			const selectInstallation = Effect.fn("GithubConnectService.selectInstallation")(function* (
				installationId: string,
				state: string,
				initiator: OAuthFlowInitiator,
			): Effect.fn.Return<
				{ readonly connected: true },
				IntegrationsValidationError | IntegrationsUpstreamError | IntegrationsPersistenceError
			> {
				const stateRow = yield* consumeState(state, SELECTION_PROVIDER, initiator).pipe(
					Effect.tapError(() =>
						Effect.annotateCurrentSpan({
							"vcs.connect.outcome": "state_rejected",
							"vcs.connect.reason": "state unknown, expired, or minted by another identity",
						}),
					),
				)
				if (!stateRow.githubInstallationIds?.includes(installationId)) {
					return yield* refuseConnect(
						stateRow.orgId,
						"installation_not_authorized",
						"installation_id was not verified for this selection",
						"This installation was not authorized. Connect GitHub again from Maple.",
					)
				}
				const existing = yield* ownedInstallation(stateRow.orgId, installationId)
				const detail = yield* githubApp.getInstallation(installationId).pipe(
					Effect.tapError(() =>
						Effect.annotateCurrentSpan({
							orgId: stateRow.orgId,
							"vcs.connect.outcome": "upstream_github_error",
							"vcs.connect.reason": "could not read the selected installation",
						}),
					),
					Effect.mapError(fromGithubError),
				)
				yield* bindInstallation(installationId, stateRow, detail, Option.isSome(existing))
				return { connected: true }
			})

			// Resolve an installation's repositories into the dashboard summary shape
			// (one branch query per repo, bounded-concurrent so status loads do not scale
			// with repo count). "all" scope: surface provider-removed repos too.
			const repositoriesOf = Effect.fn("GithubConnectService.repositoriesOf")(function* (installation: {
				readonly id: VcsInstallationId
			}) {
				const repos = yield* asPersistence(
					repo.listRepositoriesByInstallation(installation.id, "all"),
				)
				return yield* Effect.forEach(
					repos,
					(r) =>
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
								prReviewEnabled: r.prReviewEnabled,
								branches: branches.map((b) => ({
									name: b.name,
									isDefault: b.isDefault,
								})),
							}
						}),
					// Below the request's Postgres pool (5), so a GitHub or Clerk call still gets a socket.
					{ concurrency: 4 },
				)
			})

			const getStatus = Effect.fn("GithubConnectService.getStatus")(function* (orgId: OrgId) {
				const installations = (yield* asPersistence(repo.listInstallationsByOrg(orgId))).filter(
					(i) => i.provider === GITHUB_PROVIDER,
				)
				const active = installations.find((i) => i.status === "active")
				if (active) {
					const repositories = yield* repositoriesOf(active)
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.status.outcome": "ok",
						"vcs.status.state": "connected",
						"vcs.status.connected": true,
						"vcs.account.type": active.accountType,
						"vcs.repository.selection": active.repositorySelection,
						"vcs.repository.count": repositories.length,
					})
					return {
						connected: true,
						state: "connected",
						accountLogin: active.accountLogin,
						accountType: active.accountType,
						repositorySelection: active.repositorySelection,
						ciTracesEnabled: active.ciTracesEnabled,
						repositoryDiscovery: active.repositoryDiscovery,
						repositories,
					} satisfies GithubConnectStatus
				}

				// No active installation. Rather than reverting to the pristine "never
				// connected" screen (which makes a deactivated integration look deleted),
				// surface the most-recently-touched deactivated row so the dashboard can
				// explain it was uninstalled/suspended on GitHub and offer a reconnect.
				// Installation rows are never auto-deleted, so one is here whenever the org
				// has connected before. Its repos/commits are kept too — shown read-only.
				const deactivated = [...installations].sort((a, b) => b.updatedAt - a.updatedAt)[0]
				if (!deactivated) {
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.status.outcome": "ok",
						"vcs.status.state": "not_connected",
						"vcs.status.connected": false,
					})
					return {
						connected: false,
						state: "not_connected",
						accountLogin: null,
						accountType: null,
						repositorySelection: null,
						ciTracesEnabled: true,
						repositoryDiscovery: null,
						repositories: [],
					} satisfies GithubConnectStatus
				}

				const state = deactivated.status === "suspended" ? "suspended" : "disconnected"
				const repositories = yield* repositoriesOf(deactivated)
				yield* Effect.annotateCurrentSpan({
					orgId,
					"vcs.status.outcome": "ok",
					"vcs.status.state": state,
					"vcs.status.connected": false,
					"vcs.installation.status": deactivated.status,
					"vcs.account.type": deactivated.accountType,
					"vcs.repository.count": repositories.length,
				})
				return {
					connected: false,
					state,
					accountLogin: deactivated.accountLogin,
					accountType: deactivated.accountType,
					repositorySelection: deactivated.repositorySelection,
					ciTracesEnabled: deactivated.ciTracesEnabled,
					repositoryDiscovery: deactivated.repositoryDiscovery,
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
				yield* Effect.forEach(targets, (i) => asPersistence(repo.purgeInstallation(orgId, i.id)), {
					discard: true,
				})
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
				// Check the installation exists BEFORE wiping commits. If it's gone we
				// can't re-sync the new branch, so we'd leave the repo empty — reject instead.
				if (Option.isNone(installationOpt)) {
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.repository.id": repositoryId,
						"vcs.set_tracked_branch.outcome": "installation_missing",
						"vcs.set_tracked_branch.reason":
							"installation row absent — refusing destructive branch change",
					})
					return yield* new IntegrationsValidationError({
						message:
							"This repository's GitHub installation is no longer connected. Reconnect GitHub before changing the tracked branch.",
					})
				}
				const installation = installationOpt.value
				if (!isInstallationProcessable(installation)) {
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
				// list), so we don't point the tracker at a non-existent ref.
				const branches = yield* asPersistence(repo.listBranchesByRepository(repositoryId))
				if (!branches.some((b) => b.name === trackedBranch)) {
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.repository.id": repositoryId,
						"vcs.set_tracked_branch.outcome": "unknown_branch",
						"vcs.set_tracked_branch.reason":
							"requested branch not in repository's known branches",
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
				yield* Effect.annotateCurrentSpan({
					orgId,
					"vcs.repository.id": repositoryId,
					"vcs.set_tracked_branch.outcome": "changed",
					"vcs.set_tracked_branch.reason": "branch changed; backfill enqueued",
					"vcs.set_tracked_branch.installation_missing": false,
					"vcs.branches.tracked": trackedBranch,
					"vcs.branches.changed": true,
					"vcs.branches.backfill_queued": true,
				})
				return { trackedBranch, backfillQueued: true }
			})

			const setCiTracesEnabled = Effect.fn("GithubConnectService.setCiTracesEnabled")(function* (
				orgId: OrgId,
				enabled: boolean,
			) {
				const installations = yield* asPersistence(repo.listInstallationsByOrg(orgId))
				const active = installations.find(
					(i) => i.provider === GITHUB_PROVIDER && i.status === "active",
				)
				if (active === undefined) {
					yield* Effect.annotateCurrentSpan({ orgId, "vcs.set_ci_traces.outcome": "not_connected" })
					return yield* new IntegrationsValidationError({ message: "GitHub is not connected." })
				}
				yield* asPersistence(repo.setCiTracesEnabled(orgId, active.id, enabled))
				yield* Effect.annotateCurrentSpan({
					orgId,
					"vcs.set_ci_traces.outcome": "changed",
					"vcs.ci_traces.enabled": enabled,
				})
				return { enabled }
			})

			const setPrReviewEnabled = Effect.fn("GithubConnectService.setPrReviewEnabled")(function* (
				orgId: OrgId,
				repositoryId: VcsRepositoryId,
				enabled: boolean,
			) {
				const existing = yield* asPersistence(repo.getRepositoryById(orgId, repositoryId))
				if (Option.isNone(existing)) {
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.repository.id": repositoryId,
						"vcs.set_pr_review.outcome": "repository_not_found",
					})
					return yield* new IntegrationsValidationError({ message: "Repository not found" })
				}
				if (enabled && existing.value.status !== "active") {
					yield* Effect.annotateCurrentSpan({
						orgId,
						"vcs.repository.id": repositoryId,
						"vcs.set_pr_review.outcome": "repository_removed",
					})
					return yield* new IntegrationsValidationError({
						message:
							"This repository is no longer accessible to the GitHub installation. Grant access on GitHub before enabling reviews.",
					})
				}
				yield* asPersistence(repo.setPrReviewEnabled(orgId, repositoryId, enabled))
				yield* Effect.annotateCurrentSpan({
					orgId,
					"vcs.repository.id": repositoryId,
					"vcs.set_pr_review.outcome": "changed",
					"vcs.pr_review.enabled": enabled,
				})
				return { enabled }
			})

			const requireRepository = (orgId: OrgId, repositoryId: VcsRepositoryId) =>
				asPersistence(repo.getRepositoryById(orgId, repositoryId)).pipe(
					Effect.flatMap((existing) =>
						Option.isNone(existing)
							? Effect.fail(
									new IntegrationsValidationError({ message: "Repository not found" }),
								)
							: Effect.succeed(existing.value),
					),
				)

			const getPrReviewConfig = Effect.fn("GithubConnectService.getPrReviewConfig")(function* (
				orgId: OrgId,
				repositoryId: VcsRepositoryId,
			) {
				yield* requireRepository(orgId, repositoryId)
				return yield* asPersistence(repo.getPrReviewConfig(orgId, repositoryId))
			})

			// Trimmed and de-duplicated on the way in, so the kickoff and the enforcement read the same list.
			const setPrReviewConfig = Effect.fn("GithubConnectService.setPrReviewConfig")(function* (
				orgId: OrgId,
				repositoryId: VcsRepositoryId,
				config: PrReviewRepositoryConfig,
			) {
				yield* requireRepository(orgId, repositoryId)
				const cleaned = yield* cleanPrReviewConfig(config)
				const ignorePaths = cleaned.ignorePaths ?? []
				const instructions = cleaned.instructions
				yield* asPersistence(repo.setPrReviewConfig(orgId, repositoryId, cleaned))
				yield* Effect.annotateCurrentSpan({
					orgId,
					"vcs.repository.id": repositoryId,
					"vcs.pr_review.ignore_paths": ignorePaths.length,
					"vcs.pr_review.has_instructions": instructions !== undefined && instructions !== "",
				})
				return cleaned
			})

			const getPrReviewSettings = Effect.fn("GithubConnectService.getPrReviewSettings")(function* (
				orgId: OrgId,
			) {
				return yield* asPersistence(repo.getPrReviewSettings(orgId))
			})

			const setPrReviewSettings = Effect.fn("GithubConnectService.setPrReviewSettings")(function* (
				orgId: OrgId,
				settings: PrReviewOrgSettings,
				updatedBy: UserId,
			) {
				const defaults =
					settings.defaults === undefined
						? undefined
						: yield* cleanPrReviewConfig(settings.defaults)
				const cleaned = new PrReviewOrgSettings({
					...(settings.model === undefined ? undefined : { model: settings.model }),
					...(defaults === undefined || Object.keys(defaults).length === 0
						? undefined
						: { defaults }),
				})
				yield* asPersistence(repo.setPrReviewSettings(orgId, cleaned, updatedBy))
				yield* Effect.annotateCurrentSpan({
					orgId,
					"vcs.pr_review.model": cleaned.model ?? "default",
					"vcs.pr_review.has_defaults": cleaned.defaults !== undefined,
				})
				return cleaned
			})

			return {
				startConnect,
				completeConnect,
				discoverInstallations,
				selectInstallation,
				getStatus,
				disconnect,
				deleteRepository,
				setTrackedBranch,
				setCiTracesEnabled,
				setPrReviewEnabled,
				getPrReviewConfig,
				getPrReviewSettings,
				setPrReviewSettings,
				setPrReviewConfig,
			} satisfies GithubConnectServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				VcsSyncQueue.layer,
				GithubAppClient.layer,
				VcsRepository.layer,
				OAuthStateRepository.layer,
				SecureRandom.layerWebCrypto,
			),
		),
	)
}
