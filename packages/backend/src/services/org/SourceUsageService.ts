import { Clock, Context, Effect, Layer } from "effect"
import { SourceUsage, SourceUsageBucket, SourceUsageSummary, SourceUsageTotal } from "@maple/domain/http"
import { CH, formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"

const HOUR_MS = 60 * 60 * 1000

/** 24 whole-hour buckets: from the start of the hour 23 hours ago through now. */
const usageWindow = Effect.map(Clock.currentTimeMillis, (now) => {
	const windowStart = Math.floor(now / HOUR_MS) * HOUR_MS - 23 * HOUR_MS
	return {
		windowStart,
		windowEnd: now,
		params: { startTime: formatWarehouseDateTime(windowStart), endTime: formatWarehouseDateTime(now) },
	}
})

export class SourceUsageService extends Context.Service<SourceUsageService>()(
	"@maple/backend/services/SourceUsageService",
	{
		make: Effect.gen(function* () {
			const warehouse = yield* WarehouseQueryService

			// `publicSourceId` is the `src_` id the gateway stamps as `maple_source_id`.
			const read = Effect.fn("SourceUsageService.read")(function* (
				tenant: TenantContext,
				publicSourceId: string,
			) {
				yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.source.id": publicSourceId })
				const { windowStart, windowEnd, params } = yield* usageWindow
				const rows = yield* warehouse.compiledQuery(
					tenant,
					CH.compile(
						CH.sourceUsageHourlyQuery(),
						{ orgId: tenant.orgId, sourceId: publicSourceId, ...params },
						{ rowSchema: CH.sourceUsageHourlyRowSchema },
					),
					{ profile: "aggregation", context: "sourceUsageHourly" },
				)
				const buckets = rows
					.map(
						(row) =>
							new SourceUsageBucket({
								hour: parseWarehouseDateTime(row.hour),
								spans: row.spans,
								logs: row.logs,
								metrics: row.metrics,
								bytes: row.bytes,
							}),
					)
					.sort((a, b) => a.hour - b.hour)
				return new SourceUsage({ windowStart, windowEnd, buckets })
			})

			// Totals for every source of the org with data in the window.
			const summary = Effect.fn("SourceUsageService.summary")(function* (tenant: TenantContext) {
				yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
				const { windowStart, windowEnd, params } = yield* usageWindow
				const rows = yield* warehouse.compiledQuery(
					tenant,
					CH.compile(
						CH.sourceUsageTotalsQuery(),
						{ orgId: tenant.orgId, ...params },
						{ rowSchema: CH.sourceUsageTotalsRowSchema },
					),
					{ profile: "aggregation", context: "sourceUsageTotals" },
				)
				yield* Effect.annotateCurrentSpan({ "result.rowCount": rows.length })
				const totals = rows.map((row) => new SourceUsageTotal(row))
				return new SourceUsageSummary({ windowStart, windowEnd, totals })
			})

			return { read, summary }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(WarehouseQueryService.layer))
}
