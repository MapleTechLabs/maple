import {
	CurrentTenant,
	GithubBackfillRepoResponse,
	GithubDisconnectResponse,
	GithubForbiddenError,
	GithubIntegrationStatus,
	GithubInstallationSummary,
	GithubInstallationsListResponse,
	GithubNotConnectedError,
	GithubRepositoriesListResponse,
	GithubRepositorySummary,
	GithubSetRepoSyncResponse,
	GithubStartConnectResponse,
	GithubValidationError,
	MapleApi,
} from "@maple/domain/http"
import { Clock, Effect } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { isSameOrigin, resolveRequestOrigin } from "../lib/http-origin"
import { requireAdmin } from "../lib/auth"
import { GithubAppService } from "../services/GithubAppService"
import type { DecodedGithubInstallationRow } from "../services/GithubInstallationRepo"
import { GithubRepositoryRepo, type DecodedGithubRepositoryRow } from "../services/GithubRepositoryRepo"
import { GithubSyncQueue } from "../services/GithubSyncQueue"
import { GITHUB_CALLBACK_PATH } from "./github-callback.http"

const repoNotFound = () =>
	new GithubNotConnectedError({
		code: "RepositoryNotFound",
		message: "Repository not found for this org",
	})

const forbidden = () =>
	new GithubForbiddenError({
		code: "NotAdmin",
		message: "Only org admins can manage integrations",
	})

const toInstallationSummary = ({
	row,
	repositoryCount,
}: {
	readonly row: DecodedGithubInstallationRow
	readonly repositoryCount: number
}) =>
	new GithubInstallationSummary({
		id: row.id,
		installationId: row.installationId,
		appSlug: row.appSlug,
		accountId: row.accountId,
		accountLogin: row.accountLogin,
		accountAvatarUrl: row.accountAvatarUrl,
		accountType: row.accountType,
		repositorySelection: row.repositorySelection,
		suspendedAt: row.suspendedAt,
		installedByUserId: row.installedByUserId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		repositoryCount,
	})

const toRepositorySummary = (row: DecodedGithubRepositoryRow & { readonly commitCount: number }) =>
	new GithubRepositorySummary({
		id: row.id,
		installationId: row.installationId,
		githubRepoId: row.githubRepoId,
		owner: row.owner,
		name: row.name,
		defaultBranch: row.defaultBranch,
		private: row.private,
		htmlUrl: row.htmlUrl,
		syncEnabled: row.syncEnabled,
		lastSyncedAt: row.lastSyncedAt,
		lastFullBackfillAt: row.lastFullBackfillAt,
		backfillStatus: row.backfillStatus,
		backfillError: row.backfillError,
		commitCount: row.commitCount,
	})

export const HttpGithubLive = HttpApiBuilder.group(MapleApi, "github", (handlers) =>
	Effect.gen(function* () {
		const app = yield* GithubAppService
		const repositoryRepo = yield* GithubRepositoryRepo
		const queue = yield* GithubSyncQueue

		return handlers
			.handle("githubStatus", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const status = yield* app.getStatus(tenant.orgId)
					return new GithubIntegrationStatus(status)
				}),
			)
			.handle("githubStart", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, forbidden)
					const req = yield* HttpServerRequest.HttpServerRequest
					const origin = resolveRequestOrigin(req)
					// `returnTo` is user-supplied and stored in the DB, then later
					// used as `window.location.replace(returnTo)` in the callback
					// popup. Reject any cross-origin URL up front to close an
					// open-redirect vector. Relative paths are always same-origin.
					if (payload.returnTo && !isSameOrigin(origin, payload.returnTo)) {
						return yield* Effect.fail(
							new GithubValidationError({
								code: "ReturnToCrossOrigin",
								message: "returnTo must point at the same origin as the install request",
							}),
						)
					}
					const callbackUrl = `${origin}${GITHUB_CALLBACK_PATH}`
					const result = yield* app.startInstall({
						orgId: tenant.orgId,
						userId: tenant.userId,
						callbackUrl,
						returnTo: payload.returnTo,
					})
					return new GithubStartConnectResponse(result)
				}),
			)
			.handle("githubListInstallations", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const items = yield* app.listInstallations(tenant.orgId)
					return new GithubInstallationsListResponse({
						installations: items.map(toInstallationSummary),
					})
				}),
			)
			.handle("githubListRepositories", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const repos = yield* app.listRepositories(tenant.orgId, params.installationId)
					return new GithubRepositoriesListResponse({
						repositories: repos.map(toRepositorySummary),
					})
				}),
			)
			.handle("githubSetRepoSync", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, forbidden)
					const repo = yield* repositoryRepo.findByOrgAndDbId(
						tenant.orgId,
						params.repositoryId,
					)
					if (!repo) return yield* Effect.fail(repoNotFound())
					const updatedAt = yield* Clock.currentTimeMillis
					yield* repositoryRepo.updateById(repo.id, {
						syncEnabled: payload.enabled,
						updatedAt,
					})
					if (payload.enabled) {
						yield* queue.enqueueBackfill({ orgId: tenant.orgId, repoId: repo.id })
					}
					return new GithubSetRepoSyncResponse({
						repositoryId: repo.id,
						syncEnabled: payload.enabled,
					})
				}),
			)
			.handle("githubBackfillRepo", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, forbidden)
					const repo = yield* repositoryRepo.findByOrgAndDbId(
						tenant.orgId,
						params.repositoryId,
					)
					if (!repo) return yield* Effect.fail(repoNotFound())
					yield* queue.enqueueBackfill({ orgId: tenant.orgId, repoId: repo.id })
					return new GithubBackfillRepoResponse({
						repositoryId: repo.id,
						enqueued: true,
					})
				}),
			)
			.handle("githubDisconnect", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, forbidden)
					const result = yield* app.disconnectInstallation({
						orgId: tenant.orgId,
						installationId: params.installationId,
					})
					return new GithubDisconnectResponse(result)
				}),
			)
	}),
)
