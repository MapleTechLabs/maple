import { parseWarehouseDateTime } from "@maple/query-engine"
import { Clock, Effect } from "effect"
import { V2InvalidCredentials } from "@maple/domain/http/v2"
import { SignalPresenceService, type SignalPresence } from "@maple/backend/services/org/SignalPresenceService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import type { EndpointHandler } from "../../fixtures/dataset.ts"
import { tenantFor } from "../middleware.ts"
import type { FixtureWarehouse } from "../warehouse.ts"

/**
 * `telemetrySignals.retrieve` (apps/api/src/routes/v2/telemetry-signals.http.ts): the real
 * `SignalPresenceService` on the fixture warehouse, its clock frozen at the dataset's `now`.
 */

const frozenClock = (ms: number): Clock.Clock => ({
	currentTimeMillisUnsafe: () => ms,
	currentTimeMillis: Effect.succeed(ms),
	currentTimeNanosUnsafe: () => BigInt(ms) * 1_000_000n,
	currentTimeNanos: Effect.succeed(BigInt(ms) * 1_000_000n),
	monotonicTimeNanosUnsafe: () => BigInt(ms) * 1_000_000n,
	monotonicTimeNanos: Effect.succeed(BigInt(ms) * 1_000_000n),
	sleep: () => Effect.void,
})

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

const toV2Signal = (presence: SignalPresence) => ({
	object: "telemetry_signal",
	signal: presence.signal,
	status: presence.status,
	count: presence.count,
	first_seen: iso(presence.firstSeen),
	last_seen: iso(presence.lastSeen),
})

export const telemetrySignalsEndpoint = (warehouse: FixtureWarehouse): EndpointHandler => {
	const service = Effect.runSync(
		SignalPresenceService.make.pipe(Effect.provideService(WarehouseQueryService, warehouse.executor)),
	)
	return ({ dataset }) =>
		Effect.gen(function* () {
			const tenant = tenantFor(dataset)
			// Signed out: answer like the API's v2 auth middleware.
			if (tenant === undefined) return yield* V2InvalidCredentials.make()
			const report = yield* service
				.read(tenant)
				.pipe(Effect.provideService(Clock.Clock, frozenClock(parseWarehouseDateTime(dataset.now))))
			return {
				object: "telemetry_signals",
				generated_at: iso(report.generatedAt),
				window_start: iso(report.windowStart),
				window_end: iso(report.windowEnd),
				warehouse_available: report.warehouseAvailable,
				signals: report.signals.map(toV2Signal),
			}
		})
}
