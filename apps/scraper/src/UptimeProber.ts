import { randomBytes } from "node:crypto"
import { Clock, Context, Effect, Layer, Metric } from "effect"
import { UptimeCheckReport, type UptimeProbeTarget } from "@maple/domain/uptime"
import { uptimeChecksTotal } from "./Metrics"
import { UptimeDnsProbe } from "./UptimeDnsProbe"
import { UptimeHttpProbe } from "./UptimeHttpProbe"
import type { CheckTraceContext, ProbeOutcome } from "./UptimeProbe"
import { UptimeSpanExporter } from "./UptimeSpanExporter"
import { UptimeTcpProbe } from "./UptimeTcpProbe"

/** Fresh W3C ids: 16 random bytes for the trace, 8 for the span. */
export const newTraceContext = Effect.sync((): CheckTraceContext => ({
	traceId: randomBytes(16).toString("hex"),
	spanId: randomBytes(8).toString("hex"),
}))

export interface UptimeProberApi {
	/**
	 * Run one check, buffer its span for the org's traces, and return the report for the API.
	 * Never fails: a down target is an `ok: false` report, and span export is fire and forget.
	 */
	readonly check: (target: UptimeProbeTarget) => Effect.Effect<UptimeCheckReport>
}

export class UptimeProber extends Context.Service<UptimeProber, UptimeProberApi>()(
	"@maple/scraper/UptimeProber",
	{
		make: Effect.gen(function* () {
			const http = yield* UptimeHttpProbe
			const tcp = yield* UptimeTcpProbe
			const dns = yield* UptimeDnsProbe
			const exporter = yield* UptimeSpanExporter

			const runProbe = (config: UptimeProbeTarget["config"], trace: CheckTraceContext) => {
				switch (config._tag) {
					case "http":
						return http.probe(config, trace)
					case "tcp":
						return tcp.probe(config)
					case "dns":
						return dns.probe(config)
				}
			}

			// `root`: loops fork inside `uptime.reconcile` and would otherwise nest every check under it.
			const check = Effect.fn("uptime.check", { root: true })(function* (target: UptimeProbeTarget) {
				const kind = target.config._tag
				const trace = yield* newTraceContext
				const startedAtMs = yield* Clock.currentTimeMillis
				const outcome: ProbeOutcome = yield* runProbe(target.config, trace)
				const endedAtMs = yield* Clock.currentTimeMillis

				yield* Effect.annotateCurrentSpan({
					orgId: target.orgId,
					"maple.uptime.monitor_id": target.id,
					"maple.uptime.kind": kind,
					"maple.uptime.ok": outcome.ok,
				})
				yield* Metric.update(
					Metric.withAttributes(uptimeChecksTotal, { kind, ok: String(outcome.ok) }),
					1,
				)
				yield* exporter.record({
					ingestKey: target.ingestKey,
					monitor: target,
					trace,
					startedAtMs,
					endedAtMs,
					outcome,
				})
				return new UptimeCheckReport({
					monitorId: target.id,
					checkedAt: startedAtMs,
					ok: outcome.ok,
					durationMs: outcome.durationMs,
					statusCode: outcome.statusCode,
					error: outcome.error,
					traceId: trace.traceId,
				})
			})

			return { check } satisfies UptimeProberApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
