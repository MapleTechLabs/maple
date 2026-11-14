import { type OrgId, type Source, SourcePersistenceError } from "@maple/domain/http"
import { PullSourcePlatform, type SourceId } from "@maple/primitives"
import { AwsConnections, GcpConnectors, ScrapeTargets, Sources, VcsInstallations } from "@maple/db/tables"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Array as Arr, Context, Effect, Layer, Option, Schema } from "effect"
import { Database, type DatabaseError } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { CloudflareOAuthService } from "@maple/backend/services/auth/CloudflareOAuthService"
import { AwsConnectionService } from "./AwsConnectionService"
import { SourcesService } from "@maple/backend/services/org/SourcesService"
import { GcpConnectorService } from "./GcpConnectorService"
import { PlanetScaleConnectionService } from "./PlanetScaleConnectionService"
import { RailwayMetricsService } from "./RailwayMetricsService"
import { ScrapeTargetsService } from "./ScrapeTargetsService"
import { SupabaseConnectionService } from "./SupabaseConnectionService"
import { VercelIntegrationService } from "./VercelIntegrationService"
import { VcsRepository } from "./vcs/VcsRepository"

const isPullSourcePlatform = Schema.is(PullSourcePlatform)
const isSourcePersistenceError = Schema.is(SourcePersistenceError)

const toPersistenceError = (error: DatabaseError) => new SourcePersistenceError({ message: error.message })

/** A failed disconnect, as the removal reports it. */
const disconnectFailed = Effect.mapError((error: { readonly message: string }) =>
	isSourcePersistenceError(error)
		? error
		: new SourcePersistenceError({ message: `Disconnecting the integration failed: ${error.message}` }),
)

export interface SourceRemoval {
	readonly source: Source
	/** Google Cloud and AWS: the script that removes what their setup created there. */
	readonly cleanupScript: string | null
}

/**
 * Deletes any source but the default one. An integration source is deleted by disconnecting the
 * integration it stands for, so its credential, upstream setup and polling go with it; deleting
 * the row alone would leave the integration collecting.
 */
export class SourceRemovalService extends Context.Service<SourceRemovalService>()(
	"@maple/backend/services/SourceRemovalService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "SourceRemovalService", toPersistenceError)
			const sources = yield* SourcesService
			const scrapeTargets = yield* ScrapeTargetsService
			const gcp = yield* GcpConnectorService
			const aws = yield* AwsConnectionService
			const cloudflare = yield* CloudflareOAuthService
			const railway = yield* RailwayMetricsService
			const planetscale = yield* PlanetScaleConnectionService
			const supabase = yield* SupabaseConnectionService
			const vercel = yield* VercelIntegrationService
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
			const awsConnectionsOf = (orgId: OrgId, sourceId: SourceId) =>
				dbExecute((db) =>
					db.run(
						PG.from(AwsConnections)
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

			/** The first cleanup script of several removed records; Google Cloud and AWS answer with one. */
			const firstScript = (scripts: ReadonlyArray<string | null>) =>
				Option.getOrNull(Arr.findFirst(scripts, (script) => script !== null))

			/** A one-per-org integration, disconnected only while it still sends as the source. */
			const whileLinked =
				<E extends { readonly message: string }>(
					disconnect: (orgId: OrgId) => Effect.Effect<unknown, E>,
				) =>
				(orgId: OrgId, source: Source) =>
					source.integrationId === null
						? Effect.succeed(null)
						: disconnect(orgId).pipe(Effect.as(null), disconnectFailed)

			/**
			 * How each platform's source is disconnected, answering with a cleanup script or null. Keyed by
			 * every pull platform, so a new integration cannot ship a source that deleting leaves collecting.
			 */
			const disconnects = {
				// Several records per org: disconnect only the ones sending as this source.
				prometheus: (orgId, source) =>
					scrapeTargetsOf(orgId, source.id).pipe(
						Effect.flatMap((targets) =>
							Effect.forEach(
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
							),
						),
						Effect.as(null),
						disconnectFailed,
					),
				gcp: (orgId, source) =>
					gcpConnectorsOf(orgId, source.id).pipe(
						Effect.flatMap((connectors) =>
							Effect.forEach(connectors, (connector) =>
								gcp.delete(orgId, connector.id).pipe(
									Effect.map((deleted) => deleted.cleanupScript),
									Effect.catchTag("@maple/http/errors/IntegrationsNotFoundError", () =>
										Effect.succeed(null),
									),
								),
							),
						),
						Effect.map(firstScript),
						disconnectFailed,
					),
				aws: (orgId, source) =>
					awsConnectionsOf(orgId, source.id).pipe(
						Effect.flatMap((connections) =>
							Effect.forEach(connections, (connection) =>
								aws.delete(orgId, connection.id).pipe(
									Effect.map((deleted) => deleted.cleanupScript),
									Effect.catchTag("@maple/http/errors/IntegrationsNotFoundError", () =>
										Effect.succeed(null),
									),
								),
							),
						),
						Effect.map(firstScript),
						disconnectFailed,
					),
				github: (orgId, source) =>
					installationsOf(orgId, source.id).pipe(
						Effect.flatMap((installations) =>
							Effect.forEach(
								installations,
								(installation) => vcs.purgeInstallation(orgId, installation.id),
								{ discard: true },
							),
						),
						Effect.as(null),
						disconnectFailed,
					),
				cloudflare: whileLinked(cloudflare.disconnect),
				railway: whileLinked(railway.disconnect),
				planetscale: whileLinked(planetscale.disconnect),
				supabase: whileLinked(supabase.disconnect),
				vercel: whileLinked(vercel.disconnect),
			} satisfies Record<
				PullSourcePlatform,
				(orgId: OrgId, source: Source) => Effect.Effect<string | null, SourcePersistenceError>
			>

			/** Disconnects what sends as `source`. Push-only platforms have no connection to remove. */
			const disconnect = (orgId: OrgId, source: Source) =>
				isPullSourcePlatform(source.platform)
					? disconnects[source.platform](orgId, source)
					: Effect.succeed(null)

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
				const cleanupScript = yield* disconnect(orgId, source)
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
				AwsConnectionService.layer,
				CloudflareOAuthService.layer,
				RailwayMetricsService.layer,
				PlanetScaleConnectionService.layer,
				SupabaseConnectionService.layer,
				VercelIntegrationService.layer,
				VcsRepository.layer,
			),
		),
	)
}
