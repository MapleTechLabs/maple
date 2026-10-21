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
	githubInstallationHealth,
	integrationSourceHealth,
	scrapeTargetSourceHealth,
	type SourceHealthResult,
} from "@maple/domain/source-health"
import { SourcePublicId } from "@maple/domain/http/v2"
import type { OrgId, PullSourcePlatform, SourceId } from "@maple/domain/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Effect, Schema } from "effect"
import { newSourceId, type PullSourceRef, pullSourceRow } from "./source-rows"

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

/**
 * The source an integration row sends as: an existing one for the same integration, or a new
 * one. Call it inside the transaction that writes the row's `source_id`.
 */
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
	// A concurrent connect may insert first: the unique index settles it, and the winner's id is read back.
	const id = newSourceId()
	yield* db.run(
		PG.insertInto(Sources)
			.values({ ...pullSourceRow(orgId, ref, now), id })
			.onConflictDoNothing(),
	)
	return (yield* select)[0]?.id ?? id
})

/**
 * Deletes the integration sources of `rows` and, through `ON DELETE CASCADE`, every row that still
 * sends as them. `platform` limits it to sources of that platform.
 */
export const deleteSourcesOf = (
	db: MapleDb,
	orgId: OrgId,
	rows: ReadonlyArray<{ readonly sourceId: SourceId | null }>,
	platform?: PullSourcePlatform,
) => {
	const ids = rows.flatMap((row) => (row.sourceId === null ? [] : [row.sourceId]))
	return ids.length === 0
		? Effect.void
		: db
				.run(
					PG.deleteFrom(Sources).where(($) => [
						$.orgId.eq(orgId),
						PG.inList($.id, ids),
						$.kind.eq("integration"),
						platform === undefined ? undefined : $.platform.eq(platform),
					]),
				)
				.pipe(Effect.asVoid)
}

/** The `src_` id a row stamps as `maple_source_id`; undefined for a row not linked yet. */
export const stampedSourceId = (sourceId: SourceId | null) =>
	sourceId === null ? undefined : publicSourceId(sourceId)

/** A connected integration row as the source it stands for. */
export interface IntegrationLink extends PullSourceRef {
	/** `inventory` is null when it could not be read. */
	readonly health: (inventory: IntegrationInventory | null, now: number) => SourceHealthResult
}

const HEALTH_UNAVAILABLE: SourceHealthResult = {
	status: "pending",
	lastDataAt: null,
	problem: "Integration health is unavailable right now",
}

const providerHealth = (provider: IntegrationProvider) => (inventory: IntegrationInventory | null) =>
	inventory === null
		? HEALTH_UNAVAILABLE
		: integrationSourceHealth(inventory.integrations.find((entry) => entry.provider === provider))

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
					.select("id", "accountLogin", "status")
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
			health: (_: IntegrationInventory | null, now: number): SourceHealthResult =>
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
			health: (_: IntegrationInventory | null, now: number) => gcpSourceHealth(connector, now),
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
			// Installations come and go one by one; a suspended or removed one is its own problem.
			health: (inventory: IntegrationInventory | null) =>
				installation.status !== "active"
					? {
							status: "disconnected" as const,
							lastDataAt: null,
							problem: `The GitHub installation is ${installation.status}`,
						}
					: inventory === null
						? HEALTH_UNAVAILABLE
						: githubInstallationHealth(
								inventory.integrations.find((entry) => entry.provider === "github"),
								installation.accountLogin,
							),
		})),
	]
	return links
})
