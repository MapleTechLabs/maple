import {
	CurrentTenant,
	GithubBackfillRepoResponse,
	GithubDisconnectResponse,
	GithubIntegrationStatus,
	GithubInstallationSummary,
	GithubInstallationsListResponse,
	GithubRepositoriesListResponse,
	GithubRepositorySummary,
	GithubSetRepoSyncResponse,
	GithubStartConnectResponse,
	GithubForbiddenError,
	MapleApi,
} from "@maple/domain/http"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { GithubAppService } from "../services/GithubAppService"
import { GithubSyncQueue } from "../services/GithubSyncQueue"

const GITHUB_CALLBACK_PATH = "/api/integrations/github/callback"
const ADMIN_ROLES = new Set(["root", "org:admin"])
const BACKFILL_WINDOW_MS = 90 * 24 * 60 * 60 * 1000

const requireAdmin = (roles: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		if (roles.some((role) => ADMIN_ROLES.has(role))) return
		yield* Effect.fail(
			new GithubForbiddenError({
				message: "Only org admins can manage integrations",
			}),
		)
	})

const resolveRequestOrigin = (req: HttpServerRequest.HttpServerRequest): string => {
	const headers = req.headers as Record<string, string | undefined>
	const forwardedHost = headers["x-forwarded-host"]
	const forwardedProto = headers["x-forwarded-proto"]
	const host = forwardedHost ?? headers.host
	if (host) {
		const proto =
			forwardedProto ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https")
		return `${proto}://${host}`
	}
	try {
		const parsed = new URL(req.url)
		return `${parsed.protocol}//${parsed.host}`
	} catch {
		return ""
	}
}

export const HttpGithubLive = HttpApiBuilder.group(MapleApi, "github", (handlers) =>
	Effect.gen(function* () {
		const app = yield* GithubAppService
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
					yield* requireAdmin(tenant.roles as ReadonlyArray<string>)
					const req = yield* HttpServerRequest.HttpServerRequest
					const callbackUrl = `${resolveRequestOrigin(req)}${GITHUB_CALLBACK_PATH}`
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
						installations: items.map(
							({ row, repositoryCount }) =>
								new GithubInstallationSummary({
									id: row.id,
									installationId: row.installationId,
									appSlug: row.appSlug,
									accountId: row.accountId,
									accountLogin: row.accountLogin,
									accountAvatarUrl: row.accountAvatarUrl,
									accountType: row.accountType === "Organization" ? "Organization" : "User",
									repositorySelection: row.repositorySelection === "all" ? "all" : "selected",
									suspendedAt: row.suspendedAt,
									installedByUserId: row.installedByUserId,
									createdAt: row.createdAt,
									updatedAt: row.updatedAt,
									repositoryCount,
								}),
						),
					})
				}),
			)
			.handle("githubListRepositories", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const repos = yield* app.listRepositories(tenant.orgId, params.installationId)
					return new GithubRepositoriesListResponse({
						repositories: repos.map(
							(row) =>
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
									backfillStatus:
										row.backfillStatus === "running"
											? "running"
											: row.backfillStatus === "complete"
												? "complete"
												: row.backfillStatus === "failed"
													? "failed"
													: "pending",
									backfillError: row.backfillError,
									commitCount: row.commitCount,
								}),
						),
					})
				}),
			)
			.handle("githubSetRepoSync", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles as ReadonlyArray<string>)
					const result = yield* app.setRepoSyncEnabled({
						orgId: tenant.orgId,
						repositoryId: params.repositoryId,
						enabled: payload.enabled,
					})
					if (payload.enabled) {
						yield* queue.enqueue({
							_tag: "BackfillRepo",
							orgId: tenant.orgId,
							repoId: result.repositoryId,
							sinceUnixMs: Date.now() - BACKFILL_WINDOW_MS,
							cursor: null,
						})
					}
					return new GithubSetRepoSyncResponse(result)
				}),
			)
			.handle("githubBackfillRepo", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles as ReadonlyArray<string>)
					const repo = yield* app.findRepoForBackfill(tenant.orgId, params.repositoryId)
					yield* queue.enqueue({
						_tag: "BackfillRepo",
						orgId: tenant.orgId,
						repoId: repo.id,
						sinceUnixMs: Date.now() - BACKFILL_WINDOW_MS,
						cursor: null,
					})
					return new GithubBackfillRepoResponse({
						repositoryId: repo.id,
						enqueued: true,
					})
				}),
			)
			.handle("githubDisconnect", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles as ReadonlyArray<string>)
					const result = yield* app.disconnectInstallation({
						orgId: tenant.orgId,
						installationId: params.installationId,
					})
					return new GithubDisconnectResponse(result)
				}),
			)
	}),
)

export { GITHUB_CALLBACK_PATH }
