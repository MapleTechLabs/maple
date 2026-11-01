import { DemoSeedError, DemoSeedResponse } from "@maple/domain/http"
import { Array as Arr, Context, Effect, Layer } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { generateDemoRows } from "./demo/fixtures"

const DEMO_HOURS_DEFAULT = 6
const DEMO_RATE_PER_HOUR = 250
// Rows per warehouse append. Keeps each NDJSON POST body modest (~1.5k rows
// total for the 6h default) without fanning out into many tiny requests.
const INGEST_CHUNK = 500

/**
 * Demo rows skip the ingest gateway and its metering, so only local stacks and
 * PR previews (whose smoke test seeds through this) may write them.
 */
export const demoSeedAllowed = (environment: string): boolean =>
	environment === "development" || /^pr-\d+$/.test(environment)

export interface DemoServiceApi {
	readonly seed: (tenant: TenantContext, hours?: number) => Effect.Effect<DemoSeedResponse, DemoSeedError>
}

export class DemoService extends Context.Service<DemoService, DemoServiceApi>()(
	"@maple/backend/services/DemoService",
	{
		make: Effect.gen(function* () {
			const warehouse = yield* WarehouseQueryService
			const env = yield* Env

			const seed = Effect.fn("DemoService.seed")(function* (
				tenant: TenantContext,
				hours: number = DEMO_HOURS_DEFAULT,
			) {
				if (!demoSeedAllowed(env.MAPLE_ENVIRONMENT)) {
					return new DemoSeedResponse({
						seeded: false,
						skippedReason: "Demo data is only available on local and preview stacks",
						spansSent: 0,
						logsSent: 0,
						metricsSent: 0,
					})
				}
				const safeHours = Math.max(1, Math.min(24, Math.floor(hours)))
				const { traceRows, logRows, metricGaugeRows, metricSumRows } = generateDemoRows({
					orgId: tenant.orgId,
					hours: safeHours,
					ratePerHour: DEMO_RATE_PER_HOUR,
				})

				const ingestAll = (
					datasource: "traces" | "logs" | "metrics_gauge" | "metrics_sum",
					rows: ReadonlyArray<unknown>,
				) =>
					Effect.forEach(
						Arr.chunksOf(rows, INGEST_CHUNK),
						(batch) =>
							warehouse
								.ingest(tenant, datasource, batch)
								.pipe(
									Effect.mapError((error) => new DemoSeedError({ message: error.message })),
								),
						{ concurrency: 1, discard: true },
					)

				// Write straight to the warehouse datasources, bypassing the
				// billing-enforced ingest gateway (which 402s brand-new orgs that have
				// no active subscription — the whole point of demo data is to work
				// before the user has picked a plan). Also deliberately NOT metered to
				// Autumn: these are Maple-injected samples, not billable customer
				// telemetry.
				yield* ingestAll("traces", traceRows)
				yield* ingestAll("logs", logRows)
				// Runtime metrics so metric-based dashboard templates (Node.js
				// Runtime, Metric Overview) have data to show.
				yield* ingestAll("metrics_gauge", metricGaugeRows)
				yield* ingestAll("metrics_sum", metricSumRows)

				return new DemoSeedResponse({
					seeded: true,
					skippedReason: null,
					spansSent: traceRows.length,
					logsSent: logRows.length,
					metricsSent: metricGaugeRows.length + metricSumRows.length,
				})
			})

			return { seed } satisfies DemoServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(WarehouseQueryService.layer))
}
