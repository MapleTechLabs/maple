import { Array as Arr, Clock, Context, Effect, Layer } from "effect"
import { CustomIngestKeyUsage, CustomIngestKeyUsageBucket } from "@maple/domain/http"
import { CH, formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"

const WINDOW_MS = 24 * 60 * 60 * 1000

export class CustomIngestKeyUsageService extends Context.Service<CustomIngestKeyUsageService>()(
	"@maple/api/services/CustomIngestKeyUsageService",
	{
		make: Effect.gen(function* () {
			const warehouse = yield* WarehouseQueryService

			// `publicKeyId` is the `ingk_` id the gateway stamps as `maple_ingest_key_id`.
			const read = Effect.fn("CustomIngestKeyUsageService.read")(function* (
				tenant: TenantContext,
				publicKeyId: string,
			) {
				yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.ingest_key.id": publicKeyId })
				const now = yield* Clock.currentTimeMillis
				const windowStart = now - WINDOW_MS
				const rows = yield* warehouse.compiledQuery(
					tenant,
					CH.compileUnion(
						CH.ingestKeyUsageQuery(),
						{
							orgId: tenant.orgId,
							keyId: publicKeyId,
							startTime: formatWarehouseDateTime(windowStart),
							endTime: formatWarehouseDateTime(now),
						},
						{ rowSchema: CH.ingestKeyUsageRowSchema },
					),
					{ profile: "aggregation", context: "customIngestKeyUsage" },
				)
				const byHour = Arr.groupBy(rows, (row) => row.hour)
				const buckets = Object.entries(byHour)
					.map(
						([hour, hourRows]) =>
							new CustomIngestKeyUsageBucket({
								hour: parseWarehouseDateTime(hour),
								spans: hourRows.find((row) => row.signal === "spans")?.count ?? 0,
								logs: hourRows.find((row) => row.signal === "logs")?.count ?? 0,
							}),
					)
					.sort((a, b) => a.hour - b.hour)
				return new CustomIngestKeyUsage({ windowStart, windowEnd: now, buckets })
			})

			return { read }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(WarehouseQueryService.layer))
}
