import { randomBytes } from "node:crypto"
import {
	GithubNotConnectedError,
	GithubPersistenceError,
	GithubUpstreamError,
	GithubValidationError,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import { Clock, Context, Effect, Exit, Layer, Option } from "effect"
import { Env } from "./Env"
import {
	githubIntegrationMissingEnv,
	GithubAppJwtService,
} from "./GithubAppJwtService"
import { GithubCommitRepo } from "./GithubCommitRepo"
import {
	GithubInstallationRepo,
	type DecodedGithubInstallationRow,
} from "./GithubInstallationRepo"
import { GithubOauthAuthStateRepo } from "./GithubOauthAuthStateRepo"
import {
	GithubRepositoryRepo,
	type DecodedGithubRepositoryRow,
} from "./GithubRepositoryRepo"

const STATE_TTL_MS = 10 * 60_000

export interface GithubInstallationListItem {
	readonly row: DecodedGithubInstallationRow
	readonly repositoryCount: number
}

// Github integration application service. Owns the multi-primitive workflows
// that don't fit into a single repo/queue:
//   - getStatus              — env config + installation count
//   - startInstall           — generate state token, persist via oauth-state repo, build install URL
//   - consumeState           — validate + delete state row, return install context
//   - listInstallations      — installations + cross-repo count join
//   - listRepositories       — repos + cross-repo commit-count join
//   - disconnectInstallation — cascade delete across 3 repos + uninstall URL
//
// Pure repo/queue wrappers (setRepoSyncEnabled, findRepoForBackfill,
// enqueueRepoBackfill) live at call sites — they don't earn the indirection.

export interface GithubAppServiceShape {
	readonly getStatus: (
		orgId: OrgId,
	) => Effect.Effect<
		{
			readonly configured: boolean
			readonly appSlug: string | null
			readonly missingEnv: ReadonlyArray<string>
			readonly installations: number
		},
		GithubPersistenceError
	>
	readonly startInstall: (params: {
		readonly orgId: OrgId
		readonly userId: UserId
		readonly callbackUrl: string
		readonly returnTo?: string
	}) => Effect.Effect<
		{ readonly redirectUrl: string; readonly state: string },
		GithubValidationError | GithubPersistenceError
	>
	readonly consumeState: (
		state: string,
	) => Effect.Effect<
		{ readonly orgId: OrgId; readonly userId: UserId; readonly returnTo: string | null },
		GithubValidationError | GithubPersistenceError
	>
	readonly listInstallations: (
		orgId: OrgId,
	) => Effect.Effect<ReadonlyArray<GithubInstallationListItem>, GithubPersistenceError>
	readonly listRepositories: (
		orgId: OrgId,
		installationDbId: string,
	) => Effect.Effect<
		ReadonlyArray<DecodedGithubRepositoryRow & { readonly commitCount: number }>,
		GithubNotConnectedError | GithubPersistenceError
	>
	readonly disconnectInstallation: (params: {
		readonly orgId: OrgId
		readonly installationId: string
	}) => Effect.Effect<
		{ readonly disconnected: boolean; readonly uninstallUrl: string | null },
		GithubNotConnectedError | GithubPersistenceError | GithubUpstreamError
	>
}

const GITHUB_PROVIDER = "github"

export class GithubAppService extends Context.Service<GithubAppService, GithubAppServiceShape>()(
	"GithubAppService",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const jwtService = yield* GithubAppJwtService
			const installationRepo = yield* GithubInstallationRepo
			const repositoryRepo = yield* GithubRepositoryRepo
			const commitRepo = yield* GithubCommitRepo
			const oauthStateRepo = yield* GithubOauthAuthStateRepo

			const getStatus = Effect.fn("GithubAppService.getStatus")(function* (orgId: OrgId) {
				const missingEnv = githubIntegrationMissingEnv(env)
				const installations = yield* installationRepo.countByOrg(orgId)
				return {
					configured: missingEnv.length === 0,
					appSlug: Option.getOrNull(env.GITHUB_APP_SLUG),
					missingEnv,
					installations,
				}
			})

			const startInstall = Effect.fn("GithubAppService.startInstall")(function* (params: {
				readonly orgId: OrgId
				readonly userId: UserId
				readonly callbackUrl: string
				readonly returnTo?: string
			}) {
				const config = yield* jwtService.resolveConfig
				const state = randomBytes(24).toString("base64url")
				const currentTime = yield* Clock.currentTimeMillis
				yield* oauthStateRepo.purgeExpired(currentTime)
				yield* oauthStateRepo.insert({
					state,
					orgId: params.orgId,
					initiatedByUserId: params.userId,
					redirectUri: params.callbackUrl,
					returnTo: params.returnTo ?? null,
					createdAt: currentTime,
					expiresAt: currentTime + STATE_TTL_MS,
				})
				const installUrl = `${config.appBaseUrl}/apps/${encodeURIComponent(config.appSlug)}/installations/new?state=${encodeURIComponent(state)}`
				return { redirectUrl: installUrl, state }
			})

			const consumeState = Effect.fn("GithubAppService.consumeState")(function* (state: string) {
				const row = yield* oauthStateRepo.findByState(state)
				if (!row || row.provider !== GITHUB_PROVIDER) {
					return yield* Effect.fail(
						new GithubValidationError({
							code: "StateNotRecognized",
							message: "GitHub install state not recognized — restart the connect flow",
						}),
					)
				}
				const now = yield* Clock.currentTimeMillis
				if (row.expiresAt < now) {
					yield* oauthStateRepo.deleteByState(state)
					return yield* Effect.fail(
						new GithubValidationError({
							code: "StateExpired",
							message: "GitHub install state expired — restart the connect flow",
						}),
					)
				}
				yield* oauthStateRepo.deleteByState(state)
				return {
					orgId: row.orgId as OrgId,
					userId: row.initiatedByUserId as UserId,
					returnTo: row.returnTo ?? null,
				}
			})

			const listInstallations = Effect.fn("GithubAppService.listInstallations")(function* (
				orgId: OrgId,
			) {
				const rows = yield* installationRepo.listByOrg(orgId)
				const countMap = yield* repositoryRepo.countByInstallationForOrg(orgId)
				return rows.map((row) => ({
					row,
					repositoryCount: countMap.get(row.id) ?? 0,
				}))
			})

			const listRepositories = Effect.fn("GithubAppService.listRepositories")(function* (
				orgId: OrgId,
				installationDbId: string,
			) {
				const installation = yield* installationRepo.findByOrgAndDbId(orgId, installationDbId)
				if (!installation) {
					return yield* Effect.fail(
						new GithubNotConnectedError({
							code: "InstallationNotFound",
							message: "Installation not found for this org",
						}),
					)
				}
				const repos = yield* repositoryRepo.listByOrgAndInstallation(orgId, installationDbId)
				const countMap = yield* commitRepo.countByRepoForOrg(orgId)
				return repos.map((repo) => ({
					...repo,
					commitCount: countMap.get(repo.id) ?? 0,
				}))
			})

			const disconnectInstallation = Effect.fn("GithubAppService.disconnectInstallation")(
				function* (params: { readonly orgId: OrgId; readonly installationId: string }) {
					const installation = yield* installationRepo.findByOrgAndDbId(
						params.orgId,
						params.installationId,
					)
					if (!installation) {
						return yield* Effect.fail(
							new GithubNotConnectedError({
								code: "InstallationNotFound",
								message: "Installation not found for this org",
							}),
						)
					}

					// Hard delete: remove the installation, its repos, and all derived data
					// (commits, releases, tombstones). The user wants the integration fully
					// gone so re-connecting starts from a clean slate.
					const repoIds = yield* repositoryRepo.listIdsByOrgAndInstallation(
						params.orgId,
						params.installationId,
					)

					if (repoIds.length > 0) {
						yield* commitRepo.deleteByOrgAndRepoIds(params.orgId, repoIds)
						yield* commitRepo.deleteReleasesByOrgAndRepoIds(params.orgId, repoIds)
					}
					yield* repositoryRepo.deleteByOrgAndInstallation(
						params.orgId,
						params.installationId,
					)
					yield* installationRepo.deleteById(params.installationId)

					// Tombstones are org-scoped (not repo-scoped) — if this is the last
					// installation for the org, drop them all so a re-sync starts clean.
					const remaining = yield* installationRepo.countByOrg(params.orgId)
					if (remaining === 0) {
						yield* commitRepo.deleteUnresolvedShasByOrg(params.orgId)
					}

					const configExit = yield* Effect.exit(jwtService.resolveConfig)
					const uninstallUrl = Exit.isSuccess(configExit)
						? `${configExit.value.appBaseUrl}/settings/installations/${installation.installationId}`
						: null
					return { disconnected: true, uninstallUrl }
				},
			)

			return {
				getStatus,
				startInstall,
				consumeState,
				listInstallations,
				listRepositories,
				disconnectInstallation,
			} satisfies GithubAppServiceShape
		}),
	},
) {
	// Self-providing layer for all the github primitives this service depends
	// on. `GithubSyncQueue` is no longer wired here — backfill enqueuing now
	// lives on the queue itself, callers reach it directly.
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(GithubAppJwtService.layer),
		Layer.provide(GithubInstallationRepo.layer),
		Layer.provide(GithubRepositoryRepo.layer),
		Layer.provide(GithubCommitRepo.layer),
		Layer.provide(GithubOauthAuthStateRepo.layer),
	)
}
