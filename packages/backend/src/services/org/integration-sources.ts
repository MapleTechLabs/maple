import { randomUUID } from "node:crypto"
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
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import { type OrgId, type PullSourcePlatform, SourceId } from "@maple/domain/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Effect, Schema } from "effect"

const decodeSourceIdSync = Schema.decodeUnknownSync(SourceId)

export interface IntegrationSourceInput {
	readonly orgId: OrgId
	readonly platform: PullSourcePlatform
	/** Id of the integration row the source stands for (scrape target, GCP connector, ...). */
	readonly integrationId: string
	readonly name: string
	readonly now: number
}

/** The `src_` id pollers stamp as `maple_source_id`. */
export const publicSourceId = (id: SourceId) => encodePublicId(PublicIdPrefixes.source, id)

/** The integration's source id, created on first use. Safe to race: the unique index decides. */
export const ensureIntegrationSource = Effect.fnUntraced(function* (
	db: MapleDb,
	input: IntegrationSourceInput,
) {
	yield* db.run(
		PG.insertInto(Sources)
			.values({
				id: decodeSourceIdSync(randomUUID()),
				orgId: input.orgId,
				name: input.name,
				description: null,
				platform: input.platform,
				isDefault: false,
				integrationId: input.integrationId,
				keyHash: null,
				keyPrefix: null,
				allowedSignals: null,
				rateLimitRps: null,
				resourceAttributes: [],
				expiresAt: null,
				rolledAt: null,
				createdAt: input.now,
				updatedAt: input.now,
				createdBy: null,
				updatedBy: null,
			})
			.onConflictDoNothing(),
	)
	const rows = yield* db.run(
		PG.from(Sources)
			.select(($) => ({ id: $.id }))
			.where(($) => [
				$.orgId.eq(input.orgId),
				$.platform.eq(input.platform),
				$.integrationId.eq(input.integrationId),
			])
			.limit(1),
	)
	return rows[0]?.id
})

/** A connected integration row as the source it stands for. */
export interface IntegrationLink {
	readonly platform: PullSourcePlatform
	readonly integrationId: string
	readonly name: string
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
			name: target.name,
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
			name: `Google Cloud ${connector.scopeId}`,
			health: (_: IntegrationInventory, now: number) => gcpSourceHealth(connector, now),
		})),
		...rows.railway.map((connection) => ({
			platform: "railway" as const,
			integrationId: connection.id,
			name: connection.workspaceNames ?? "Railway",
			health: providerHealth("railway"),
		})),
		...rows.planetscale.map((connection) => ({
			platform: "planetscale" as const,
			integrationId: connection.id,
			name: `PlanetScale ${connection.psOrganization}`,
			health: providerHealth("planetscale"),
		})),
		...rows.cloudflare.map((connection) => ({
			platform: "cloudflare" as const,
			integrationId: connection.id,
			name: connection.externalAccountName ?? "Cloudflare",
			health: providerHealth("cloudflare"),
		})),
		...rows.github.map((installation) => ({
			platform: "github" as const,
			integrationId: installation.id,
			name: `GitHub ${installation.accountLogin}`,
			health: providerHealth("github"),
		})),
	]
	return links
})
