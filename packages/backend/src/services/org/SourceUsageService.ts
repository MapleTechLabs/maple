import { Array as Arr, Clock, Context, Effect, Layer } from "effect"
import { SourceUsage, SourceUsageBucket } from "@maple/domain/http"
import { CH, formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"

const WINDOW_MS = 24 * 60 * 60 * 1000

export class SourceUsageService extends Context.Service<SourceUsageService>()(
	"@maple/api/services/SourceUsageService",
	{
		make: Effect.gen(function* () {
			const warehouse = yield* WarehouseQueryService

			// `publicSourceId` is the `src_` id the gateway stamps as `maple_source_id`.
			const read = Effect.fn("SourceUsageService.read")(function* (
				tenant: TenantContext,
				publicSourceId: string,
			) {
				yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.source.id": publicSourceId })
				const now = yield* Clock.currentTimeMillis
				const windowStart = now - WINDOW_MS
				const rows = yield* warehouse.compiledQuery(
					tenant,
					CH.compileUnion(
						CH.sourceUsageQuery(),
						{
							orgId: tenant.orgId,
							sourceId: publicSourceId,
							startTime: formatWarehouseDateTime(windowStart),
							endTime: formatWarehouseDateTime(now),
						},
						{ rowSchema: CH.sourceUsageRowSchema },
					),
					{ profile: "aggregation", context: "sourceUsage" },
				)
				const byHour = Arr.groupBy(rows, (row) => row.hour)
				const buckets = Object.entries(byHour)
					.map(
						([hour, hourRows]) =>
							new SourceUsageBucket({
								hour: parseWarehouseDateTime(hour),
								spans: hourRows.find((row) => row.signal === "spans")?.count ?? 0,
								logs: hourRows.find((row) => row.signal === "logs")?.count ?? 0,
							}),
					)
					.sort((a, b) => a.hour - b.hour)
				return new SourceUsage({ windowStart, windowEnd: now, buckets })
			})

			return { read }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(WarehouseQueryService.layer))
}
