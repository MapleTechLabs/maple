import { randomBytes, randomUUID } from "node:crypto"
import {
	githubCommits,
	githubInstallations,
	githubRepositories,
	githubReleases,
	githubUnresolvedShas,
	oauthAuthStates,
	type GithubInstallationRow,
	type GithubRepositoryRow,
} from "@maple/db"
import {
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import { and, eq, inArray, lt, sql } from "drizzle-orm"
import { Context, Effect, Exit, Layer, Option } from "effect"
import { Database, type DatabaseClient } from "./DatabaseLive"
import { Env } from "./Env"
import {
	githubIntegrationMissingEnv,
	GithubAppJwtService,
} from "./GithubAppJwtService"

const GITHUB_PROVIDER = "github"
const STATE_TTL_MS = 10 * 60_000

const toPersistenceError = (cause: unknown) =>
	new IntegrationsPersistenceError({
		message: cause instanceof Error ? cause.message : "GitHub integration database error",
	})

export interface GithubInstallationListItem {
	readonly row: GithubInstallationRow
	readonly repositoryCount: number
}

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
		IntegrationsPersistenceError
	>
	readonly startInstall: (params: {
		readonly orgId: OrgId
		readonly userId: UserId
		readonly callbackUrl: string
		readonly returnTo?: string
	}) => Effect.Effect<
		{ readonly redirectUrl: string; readonly state: string },
		IntegrationsValidationError | IntegrationsPersistenceError
	>
	readonly consumeState: (
		state: string,
	) => Effect.Effect<
		{ readonly orgId: OrgId; readonly userId: UserId; readonly returnTo: string | null },
		IntegrationsValidationError | IntegrationsPersistenceError
	>
	readonly listInstallations: (
		orgId: OrgId,
	) => Effect.Effect<ReadonlyArray<GithubInstallationListItem>, IntegrationsPersistenceError>
	readonly listRepositories: (
		orgId: OrgId,
		installationDbId: string,
	) => Effect.Effect<
		ReadonlyArray<GithubRepositoryRow & { readonly commitCount: number }>,
		IntegrationsNotConnectedError | IntegrationsPersistenceError
	>
	readonly setRepoSyncEnabled: (params: {
		readonly orgId: OrgId
		readonly repositoryId: string
		readonly enabled: boolean
	}) => Effect.Effect<
		{ readonly repositoryId: string; readonly syncEnabled: boolean },
		IntegrationsNotConnectedError | IntegrationsPersistenceError
	>
	readonly disconnectInstallation: (params: {
		readonly orgId: OrgId
		readonly installationId: string
	}) => Effect.Effect<
		{ readonly disconnected: boolean; readonly uninstallUrl: string | null },
		IntegrationsNotConnectedError | IntegrationsPersistenceError | IntegrationsUpstreamError
	>
	readonly findRepoForBackfill: (
		orgId: OrgId,
		repositoryId: string,
	) => Effect.Effect<
		GithubRepositoryRow,
		IntegrationsNotConnectedError | IntegrationsPersistenceError
	>
}

export class GithubAppService extends Context.Service<GithubAppService, GithubAppServiceShape>()(
	"GithubAppService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const jwtService = yield* GithubAppJwtService

			const dbExecute = <T>(fn: (db: DatabaseClient) => Promise<T>) =>
				database.execute(fn).pipe(Effect.mapError(toPersistenceError))

			const getStatus = Effect.fn("GithubAppService.getStatus")(function* (orgId: OrgId) {
				const missingEnv = githubIntegrationMissingEnv(env)
				const installationsCount = yield* dbExecute((db) =>
					db
						.select({ count: sql<number>`count(*)` })
						.from(githubInstallations)
						.where(eq(githubInstallations.orgId, orgId)),
				)
				const count = Number(installationsCount[0]?.count ?? 0)
				return {
					configured: missingEnv.length === 0,
					appSlug: Option.getOrNull(env.GITHUB_APP_SLUG),
					missingEnv,
					installations: count,
				}
			})

			const purgeExpiredStates = (currentTime: number) =>
				dbExecute((db) =>
					db.delete(oauthAuthStates).where(lt(oauthAuthStates.expiresAt, currentTime)),
				)

			const startInstall = Effect.fn("GithubAppService.startInstall")(function* (params: {
				readonly orgId: OrgId
				readonly userId: UserId
				readonly callbackUrl: string
				readonly returnTo?: string
			}) {
				const config = yield* jwtService.resolveConfig
				const state = randomBytes(24).toString("base64url")
				const currentTime = Date.now()
				yield* purgeExpiredStates(currentTime)
				yield* dbExecute((db) =>
					db.insert(oauthAuthStates).values({
						state,
						orgId: params.orgId,
						provider: GITHUB_PROVIDER,
						initiatedByUserId: params.userId,
						redirectUri: params.callbackUrl,
						returnTo: params.returnTo ?? null,
						createdAt: currentTime,
						expiresAt: currentTime + STATE_TTL_MS,
					}),
				)
				const installUrl = `${config.appBaseUrl}/apps/${encodeURIComponent(config.appSlug)}/installations/new?state=${encodeURIComponent(state)}`
				return { redirectUrl: installUrl, state }
			})

			const consumeState = Effect.fn("GithubAppService.consumeState")(function* (state: string) {
				const rows = yield* dbExecute((db) =>
					db.select().from(oauthAuthStates).where(eq(oauthAuthStates.state, state)).limit(1),
				)
				const row = rows[0]
				if (!row || row.provider !== GITHUB_PROVIDER) {
					return yield* Effect.fail(
						new IntegrationsValidationError({
							message: "GitHub install state not recognized — restart the connect flow",
						}),
					)
				}
				if (row.expiresAt < Date.now()) {
					yield* dbExecute((db) =>
						db.delete(oauthAuthStates).where(eq(oauthAuthStates.state, state)),
					)
					return yield* Effect.fail(
						new IntegrationsValidationError({
							message: "GitHub install state expired — restart the connect flow",
						}),
					)
				}
				yield* dbExecute((db) =>
					db.delete(oauthAuthStates).where(eq(oauthAuthStates.state, state)),
				)
				return {
					orgId: row.orgId as OrgId,
					userId: row.initiatedByUserId as UserId,
					returnTo: row.returnTo ?? null,
				}
			})

			const listInstallations = Effect.fn("GithubAppService.listInstallations")(function* (
				orgId: OrgId,
			) {
				const rows = (yield* dbExecute((db) =>
					db
						.select()
						.from(githubInstallations)
						.where(eq(githubInstallations.orgId, orgId)),
				)) as ReadonlyArray<GithubInstallationRow>
				const counts = yield* dbExecute((db) =>
					db
						.select({
							installationId: githubRepositories.installationId,
							count: sql<number>`count(*)`,
						})
						.from(githubRepositories)
						.where(eq(githubRepositories.orgId, orgId))
						.groupBy(githubRepositories.installationId),
				)
				const countMap = new Map(counts.map((c) => [c.installationId, Number(c.count)]))
				return rows.map((row) => ({
					row,
					repositoryCount: countMap.get(row.id) ?? 0,
				}))
			})

			const listRepositories = Effect.fn("GithubAppService.listRepositories")(function* (
				orgId: OrgId,
				installationDbId: string,
			) {
				const installationRows = yield* dbExecute((db) =>
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
				)
				if (!installationRows[0]) {
					return yield* Effect.fail(
						new IntegrationsNotConnectedError({
							message: "Installation not found for this org",
						}),
					)
				}
				const repos = (yield* dbExecute((db) =>
					db
						.select()
						.from(githubRepositories)
						.where(
							and(
								eq(githubRepositories.orgId, orgId),
								eq(githubRepositories.installationId, installationDbId),
							),
						),
				)) as ReadonlyArray<GithubRepositoryRow>
				const counts = yield* dbExecute((db) =>
					db
						.select({ repoId: githubCommits.repoId, count: sql<number>`count(*)` })
						.from(githubCommits)
						.where(eq(githubCommits.orgId, orgId))
						.groupBy(githubCommits.repoId),
				)
				const countMap = new Map(counts.map((c) => [c.repoId, Number(c.count)]))
				return repos.map((repo) => ({
					...repo,
					commitCount: countMap.get(repo.id) ?? 0,
				}))
			})

			const setRepoSyncEnabled = Effect.fn("GithubAppService.setRepoSyncEnabled")(function* (
				params: { readonly orgId: OrgId; readonly repositoryId: string; readonly enabled: boolean },
			) {
				const rows = yield* dbExecute((db) =>
					db
						.select()
						.from(githubRepositories)
						.where(
							and(
								eq(githubRepositories.orgId, params.orgId),
								eq(githubRepositories.id, params.repositoryId),
							),
						)
						.limit(1),
				)
				if (!rows[0]) {
					return yield* Effect.fail(
						new IntegrationsNotConnectedError({
							message: "Repository not found for this org",
						}),
					)
				}
				yield* dbExecute((db) =>
					db
						.update(githubRepositories)
						.set({ syncEnabled: params.enabled, updatedAt: Date.now() })
						.where(eq(githubRepositories.id, params.repositoryId)),
				)
				return { repositoryId: params.repositoryId, syncEnabled: params.enabled }
			})

			const disconnectInstallation = Effect.fn("GithubAppService.disconnectInstallation")(
				function* (params: { readonly orgId: OrgId; readonly installationId: string }) {
					const rows = yield* dbExecute((db) =>
						db
							.select()
							.from(githubInstallations)
							.where(
								and(
									eq(githubInstallations.orgId, params.orgId),
									eq(githubInstallations.id, params.installationId),
								),
							)
							.limit(1),
					)
					const installation = rows[0]
					if (!installation) {
						return yield* Effect.fail(
							new IntegrationsNotConnectedError({
								message: "Installation not found for this org",
							}),
						)
					}

					// Hard delete: remove the installation, its repos, and all derived data
					// (commits, releases, tombstones). The user wants the integration fully
					// gone so re-connecting starts from a clean slate.
					const repoIds = (yield* dbExecute((db) =>
						db
							.select({ id: githubRepositories.id })
							.from(githubRepositories)
							.where(
								and(
									eq(githubRepositories.orgId, params.orgId),
									eq(githubRepositories.installationId, params.installationId),
								),
							),
					)) as ReadonlyArray<{ id: string }>

					if (repoIds.length > 0) {
						const ids = repoIds.map((r) => r.id)
						yield* dbExecute((db) =>
							db
								.delete(githubCommits)
								.where(
									and(
										eq(githubCommits.orgId, params.orgId),
										inArray(githubCommits.repoId, ids),
									),
								),
						)
						yield* dbExecute((db) =>
							db
								.delete(githubReleases)
								.where(
									and(
										eq(githubReleases.orgId, params.orgId),
										inArray(githubReleases.repoId, ids),
									),
								),
						)
					}
					yield* dbExecute((db) =>
						db
							.delete(githubRepositories)
							.where(
								and(
									eq(githubRepositories.orgId, params.orgId),
									eq(githubRepositories.installationId, params.installationId),
								),
							),
					)
					yield* dbExecute((db) =>
						db
							.delete(githubInstallations)
							.where(eq(githubInstallations.id, params.installationId)),
					)
					// Tombstones are org-scoped (not repo-scoped) — if this is the last
					// installation for the org, drop them all so a re-sync starts clean.
					const remaining = (yield* dbExecute((db) =>
						db
							.select({ count: sql<number>`count(*)` })
							.from(githubInstallations)
							.where(eq(githubInstallations.orgId, params.orgId)),
					)) as ReadonlyArray<{ count: number }>
					if (Number(remaining[0]?.count ?? 0) === 0) {
						yield* dbExecute((db) =>
							db
								.delete(githubUnresolvedShas)
								.where(eq(githubUnresolvedShas.orgId, params.orgId)),
						)
					}

					yield* jwtService.invalidateInstallationToken(installation.installationId)

					const configExit = yield* Effect.exit(jwtService.resolveConfig)
					const uninstallUrl = Exit.isSuccess(configExit)
						? `${configExit.value.appBaseUrl}/settings/installations/${installation.installationId}`
						: null
					return { disconnected: true, uninstallUrl }
				},
			)

			const findRepoForBackfill = Effect.fn("GithubAppService.findRepoForBackfill")(function* (
				orgId: OrgId,
				repositoryId: string,
			) {
				const rows = yield* dbExecute((db) =>
					db
						.select()
						.from(githubRepositories)
						.where(
							and(
								eq(githubRepositories.orgId, orgId),
								eq(githubRepositories.id, repositoryId),
							),
						)
						.limit(1),
				)
				const repo = rows[0]
				if (!repo) {
					return yield* Effect.fail(
						new IntegrationsNotConnectedError({
							message: "Repository not found for this org",
						}),
					)
				}
				return repo as GithubRepositoryRow
			})

			return {
				getStatus,
				startInstall,
				consumeState,
				listInstallations,
				listRepositories,
				setRepoSyncEnabled,
				disconnectInstallation,
				findRepoForBackfill,
			} satisfies GithubAppServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(GithubAppJwtService.layer),
	)
	static readonly Default = this.layer
}

// Re-export schema tables that route handlers may also need to query for
// commit-lookup and resync workflows. Note: these only re-export the names;
// the actual queries always go through the @maple/db package.
export {
	githubCommits,
	githubInstallations,
	githubRepositories,
	githubReleases,
	githubUnresolvedShas,
}
