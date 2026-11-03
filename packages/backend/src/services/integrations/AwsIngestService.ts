import * as PG from "@maple-dev/effect-orm/postgres"
import { AwsConnections } from "@maple/db/tables"
import { IntegrationsNotFoundError, IntegrationsPersistenceError } from "@maple/domain/http"
import type { AwsConnectionId } from "@maple/domain/primitives"
import { CH, formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import { Clock, Context, Effect, Layer } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"

/** A stream delivers about every minute: an hour shows what it sends without a long scan. */
export const AWS_INGEST_WINDOW_MS = 60 * 60_000

export interface AwsIngestGroup {
	readonly namespace: string
	/** Null when the stream did not name its region. */
	readonly region: string | null
	readonly metrics: number
	readonly dataPoints: number
	readonly resources: number
	readonly sampleResources: ReadonlyArray<string>
	readonly lastPointAt: number
}

export interface AwsIngest {
	readonly windowStart: number
	readonly windowEnd: number
	readonly dataPoints: number
	readonly lastPointAt: number | null
	readonly groups: ReadonlyArray<AwsIngestGroup>
}

const toPersistenceError = makePersistenceErrorMapper(
	IntegrationsPersistenceError,
	"AWS connection database error",
)

/** What one AWS connection's metric stream stored, read from the warehouse. */
export class AwsIngestService extends Context.Service<AwsIngestService>()(
	"@maple/backend/services/AwsIngestService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const warehouse = yield* WarehouseQueryService
			const dbExecute = makeDbExecute(database, "AwsIngestService", toPersistenceError)

			const read = Effect.fn("AwsIngestService.read")(function* (
				tenant: TenantContext,
				connectionId: AwsConnectionId,
			) {
				yield* Effect.annotateCurrentSpan({
					orgId: tenant.orgId,
					"maple.aws.connection_id": connectionId,
				})
				const [connection] = yield* dbExecute((db) =>
					db.run(
						PG.from(AwsConnections)
							.select("id")
							.where(($) => [$.orgId.eq(tenant.orgId), $.id.eq(connectionId)])
							.limit(1),
					),
				)
				if (connection === undefined) {
					return yield* new IntegrationsNotFoundError({ message: "No such AWS connection." })
				}
				const windowEnd = yield* Clock.currentTimeMillis
				const windowStart = windowEnd - AWS_INGEST_WINDOW_MS
				const rows = yield* warehouse.compiledQuery(
					tenant,
					CH.compile(
						CH.awsIngestQuery(),
						{
							orgId: tenant.orgId,
							connectionId,
							startTime: formatWarehouseDateTime(windowStart),
							endTime: formatWarehouseDateTime(windowEnd),
						},
						{ rowSchema: CH.awsIngestRowSchema },
					),
					{ profile: "aggregation", context: "awsIngest" },
				)
				const groups = rows.map((row): AwsIngestGroup => ({
					namespace: row.namespace,
					region: row.region === "" ? null : row.region,
					metrics: row.metrics,
					dataPoints: row.dataPoints,
					resources: row.resources,
					sampleResources: row.sampleResources,
					lastPointAt: parseWarehouseDateTime(row.lastPointAt),
				}))
				yield* Effect.annotateCurrentSpan({ "result.rowCount": groups.length })
				return {
					windowStart,
					windowEnd,
					dataPoints: groups.reduce((total, group) => total + group.dataPoints, 0),
					lastPointAt:
						groups.length === 0 ? null : Math.max(...groups.map((group) => group.lastPointAt)),
					groups,
				} satisfies AwsIngest
			})

			return { read }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(WarehouseQueryService.layer))
}
