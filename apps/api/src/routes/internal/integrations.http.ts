import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import {
	CloudflareDisconnectResponse,
	CloudflareHyperdrivesResponse,
	CloudflarePrimeResponse,
	CloudflareStartConnectResponse,
	CloudflareTopTrafficResponse,
	CloudflareTopTrafficRow,
	CloudflareUsageResponse,
	CurrentTenant,
	ExternalUserId,
	GithubDeleteRepositoryResponse,
	GithubDisconnectResponse,
	GithubIntegrationStatus,
	GithubSetPrReviewResponse,
	GithubPrReviewConfigResponse,
	GithubPrReviewSettingsResponse,
	GithubSetTrackedBranchResponse,
	GithubStartConnectResponse,
	HazelChannelsListResponse,
	HazelDisconnectResponse,
	HazelIntegrationStatus,
	HazelOrganizationsListResponse,
	HazelStartConnectResponse,
	IntegrationsForbiddenError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	MapleInternalApi,
	RailwayDisconnectResponse,
	RoleName,
	UserId,
	VCS_COMMIT_DETAILS_MAX_SHAS,
	VCS_COMMIT_RANGES_MAX,
	VcsCommitDetailResponse,
	VCS_PULL_REQUESTS_DEFAULT_LIMIT,
	VcsCommitDetailsResponse,
	VcsCommitRangeResponse,
	VcsCommitRangesResponse,
	VcsPullRequestsResponse,
} from "@maple/domain/http"
import { EdgeCacheService } from "@maple/cache"
import { Effect, Option, Schema } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { graphqlQuery } from "@maple/backend/services/integrations/CloudflareApi"
import { CloudflareAnalyticsService } from "@maple/backend/services/integrations/CloudflareAnalyticsService"
import { CloudflareOAuthService } from "@maple/backend/services/auth/CloudflareOAuthService"
import { abrCount } from "@maple/backend/services/integrations/cloudflare-analytics/mapping"
import {
	decodeTopTrafficResponse,
	toGraphqlTime,
	topTrafficFilterVariables,
	topTrafficQuery,
	type TopTrafficGroupDefinition,
} from "@maple/backend/services/integrations/cloudflare-analytics/queries"
import { RailwayMetricsService } from "@maple/backend/services/integrations/RailwayMetricsService"
import { GithubConnectService } from "@maple/backend/services/integrations/vcs/vendor/github/GithubConnectService"
import { VcsCommitService } from "@maple/backend/services/integrations/vcs/VcsCommitService"
import { VcsSourceService } from "@maple/backend/services/integrations/vcs/VcsSourceService"
import { HazelOAuthService } from "@maple/backend/services/auth/HazelOAuthService"
import { requireAdmin as requireAdminRole } from "@maple/backend/services/auth/auth"
import {
	CLOUDFLARE_CALLBACK_PATH,
	GITHUB_CALLBACK_PATH,
	HAZEL_CALLBACK_PATH,
} from "@/routes/integrations-callback.http"

const asExternalUserId = Schema.decodeUnknownSync(ExternalUserId)
const asUserId = Schema.decodeUnknownSync(UserId)

/**
 * How long `cloudflarePrime` spends on the post-connect poll. Long enough for zone discovery plus
 * a first window on an ordinary account; whatever a slow or many-zoned one does not finish resumes
 * on the next cron tick. It is deliberately NOT on the OAuth callback's critical path — see the
 * callback handler.
 */
const CLOUDFLARE_PRIME_TIMEOUT = "20 seconds"

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
	// Fall back to parsing req.url which is absolute under wrangler/CF Workers.
	return Option.match(Option.liftThrowable(() => new URL(req.url))(), {
		onNone: () => "",
		onSome: (parsed) => `${parsed.protocol}//${parsed.host}`,
	})
}

const resolveCallbackUrl = (req: HttpServerRequest.HttpServerRequest): string =>
	`${resolveRequestOrigin(req)}${HAZEL_CALLBACK_PATH}`

const resolveGithubCallbackUrl = (req: HttpServerRequest.HttpServerRequest): string =>
	`${resolveRequestOrigin(req)}${GITHUB_CALLBACK_PATH}`

const resolveCloudflareCallbackUrl = (req: HttpServerRequest.HttpServerRequest): string =>
	`${resolveRequestOrigin(req)}${CLOUDFLARE_CALLBACK_PATH}`

const requireAdmin = (roles: ReadonlyArray<RoleName>) =>
	requireAdminRole(
		roles,
		() => new IntegrationsForbiddenError({ message: "Only org admins can manage integrations" }),
	)

export const HttpIntegrationsLive = HttpApiBuilder.group(MapleInternalApi, "integrations", (handlers) =>
	Effect.gen(function* () {
		const hazel = yield* HazelOAuthService
		const github = yield* GithubConnectService
		const vcsCommits = yield* VcsCommitService
		const vcsSource = yield* VcsSourceService
		const cloudflare = yield* CloudflareOAuthService
		const cloudflareAnalytics = yield* CloudflareAnalyticsService
		const railway = yield* RailwayMetricsService
		const edgeCache = yield* EdgeCacheService
		const env = yield* Env

		return (
			handlers
				.handle("hazelStatus", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const status = yield* hazel.getStatus(tenant.orgId)
						if (!status.connected) {
							return new HazelIntegrationStatus({
								connected: false,
								externalUserId: null,
								externalUserEmail: null,
								connectedByUserId: null,
								scope: null,
							})
						}
						return new HazelIntegrationStatus({
							connected: true,
							externalUserId: asExternalUserId(status.externalUserId),
							externalUserEmail: status.externalUserEmail,
							connectedByUserId: asUserId(status.connectedByUserId),
							scope: status.scope,
						})
					}),
				)
				.handle("hazelStart", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireAdmin(tenant.roles)
						const req = yield* HttpServerRequest.HttpServerRequest
						const result = yield* hazel.startConnect(tenant.orgId, tenant.userId, {
							callbackUrl: resolveCallbackUrl(req),
							returnTo: payload.returnTo,
						})
						return new HazelStartConnectResponse(result)
					}),
				)
				.handle("hazelOrganizations", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const organizations = yield* hazel.listOrganizations(tenant.orgId)
						return new HazelOrganizationsListResponse({
							organizations: organizations.map((o) => ({
								id: o.id,
								name: o.name,
								slug: o.slug,
								logoUrl: o.logoUrl,
							})),
						})
					}),
				)
				.handle("hazelChannels", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const channels = yield* hazel.listChannels(tenant.orgId, params.organizationId)
						return new HazelChannelsListResponse({
							channels: channels.map((c) => ({
								id: c.id,
								name: c.name,
								type: c.type,
								organizationId: c.organizationId,
							})),
						})
					}),
				)
				.handle("hazelDisconnect", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireAdmin(tenant.roles)
						const result = yield* hazel.disconnect(tenant.orgId)
						return new HazelDisconnectResponse(result)
					}),
				)
				.handle("cloudflareStatus", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						return yield* cloudflareAnalytics.getIntegrationStatus(tenant.orgId)
					}),
				)
				.handle("cloudflareUsage", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						// Two warehouse aggregations per call — 60s edge cache absorbs page-load
						// bursts. The window is server-clocked, so orgId alone keys the entry.
						const cached = yield* edgeCache.getOrCompute(
							{
								bucket: "cf-usage",
								key: tenant.orgId,
								ttlSeconds: 60,
								schema: CloudflareUsageResponse,
							},
							cloudflareAnalytics.getUsage(tenant.orgId),
						)
						return cached.value
					}),
				)
				// No admin gate — any org member may read the inventory (service map needs it).
				// Not connected / never discovered simply reads as an empty config list.
				.handle("cloudflareHyperdrives", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const rows = yield* cloudflareAnalytics.listHyperdriveConfigs(tenant.orgId)
						return new CloudflareHyperdrivesResponse({
							configs: rows.map((row) => ({
								id: row.configId,
								name: row.name,
								originHost: row.originHost,
								originPort: row.originPort,
								originScheme: row.originScheme,
								originDatabase: row.originDatabase,
								originUser: row.originUser,
							})),
						})
					}),
				)
				.handle("cloudflareTopTraffic", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						if (payload.endTime <= payload.startTime) {
							return yield* Effect.fail(
								new IntegrationsValidationError({
									message: "endTime must be after startTime",
								}),
							)
						}
						const limit = Math.min(Math.max(Math.floor(payload.limit ?? 15), 1), 50)
						// Cloudflare applies these before ranking, which is the whole point: the live
						// lookup can reach keys the stored per-window top-N folded into "other".
						const filter = {
							contains: payload.contains?.slice(0, 200),
							hosts: payload.hosts,
							countries: payload.countries,
							methods: payload.methods,
							cacheStatuses: payload.cacheStatuses,
						}
						const filterVariables = topTrafficFilterVariables(filter)
						const isFiltered = Object.keys(filterVariables).length > 0
						// Minute-align the window so repeated dashboard refreshes within the TTL share
						// a cache entry instead of each minting a unique key. Floor the start but CEIL
						// the end (with a one-minute floor on the width): flooring both would collapse
						// a sub-minute window to zero width and cache the resulting empty result.
						const MINUTE = 60_000
						const startMs = Math.floor(payload.startTime / MINUTE) * MINUTE
						const endMs = Math.max(Math.ceil(payload.endTime / MINUTE) * MINUTE, startMs + MINUTE)
						const compute = Effect.gen(function* () {
							// The zone's state row also names the account that owns it, so the token
							// is minted for the right connection when several accounts are connected.
							const zoneRow = yield* cloudflareAnalytics.findHttpZone(
								tenant.orgId,
								payload.zoneName,
							)
							if (zoneRow == null) {
								return yield* Effect.fail(
									new IntegrationsValidationError({
										message: `Unknown Cloudflare zone: ${payload.zoneName}`,
									}),
								)
							}
							const zoneId = zoneRow.zoneId
							const { accessToken } = yield* cloudflare.getValidAccessToken(
								tenant.orgId,
								zoneRow.accountId,
							)
							const result = yield* graphqlQuery(
								accessToken,
								{
									query: topTrafficQuery({ dimension: payload.dimension, limit, filter }),
									variables: {
										zoneTags: [zoneId],
										start: toGraphqlTime(startMs),
										end: toGraphqlTime(endMs),
										...filterVariables,
									},
								},
								env.MAPLE_CLOUDFLARE_API_BASE_URL,
							)
							// GraphQL-level errors here are plan/authz shaped ("dataset not available",
							// window beyond retention) — soft-fail so the card shows an empty state
							// instead of a 5xx toast.
							if (result.errors.length > 0) {
								return new CloudflareTopTrafficResponse({
									rows: [],
									unavailableReason: result.errors
										.map((error) => error.message)
										.join("; ")
										.slice(0, 300),
								})
							}
							const decoded = yield* decodeTopTrafficResponse(result.data).pipe(
								// The card reduces failures to short human copy — keep the real ParseError
								// in the server log so we can see which field of the upstream shape
								// mismatched, matching the OAuth-callback logging pattern above.
								Effect.tapError((error) =>
									Effect.logError("Cloudflare top-traffic response failed to decode", {
										zoneName: payload.zoneName,
										dimension: payload.dimension,
										error: error.message,
									}),
								),
								Effect.mapError(
									() =>
										new IntegrationsUpstreamError({
											message:
												"Cloudflare GraphQL top-traffic response had an unexpected shape",
										}),
								),
							)
							const zone = decoded.viewer.zones?.[0]
							const keyOf = (group: TopTrafficGroupDefinition) =>
								(payload.dimension === "host"
									? group.dimensions.clientRequestHTTPHost
									: group.dimensions.clientRequestPath) ?? "unknown"
							const byKey = new Map<
								string,
								{ requests: number; bytes: number; errors5xx: number }
							>()
							for (const group of zone?.top ?? []) {
								const key = keyOf(group)
								const entry = byKey.get(key) ?? { requests: 0, bytes: 0, errors5xx: 0 }
								entry.requests += abrCount(group.count, group.avg?.sampleInterval)
								entry.bytes += group.sum?.edgeResponseBytes ?? 0
								byKey.set(key, entry)
							}
							for (const group of zone?.errors ?? []) {
								const key = keyOf(group)
								const entry = byKey.get(key) ?? { requests: 0, bytes: 0, errors5xx: 0 }
								entry.errors5xx += abrCount(group.count, group.avg?.sampleInterval)
								byKey.set(key, entry)
							}
							const rows = [...byKey.entries()]
								.map(
									([key, entry]) =>
										new CloudflareTopTrafficRow({
											key,
											requests: entry.requests,
											bytes: entry.bytes,
											errors5xx: entry.errors5xx,
										}),
								)
								.sort((a, b) => b.requests - a.requests)
								.slice(0, limit)
							return new CloudflareTopTrafficResponse({ rows, unavailableReason: null })
						})
						// The filter digest MUST be in the key — a filtered/unfiltered collision would
						// serve one user's drill-down as another's overview. Sorted so two equivalent
						// selections share an entry.
						const filterDigest = isFiltered
							? JSON.stringify(
									Object.fromEntries(
										Object.entries(filterVariables)
											.sort(([a], [b]) => a.localeCompare(b))
											.map(([key, value]) => [
												key,
												Array.isArray(value) ? [...value].sort() : value,
											]),
									),
								)
							: ""
						const cached = yield* edgeCache.getOrCompute(
							{
								bucket: "cf-top-traffic",
								key: `${tenant.orgId}:${payload.zoneName}:${payload.dimension}:${startMs}:${endMs}:${limit}:${filterDigest}`,
								// Filters explode the key space, so hit rate drops exactly when the
								// upstream budget matters most. An ad-hoc drill-down doesn't need
								// 60s freshness — this endpoint shares the poller's Cloudflare quota.
								ttlSeconds: isFiltered ? 300 : 60,
								schema: CloudflareTopTrafficResponse,
							},
							compute,
						)
						return cached.value
					}),
				)
				.handle("cloudflareStart", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireAdmin(tenant.roles)
						const req = yield* HttpServerRequest.HttpServerRequest
						const result = yield* cloudflare.startConnect(tenant.orgId, tenant.userId, {
							callbackUrl: resolveCloudflareCallbackUrl(req),
							returnTo: payload.returnTo,
						})
						return new CloudflareStartConnectResponse(result)
					}),
				)
				.handle("cloudflareDisconnect", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireAdmin(tenant.roles)
						const result = yield* cloudflare.disconnect(tenant.orgId)
						return new CloudflareDisconnectResponse(result)
					}),
				)
				.handle("cloudflarePrime", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireAdmin(tenant.roles)
						// Discovery (the part that stops the integration looking empty) commits in
						// the first seconds; the rest spends what call budget it has on the newest
						// window. Timing out is an ordinary outcome, not a failure — the cron picks
						// up where this left off, and a lease dropped by the timeout expires.
						const summary = yield* Effect.timeoutOption(
							cloudflareAnalytics.pollOrg(tenant.orgId),
							CLOUDFLARE_PRIME_TIMEOUT,
						)
						// A prime that arrives before the callback committed the grant polls nothing.
						// Reporting that plainly lets the dashboard retry rather than assume it ran.
						return new CloudflarePrimeResponse({
							connected: Option.match(summary, {
								onNone: () => true,
								onSome: (value) => value.skipped !== "not connected",
							}),
							complete: Option.isSome(summary),
						})
					}),
				)
				.handle("railwayStatus", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						return yield* railway.getStatus(tenant.orgId)
					}),
				)
				.handle("railwayConnect", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireAdmin(tenant.roles)
						return yield* railway.connect(tenant.orgId, tenant.userId, payload.token)
					}),
				)
				.handle("railwaySync", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						// Spends the org's per-token Railway quota, so it is an admin action like connect.
						yield* requireAdmin(tenant.roles)
						return yield* railway.sync(tenant.orgId)
					}),
				)
				.handle("railwayDisconnect", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireAdmin(tenant.roles)
						return new RailwayDisconnectResponse(yield* railway.disconnect(tenant.orgId))
					}),
				)
				.handle("githubStatus", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const status = yield* github.getStatus(tenant.orgId)
						return new GithubIntegrationStatus({
							connected: status.connected,
							state: status.state,
							accountLogin: status.accountLogin,
							accountType: status.accountType,
							repositorySelection: status.repositorySelection,
							repositories: status.repositories,
						})
					}),
				)
				.handle("githubStart", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireAdmin(tenant.roles)
						const req = yield* HttpServerRequest.HttpServerRequest
						const result = yield* github.startConnect(tenant.orgId, tenant.userId, {
							callbackUrl: resolveGithubCallbackUrl(req),
							returnTo: payload.returnTo,
						})
						return new GithubStartConnectResponse(result)
					}),
				)
				.handle("githubDisconnect", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireAdmin(tenant.roles)
						const result = yield* github.disconnect(tenant.orgId)
						return new GithubDisconnectResponse(result)
					}),
				)
				.handle("githubDeleteRepository", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireAdmin(tenant.roles)
						const result = yield* github.deleteRepository(tenant.orgId, params.repositoryId)
						return new GithubDeleteRepositoryResponse(result)
					}),
				)
				.handle("githubSetTrackedBranch", ({ params, payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireAdmin(tenant.roles)
						const result = yield* github.setTrackedBranch(
							tenant.orgId,
							params.repositoryId,
							payload.trackedBranch,
						)
						return new GithubSetTrackedBranchResponse(result)
					}),
				)
				.handle("githubSetPrReview", ({ params, payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireAdmin(tenant.roles)
						const result = yield* github.setPrReviewEnabled(
							tenant.orgId,
							params.repositoryId,
							payload.enabled,
						)
						return new GithubSetPrReviewResponse(result)
					}),
				)
				// Any member may read a repository's review settings and history; only admins change them.
				.handle("githubGetPrReviewConfig", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const config = yield* github.getPrReviewConfig(tenant.orgId, params.repositoryId)
						return new GithubPrReviewConfigResponse({ config })
					}),
				)
				.handle("githubSetPrReviewConfig", ({ params, payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireAdmin(tenant.roles)
						const config = yield* github.setPrReviewConfig(
							tenant.orgId,
							params.repositoryId,
							payload.config,
						)
						return new GithubPrReviewConfigResponse({ config })
					}),
				)
				.handle("githubGetPrReviewSettings", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const settings = yield* github.getPrReviewSettings(tenant.orgId)
						return new GithubPrReviewSettingsResponse({ settings })
					}),
				)
				.handle("githubSetPrReviewSettings", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireAdmin(tenant.roles)
						const settings = yield* github.setPrReviewSettings(
							tenant.orgId,
							payload.settings,
							tenant.userId,
						)
						return new GithubPrReviewSettingsResponse({ settings })
					}),
				)
				// No admin gate — any org member may resolve commit SHAs for hover cards.
				.handle("vcsCommitDetail", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const detail = yield* vcsCommits.resolveCommitDetail(tenant.orgId, params.sha)
						return new VcsCommitDetailResponse(detail)
					}),
				)
				.handle("vcsCommitDetails", ({ query }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const shas = query.shas
							.split(",")
							.map((sha) => sha.trim())
							.filter((sha) => sha.length > 0)
							.slice(0, VCS_COMMIT_DETAILS_MAX_SHAS)
						const details = yield* vcsCommits.resolveCommitDetails(tenant.orgId, shas)
						return new VcsCommitDetailsResponse({
							commits: details.map((detail) => new VcsCommitDetailResponse(detail)),
						})
					}),
				)
				.handle("vcsCommitRanges", ({ query }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const ranges = query.ranges
							.split(",")
							.flatMap((pair) => {
								const [base, head] = pair.trim().split("..")
								return base && head ? [{ base, head }] : []
							})
							.slice(0, VCS_COMMIT_RANGES_MAX)
						const results = yield* vcsCommits.resolveCommitRanges(tenant.orgId, ranges, {
							limit: query.limit ?? 20,
						})
						return new VcsCommitRangesResponse({
							ranges: results.map(
								(range) =>
									new VcsCommitRangeResponse({
										...range,
										commits: range.commits.map(
											(detail) => new VcsCommitDetailResponse(detail),
										),
									}),
							),
						})
					}),
				)
				.handle("vcsPullRequests", ({ query }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* Effect.annotateCurrentSpan({
							orgId: tenant.orgId,
							"vcs.repository.full_name": query.repository,
						})
						const pullRequests = yield* vcsSource
							.listPullRequests(tenant.orgId, query.repository, {
								limit: query.limit ?? VCS_PULL_REQUESTS_DEFAULT_LIMIT,
							})
							.pipe(
								// A repository this org has not connected is a client mistake, not
								// an upstream one — the picker only ever offers connected repos, so
								// reaching here means a hand-built request or a repo disconnected
								// mid-session.
								Effect.catchTag(
									"@maple/api/vcs/VcsSourceRepositoryNotFoundError",
									(error) => new IntegrationsValidationError({ message: error.message }),
								),
							)
						yield* Effect.annotateCurrentSpan({ "result.rowCount": pullRequests.length })
						return new VcsPullRequestsResponse({
							repository: query.repository,
							pullRequests,
						})
					}).pipe(Effect.withSpan("HttpIntegrations.vcsPullRequests")),
				)
		)
	}),
)
