import * as PG from "@maple-dev/effect-orm/postgres"
import {
	AwsConnections,
	ChatWorkspaces,
	CloudflareAnalyticsState,
	CloudflareHyperdriveConfigs,
	CloudflareLogpushConnectors,
	GcpConnectors,
	GcpResources,
	OAuthConnections,
	PlanetscaleConnections,
	PlanetscaleDatabases,
	PlanetscalePollState,
	RailwayConnections,
	SearchConsoleSites,
	RailwayEnvironments,
	ScrapeTargets,
	Sources,
	SupabaseConnections,
	SupabaseProjects,
	VcsInstallations,
	VcsRepositories,
	VercelConnections,
	VercelProjects,
} from "@maple/db/tables"
import type { IntegrationInventory } from "@maple/domain/integration-inventory"
import { buildIntegrationInventory, withSourceHealth } from "./integration-inventory"
import type { OrgId } from "@maple/primitives"
import { Clock, Context, Effect, Layer, Option, Schema, Array as Arr, Record as Rec } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { readHealthOverrides } from "@maple/backend/services/integrations/integration-sources"
import { SOURCE_HEALTH_COLUMNS, sourceRowHealth } from "@maple/backend/services/org/source-rows"

export class IntegrationInventoryUnavailableError extends Schema.TaggedError<IntegrationInventoryUnavailableError>()(
	"@maple/backend/services/IntegrationInventoryUnavailableError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

const decodeServices = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
)

export interface IntegrationInventoryServiceApi {
	/** Every connected integration with its health, from config and poller state only (no provider calls). */
	readonly list: (orgId: OrgId) => Effect.Effect<IntegrationInventory, IntegrationInventoryUnavailableError>
}

const make: Effect.Effect<IntegrationInventoryServiceApi, never, Database> = Effect.gen(function* () {
	const database = yield* Database
	const dbExecute = makeDbExecute(
		database,
		"IntegrationInventoryService",
		(error) =>
			new IntegrationInventoryUnavailableError({
				message: "Integration state could not be read",
				cause: error,
			}),
	)

	// Narrow projections only: no token or secret column is ever selected.
	const list = Effect.fn("IntegrationInventoryService.list")(function* (orgId: OrgId) {
		const rows = yield* dbExecute((db) =>
			Effect.all(
				{
					oauthConnections: db.run(
						PG.from(OAuthConnections)
							.select(
								"provider",
								"externalAccountName",
								"externalUserEmail",
								"revokedAt",
								"createdAt",
							)
							.where(($) => [$.orgId.eq(orgId)]),
					),
					vcsInstallations: db.run(
						PG.from(VcsInstallations)
							.select("provider", "accountLogin", "status", "ciTracesEnabled", "createdAt")
							.where(($) => [$.orgId.eq(orgId)]),
					),
					vcsRepositories: db.run(
						PG.from(VcsRepositories)
							.select(
								"provider",
								"fullName",
								"syncStatus",
								"lastSyncedAt",
								"lastSyncError",
								"defaultBranch",
								"trackedBranch",
								"prReviewEnabled",
							)
							.where(($) => [$.orgId.eq(orgId), $.status.eq("active")]),
					),
					cloudflareStates: db.run(
						PG.from(CloudflareAnalyticsState)
							.select("dataset", "zoneName", "lastSuccessAt", "lastErrorAt", "lastError")
							.where(($) => [$.orgId.eq(orgId), $.enabled.eq(true)]),
					),
					cloudflareLogpush: db.run(
						PG.from(CloudflareLogpushConnectors)
							.select("name", "zoneName", "serviceName", "lastReceivedAt", "lastError")
							.where(($) => [$.orgId.eq(orgId), $.enabled.eq(true)]),
					),
					cloudflareHyperdrives: db.run(
						PG.from(CloudflareHyperdriveConfigs)
							.select("name", "originScheme", "originHost", "originDatabase")
							.where(($) => [$.orgId.eq(orgId), $.deletedAt.isNull()]),
					),
					gcpConnectors: db.run(
						PG.from(GcpConnectors)
							.select(
								"id",
								"scopeType",
								"scopeId",
								"logsEnabled",
								"metricsEnabled",
								"lastReceivedAt",
								"lastError",
								"appliedLogsEnabled",
								"appliedMetricsEnabled",
								"setupReportedAt",
								"lastMetricsReceivedAt",
								"lastMetricsError",
								"resourcesSyncedAt",
								"lastResourcesError",
								"createdAt",
							)
							.where(($) => [$.orgId.eq(orgId)]),
					),
					gcpResourceCounts: db.run(
						PG.from(GcpResources)
							.select(($) => ({
								connectorId: $.connectorId,
								assetType: $.assetType,
								count: PG.count(),
							}))
							.where(($) => [$.orgId.eq(orgId)])
							.groupBy("connectorId", "assetType"),
					),
					awsConnections: db.run(
						PG.from(AwsConnections)
							.select(
								"accountId",
								"modules",
								"grantedModules",
								"templateVersion",
								"verifiedAt",
								"lastCheckedAt",
								"lastCheckError",
								"metricStream",
								"metricStreamChangedAt",
								"streamLastReceivedAt",
								"streamLastError",
								"createdAt",
							)
							.where(($) => [$.orgId.eq(orgId)]),
					),
					supabaseConnections: db.run(
						PG.from(SupabaseConnections)
							.select(
								"id",
								"supabaseOrganizationName",
								"lastDiscoveryAt",
								"lastDiscoveryError",
								"createdAt",
							)
							.where(($) => [$.orgId.eq(orgId)])
							.limit(1),
					),
					supabaseProjects: db.run(
						PG.from(SupabaseProjects)
							.select(
								"connectionId",
								"name",
								"region",
								"status",
								"logDrainEnabled",
								"logDrainError",
								"logsEnabled",
								"logsLastPolledAt",
								"logsError",
							)
							.where(($) => [$.orgId.eq(orgId), $.removedAt.isNull()]),
					),
					railwayConnections: db.run(
						PG.from(RailwayConnections)
							.select(
								"workspaceNames",
								"authFailedAt",
								"lastSuccessAt",
								"lastErrorAt",
								"lastError",
								"createdAt",
							)
							.where(($) => [$.orgId.eq(orgId)])
							.limit(1),
					),
					railwayEnvironments: db.run(
						PG.from(RailwayEnvironments)
							.select(
								"projectName",
								"environmentName",
								"servicesJson",
								"lastSuccessAt",
								"lastErrorAt",
								"lastError",
							)
							.where(($) => [$.orgId.eq(orgId), $.enabled.eq(true)]),
					),
					vercelConnections: db.run(
						PG.from(VercelConnections)
							.select(
								"teamName",
								"authFailedAt",
								"logsEnabled",
								"tracesEnabled",
								"aiGatewayEnabled",
								"speedInsightsEnabled",
								"webAnalyticsEnabled",
								"auditLogEnabled",
								"logDrainState",
								"traceDrainState",
								"aiGatewayDrainState",
								"speedInsightsDrainState",
								"webAnalyticsDrainState",
								"auditLogDrainState",
								"lastSuccessAt",
								"lastErrorAt",
								"lastError",
								"createdAt",
							)
							.where(($) => [$.orgId.eq(orgId)])
							.limit(1),
					),
					vercelProjects: db.run(
						PG.from(VercelProjects)
							.select(() => ({ count: PG.count() }))
							.where(($) => [
								$.orgId.eq(orgId),
								// Only the current connection's: rows a disconnect raced with do not count.
								PG.inSubquery(
									$.connectionId,
									PG.from(VercelConnections)
										.select("id")
										.where(($c) => [$c.orgId.eq(orgId)]),
								),
							]),
					),
					planetscaleConnections: db.run(
						PG.from(PlanetscaleConnections)
							.select(
								"psOrganization",
								"detectedPermissionsJson",
								"lastInventoryAt",
								"lastInventoryError",
								"createdAt",
							)
							.where(($) => [$.orgId.eq(orgId)])
							.limit(1),
					),
					planetscaleDatabases: db.run(
						PG.from(PlanetscaleDatabases)
							.select("databaseId", "name", "kind", "region", "state")
							.where(($) => [$.orgId.eq(orgId), $.deletedAt.isNull()]),
					),
					planetscalePollStates: db.run(
						PG.from(PlanetscalePollState)
							.select("databaseId", "lastSuccessAt", "lastErrorAt", "lastError")
							.where(($) => [$.orgId.eq(orgId), $.enabled.eq(true)]),
					),
					scrapeTargets: db.run(
						PG.from(ScrapeTargets)
							.select(
								"name",
								"url",
								"serviceName",
								"managedBy",
								"scrapeIntervalSeconds",
								"lastScrapeAt",
								"lastScrapeError",
								"enabled",
							)
							// A user's switched-off target is still configured; a managed one waits on its connection.
							.where(($) => [
								$.orgId.eq(orgId),
								PG.or($.enabled.eq(true), $.managedBy.isNull()),
							]),
					),
					chatWorkspaces: db.run(
						PG.from(ChatWorkspaces)
							.select("connector", "name", "createdAt")
							.where(($) => [$.orgId.eq(orgId)]),
					),
					searchConsoleSites: db.run(
						PG.from(SearchConsoleSites)
							.select("siteUrl", "enabled", "lastSyncedAt", "lastError")
							.where(($) => [$.orgId.eq(orgId)]),
					),
					sources: db.run(
						PG.from(Sources)
							.select(...SOURCE_HEALTH_COLUMNS)
							.where(($) => [$.orgId.eq(orgId), $.kind.eq("integration")]),
					),
				},
				{ concurrency: "unbounded" },
			),
		)

		const now = yield* Clock.currentTimeMillis
		const planetscale = rows.planetscaleConnections[0]
		const supabase = rows.supabaseConnections[0]
		const inventory = buildIntegrationInventory(
			{
				oauthConnections: rows.oauthConnections,
				vcsInstallations: rows.vcsInstallations,
				vcsRepositories: rows.vcsRepositories,
				cloudflareStates: rows.cloudflareStates,
				cloudflareLogpush: rows.cloudflareLogpush,
				cloudflareHyperdrives: rows.cloudflareHyperdrives,
				gcpConnectors: rows.gcpConnectors,
				gcpResourceCounts: rows.gcpResourceCounts,
				awsConnections: rows.awsConnections,
				supabaseConnection:
					supabase === undefined
						? null
						: {
								organizationName: supabase.supabaseOrganizationName,
								lastDiscoveryAt: supabase.lastDiscoveryAt,
								lastDiscoveryError: supabase.lastDiscoveryError,
								createdAt: supabase.createdAt,
							},
				// Only the current connection's: rows a disconnect raced with do not count.
				supabaseProjects: Arr.filter(
					rows.supabaseProjects,
					(project) => project.connectionId === supabase?.id,
				),
				railwayConnection: rows.railwayConnections[0] ?? null,
				railwayEnvironments: Arr.map(rows.railwayEnvironments, ({ servicesJson, ...env }) => ({
					...env,
					serviceCount: Rec.keys(Option.getOrElse(decodeServices(servicesJson), () => ({}))).length,
				})),
				vercelConnection: rows.vercelConnections[0] ?? null,
				vercelProjectCount: rows.vercelProjects[0]?.count ?? 0,
				planetscaleConnection:
					planetscale === undefined
						? null
						: {
								psOrganization: planetscale.psOrganization,
								detectedPermissions: planetscale.detectedPermissionsJson,
								lastInventoryAt: planetscale.lastInventoryAt,
								lastInventoryError: planetscale.lastInventoryError,
								createdAt: planetscale.createdAt,
							},
				// The org-wide inventory anchor row (databaseId "") is reported by the connection itself.
				planetscaleDatabases: rows.planetscaleDatabases,
				planetscalePollStates: Arr.filter(
					rows.planetscalePollStates,
					(state) => state.databaseId !== "",
				),
				scrapeTargets: rows.scrapeTargets,
				chatWorkspaces: rows.chatWorkspaces,
				searchConsoleSites: rows.searchConsoleSites,
			},
			now,
		)
		const overrides = yield* dbExecute((db) => readHealthOverrides(db, orgId, now))
		return withSourceHealth(
			inventory,
			Arr.map(rows.sources, (source) => ({
				platform: source.platform,
				health: sourceRowHealth(source, now, overrides.get(source.id)),
			})),
		)
	})

	return { list } satisfies IntegrationInventoryServiceApi
})

export class IntegrationInventoryService extends Context.Service<
	IntegrationInventoryService,
	IntegrationInventoryServiceApi
>()("@maple/backend/services/IntegrationInventoryService", { make }) {
	static readonly layer = Layer.effect(this, this.make)
}
