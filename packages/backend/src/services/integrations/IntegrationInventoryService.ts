import * as PG from "@maple-dev/effect-orm/postgres"
import {
	ChatWorkspaces,
	CloudflareAnalyticsState,
	CloudflareHyperdriveConfigs,
	CloudflareLogpushConnectors,
	OAuthConnections,
	PlanetscaleConnections,
	PlanetscaleDatabases,
	PlanetscalePollState,
	RailwayConnections,
	RailwayEnvironments,
	ScrapeTargets,
	Sources,
	VcsInstallations,
	VcsRepositories,
} from "@maple/db/tables"
import {
	buildIntegrationInventory,
	type IntegrationInventory,
	withSourceHealth,
} from "@maple/domain/integration-inventory"
import type { OrgId } from "@maple/domain/primitives"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { readHealthOverrides } from "@maple/backend/services/org/integration-sources"
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
		const inventory = buildIntegrationInventory(
			{
				oauthConnections: rows.oauthConnections,
				vcsInstallations: rows.vcsInstallations,
				vcsRepositories: rows.vcsRepositories,
				cloudflareStates: rows.cloudflareStates,
				cloudflareLogpush: rows.cloudflareLogpush,
				cloudflareHyperdrives: rows.cloudflareHyperdrives,
				railwayConnection: rows.railwayConnections[0] ?? null,
				railwayEnvironments: rows.railwayEnvironments.map(({ servicesJson, ...env }) => ({
					...env,
					serviceCount: Object.keys(Option.getOrElse(decodeServices(servicesJson), () => ({})))
						.length,
				})),
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
				planetscalePollStates: rows.planetscalePollStates.filter((state) => state.databaseId !== ""),
				scrapeTargets: rows.scrapeTargets,
				chatWorkspaces: rows.chatWorkspaces,
			},
			now,
		)
		const overrides = yield* dbExecute((db) => readHealthOverrides(db, orgId, now))
		return withSourceHealth(
			inventory,
			rows.sources.map((source) => ({
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
>()("@maple/api/services/IntegrationInventoryService", { make }) {
	static readonly layer = Layer.effect(this, this.make)
}
