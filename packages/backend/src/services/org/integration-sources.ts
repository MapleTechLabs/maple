import type { MapleDb } from "@maple/db/client"
import {
	GcpConnectors,
	OAuthConnections,
	PlanetscaleConnections,
	RailwayConnections,
	ScrapeTargets,
	Sources,
	VcsInstallations,
} from "@maple/db/tables"
import type { IntegrationInventory, IntegrationProvider } from "@maple/domain/integration-inventory"
import {
	gcpSourceHealth,
	integrationSourceHealth,
	scrapeTargetSourceHealth,
	type SourceHealthResult,
} from "@maple/domain/source-health"
import { SourcePublicId } from "@maple/domain/http/v2"
import type { OrgId, PullSourcePlatform, SourceId } from "@maple/domain/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Effect, Schema } from "effect"
import { type PullSourceRef, pullSourceRow } from "./source-rows"

const encodeSourceId = Schema.encodeSync(SourcePublicId)

/** The `src_` id pollers stamp as `maple_source_id`. */
export const publicSourceId = (id: SourceId) => encodeSourceId(id)

/** Display names for integration sources, shared by reconcile and the pollers. */
export const integrationSourceName = {
	prometheus: (target: { readonly name: string }) => target.name,
	gcp: (connector: { readonly scopeId: string }) => `Google Cloud ${connector.scopeId}`,
	railway: (connection: { readonly workspaceNames: string | null }) =>
		connection.workspaceNames ?? "Railway",
	planetscale: (organization: string | undefined) =>
		organization === undefined ? "PlanetScale" : `PlanetScale ${organization}`,
	cloudflare: (connection: { readonly externalAccountName: string | null }) =>
		connection.externalAccountName ?? "Cloudflare",
	github: (installation: { readonly accountLogin: string }) => `GitHub ${installation.accountLogin}`,
}

/** The integration's source id. Reads first, inserts only on first use; the unique index settles races. */
export const ensureIntegrationSource = Effect.fnUntraced(function* (
	db: MapleDb,
	orgId: OrgId,
	ref: PullSourceRef,
	now: number,
) {
	const select = db.run(
		PG.from(Sources)
			.select(($) => ({ id: $.id }))
			.where(($) => [
				$.orgId.eq(orgId),
				$.platform.eq(ref.platform),
				$.integrationId.eq(ref.integrationId),
			])
			.limit(1),
	)
	const existing = yield* select
	if (existing[0] !== undefined) return existing[0].id
	yield* db.run(
		PG.insertInto(Sources)
			.values(pullSourceRow(orgId, ref, now))
			.onConflictDoNothing(),
	)
	return (yield* select)[0]?.id
})

/**
 * The `src_` id a poller stamps, or undefined. Attribution is best effort: a failed lookup
 * logs a warning and the data goes out without `maple_source_id`.
 */
export const stampableSourceId = <E extends { readonly message: string }, R>(
	lookup: Effect.Effect<SourceId | undefined, E, R>,
	context: { readonly orgId: OrgId; readonly platform: PullSourcePlatform },
) =>
	lookup.pipe(
		Effect.map((id) => (id === undefined ? undefined : publicSourceId(id))),
		Effect.tap((id) =>
			id === undefined ? Effect.void : Effect.annotateCurrentSpan("maple.source.id", id),
		),
		Effect.catch((error) =>
			Effect.logWarning("Integration source unavailable").pipe(
				Effect.annotateLogs({ ...context, error: error.message }),
				Effect.as(undefined),
			),
		),
	)

/** A connected integration row as the source it stands for. */
export interface IntegrationLink extends PullSourceRef {
	readonly health: (inventory: IntegrationInventory, now: number) => SourceHealthResult
}

const providerHealth = (provider: IntegrationProvider) => (inventory: IntegrationInventory) =>
	integrationSourceHealth(inventory.integrations.find((entry) => entry.provider === provider))

/** Every integration row that should have a source. Narrow projections: no secret is selected. */
export const readIntegrationLinks = Effect.fnUntraced(function* (db: MapleDb, orgId: OrgId) {
	const rows = yield* Effect.all(
		{
			scrapeTargets: db.run(
				PG.from(ScrapeTargets)
					.select(
						"id",
						"name",
						"url",
						"serviceName",
						"managedBy",
						"scrapeIntervalSeconds",
						"lastScrapeAt",
						"lastScrapeError",
						"enabled",
					)
					.where(($) => [$.orgId.eq(orgId), $.managedBy.isNull()]),
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
						"lastMetricsReceivedAt",
						"lastMetricsError",
					)
					.where(($) => [$.orgId.eq(orgId)]),
			),
			railway: db.run(
				PG.from(RailwayConnections)
					.select("id", "workspaceNames")
					.where(($) => [$.orgId.eq(orgId)]),
			),
			planetscale: db.run(
				PG.from(PlanetscaleConnections)
					.select("id", "psOrganization")
					.where(($) => [$.orgId.eq(orgId)]),
			),
			cloudflare: db.run(
				PG.from(OAuthConnections)
					.select("id", "externalAccountName")
					.where(($) => [$.orgId.eq(orgId), $.provider.eq("cloudflare")]),
			),
			github: db.run(
				PG.from(VcsInstallations)
					.select("id", "accountLogin")
					.where(($) => [$.orgId.eq(orgId), $.provider.eq("github")]),
			),
		},
		{ concurrency: "unbounded" },
	)
	const links: ReadonlyArray<IntegrationLink> = [
		...rows.scrapeTargets.map((target) => ({
			platform: "prometheus" as const,
			integrationId: target.id,
			name: integrationSourceName.prometheus(target),
			health: (_: IntegrationInventory, now: number): SourceHealthResult =>
				target.enabled
					? scrapeTargetSourceHealth(target, now)
					: {
							status: "paused",
							lastDataAt: target.lastScrapeAt,
							problem: "Scraping is turned off",
						},
		})),
		...rows.gcpConnectors.map((connector) => ({
			platform: "gcp" as const,
			integrationId: connector.id,
			name: integrationSourceName.gcp(connector),
			health: (_: IntegrationInventory, now: number) => gcpSourceHealth(connector, now),
		})),
		...rows.railway.map((connection) => ({
			platform: "railway" as const,
			integrationId: connection.id,
			name: integrationSourceName.railway(connection),
			health: providerHealth("railway"),
		})),
		...rows.planetscale.map((connection) => ({
			platform: "planetscale" as const,
			integrationId: connection.id,
			name: integrationSourceName.planetscale(connection.psOrganization),
			health: providerHealth("planetscale"),
		})),
		...rows.cloudflare.map((connection) => ({
			platform: "cloudflare" as const,
			integrationId: connection.id,
			name: integrationSourceName.cloudflare(connection),
			health: providerHealth("cloudflare"),
		})),
		...rows.github.map((installation) => ({
			platform: "github" as const,
			integrationId: installation.id,
			name: integrationSourceName.github(installation),
			health: providerHealth("github"),
		})),
	]
	return links
})
