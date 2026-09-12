import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import type { V2TelemetrySignal, V2TelemetrySignals } from "@maple/domain/http/v2"
import { Effect } from "effect"
import type { SignalPresence, SignalPresenceReport } from "@/services/org/SignalPresenceService"
import { SignalPresenceService } from "@/services/org/SignalPresenceService"

const toV2Signal = (presence: SignalPresence): V2TelemetrySignal => ({
	object: "telemetry_signal",
	signal: presence.signal,
	status: presence.status,
	count: presence.count,
	first_seen: presence.firstSeen === null ? null : new Date(presence.firstSeen).toISOString(),
	last_seen: presence.lastSeen === null ? null : new Date(presence.lastSeen).toISOString(),
})

const toV2 = (report: SignalPresenceReport): V2TelemetrySignals => ({
	object: "telemetry_signals",
	generated_at: new Date(report.generatedAt).toISOString(),
	window_start: new Date(report.windowStart).toISOString(),
	window_end: new Date(report.windowEnd).toISOString(),
	warehouse_available: report.warehouseAvailable,
	signals: report.signals.map(toV2Signal),
})

export const HttpV2TelemetrySignalsLive = HttpApiBuilder.group(MapleApiV2, "telemetrySignals", (handlers) =>
	Effect.gen(function* () {
		const signals = yield* SignalPresenceService

		return handlers.handle("retrieve", () =>
			Effect.gen(function* () {
				const tenant = yield* CurrentTenant.Context
				return toV2(yield* signals.read(tenant))
			}),
		)
	}),
)
