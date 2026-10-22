import { type OrgId, type Source, SourcePersistenceError } from "@maple/domain/http"
import type { SourceId } from "@maple/domain/primitives"
import { GcpConnectors, ScrapeTargets, Sources, VcsInstallations } from "@maple/db/tables"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Context, Effect, Layer } from "effect"
import { Database, type DatabaseError } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { CloudflareOAuthService } from "@maple/backend/services/auth/CloudflareOAuthService"
import { SourcesService } from "@maple/backend/services/org/SourcesService"
import { GcpConnectorService } from "./GcpConnectorService"
import { PlanetScaleConnectionService } from "./PlanetScaleConnectionService"
import { RailwayMetricsService } from "./RailwayMetricsService"
import { ScrapeTargetsService } from "./ScrapeTargetsService"
import { SupabaseConnectionService } from "./SupabaseConnectionService"
import { VcsRepository } from "./vcs/VcsRepository"

const toPersistenceError = (error: DatabaseError) => new SourcePersistenceError({ message: error.message })

const disconnectFailed = (error: { readonly message: string }) =>
	new SourcePersistenceError({ message: `Disconnecting the integration failed: ${error.message}` })

export interface SourceRemoval {
	readonly source: Source
	/** Google Cloud only: the script that removes what its setup created in the project. */
	readonly cleanupScript: string | null
}

/**
 * Deletes any source but the default one. An integration source is deleted by disconnecting the
 * integration it stands for, so its credential, upstream setup and polling go with it; deleting
 * the row alone would leave the integration collecting.
 */
export class SourceRemovalService extends Context.Service<SourceRemovalService>()(
	"@maple/api/services/SourceRemovalService",
	{
		make: Effect.gen(function* () {
			const dbExecute = makeDbExecute(yield* Database, "SourceRemovalService", toPersistenceError)
			const sources = yield* SourcesService
			const scrapeTargets = yield* ScrapeTargetsService
			const gcp = yield* GcpConnectorService
			const cloudflare = yield* CloudflareOAuthService
			const railway = yield* RailwayMetricsService
			const planetscale = yield* PlanetScaleConnectionService
			const supabase = yield* SupabaseConnectionService
			const vcs = yield* VcsRepository

			const scrapeTargetsOf = (orgId: OrgId, sourceId: SourceId) =>
				dbExecute((db) =>
					db.run(
						PG.from(ScrapeTargets)
							.select("id")
							.where(($) => [$.orgId.eq(orgId), $.sourceId.eq(sourceId), $.managedBy.isNull()]),
					),
				)
			const gcpConnectorsOf = (orgId: OrgId, sourceId: SourceId) =>
				dbExecute((db) =>
					db.run(
						PG.from(GcpConnectors)
							.select("id")
							.where(($) => [$.orgId.eq(orgId), $.sourceId.eq(sourceId)]),
					),
				)
			const installationsOf = (orgId: OrgId, sourceId: SourceId) =>
				dbExecute((db) =>
					db.run(
						PG.from(VcsInstallations)
							.select("id")
							.where(($) => [$.orgId.eq(orgId), $.sourceId.eq(sourceId)]),
					),
				)

			/** Disconnects what sends as `source`; Google Cloud answers with its cleanup script. */
			const disconnect = Effect.fnUntraced(function* (orgId: OrgId, source: Source) {
				// Platforms with several records per org disconnect only the ones sending as this source.
				switch (source.platform) {
					case "prometheus": {
						const targets = yield* scrapeTargetsOf(orgId, source.id)
						yield* Effect.forEach(
							targets,
							(target) =>
								scrapeTargets
									.delete(orgId, target.id)
									.pipe(
										Effect.catchTag(
											"@maple/http/errors/ScrapeTargetNotFoundError",
											() => Effect.void,
										),
									),
							{ discard: true },
						)
						return null
					}
					case "gcp": {
						const connectors = yield* gcpConnectorsOf(orgId, source.id)
						const scripts = yield* Effect.forEach(connectors, (connector) =>
							gcp.delete(orgId, connector.id).pipe(
								Effect.map((deleted) => deleted.cleanupScript),
								Effect.catchTag("@maple/http/errors/IntegrationsNotFoundError", () =>
									Effect.succeed(null),
								),
							),
						)
						return scripts.find((script) => script !== null) ?? null
					}
					case "github": {
						const installations = yield* installationsOf(orgId, source.id)
						yield* Effect.forEach(
							installations,
							(installation) => vcs.purgeInstallation(orgId, installation.id),
							{ discard: true },
						)
						return null
					}
				}
				// The rest have one connection per org, disconnected only while it still sends as this source.
				if (source.integrationId === null) return null
				switch (source.platform) {
					case "cloudflare":
						yield* cloudflare.disconnect(orgId)
						break
					case "railway":
						yield* railway.disconnect(orgId)
						break
					case "planetscale":
						yield* planetscale.disconnect(orgId)
						break
					case "supabase":
						yield* supabase.disconnect(orgId)
						break
				}
				return null
			})

			const remove = Effect.fn("SourceRemovalService.remove")(function* (
				orgId: OrgId,
				sourceId: SourceId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.source.id": sourceId })
				const source = yield* sources.get(orgId, sourceId)
				yield* Effect.annotateCurrentSpan({
					"maple.source.kind": source.kind,
					"maple.source.platform": source.platform,
				})
				if (source.kind !== "integration") {
					return {
						source: yield* sources.delete(orgId, sourceId),
						cleanupScript: null,
					} satisfies SourceRemoval
				}
				const cleanupScript = yield* disconnect(orgId, source).pipe(
					Effect.mapError((error) =>
						error._tag === "@maple/http/errors/SourcePersistenceError"
							? error
							: disconnectFailed(error),
					),
				)
				// A source whose integration row is already gone has nothing to disconnect.
				yield* dbExecute((db) =>
					db.run(
						PG.deleteFrom(Sources).where(($) => [
							$.orgId.eq(orgId),
							$.id.eq(sourceId),
							$.kind.eq("integration"),
						]),
					),
				)
				return { source, cleanupScript } satisfies SourceRemoval
			})

			return { remove }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				SourcesService.layer,
				ScrapeTargetsService.layer,
				GcpConnectorService.layer,
				CloudflareOAuthService.layer,
				RailwayMetricsService.layer,
				PlanetScaleConnectionService.layer,
				SupabaseConnectionService.layer,
				VcsRepository.layer,
			),
		),
	)
}
