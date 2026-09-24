import type { McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { formatDurationFromMs, formatPercent, formatNumber, truncate } from "../lib/format"
import { toMcpQueryError } from "../lib/map-warehouse-error"
import * as P from "../lib/params"
import { doc, type DocBlock } from "../lib/tool-doc"
import { Effect, Schema } from "effect"
import { DiagnoseServiceOutput } from "@maple/domain/mcp-outputs"
import { diagnoseService } from "@maple/query-engine/observability"
import { provideWarehouseExecutorFromTenant } from "@maple/backend/services/warehouse/WarehouseQueryService"

const WINDOW = P.timeWindow({ defaultHours: 6 })

export function registerDiagnoseServiceTool(server: McpToolRegistrar) {
	server.define({
		name: "diagnose_service",
		description:
			"Deep investigation of one service: health metrics, Apdex, top errors, recent traces and logs. Use after list_services identifies a problem service.",
		parameters: Schema.Struct({
			service: P.text("The service name to diagnose (exact `service.name`)"),
			...WINDOW.fields,
			environment: P.environment(),
		}),
		aliases: P.SERVICE_ALIASES,
		output: DiagnoseServiceOutput,
		hints: { readOnly: true },
		phrases: ["Diagnosing a service", "Checking a service's health"],
		handler: Effect.fn("McpTool.diagnoseService")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, "diagnose_service")
			const tenant = yield* CurrentMcpTenant

			const result = yield* diagnoseService({
				serviceName: params.service,
				timeRange: { startTime: st, endTime: et },
				environment: params.environment,
			}).pipe(
				provideWarehouseExecutorFromTenant(tenant),
				Effect.mapError(toMcpQueryError("service_overview")),
			)

			return {
				serviceName: params.service,
				timeRange: { start: st, end: et },
				health: { ...result.health },
				topErrors: result.topErrors.map((e) => ({
					fingerprintHash: e.fingerprintHash,
					label: e.label,
					count: e.count,
				})),
				recentTraces: result.recentTraces.map((t) => ({
					traceId: t.traceId,
					rootSpanName: t.rootSpanName,
					durationMs: t.durationMs,
					spanCount: 1,
					services: [],
					hasError: t.hasError,
				})),
				recentLogs: result.recentLogs.map((l) => ({
					timestamp: l.timestamp,
					severityText: l.severityText,
					serviceName: l.serviceName,
					body: l.body,
					traceId: l.traceId,
					spanId: l.spanId,
				})),
				...(params.environment === undefined ? undefined : { environment: params.environment }),
			}
		}),
		render: (output) => {
			const h = output.health
			const blocks: Array<DocBlock> = [
				doc.heading("Health Metrics"),
				doc.fields([
					["Throughput", `${formatNumber(h.throughput)} spans`],
					["Error Rate", `${formatPercent(h.errorRate)} (${formatNumber(h.errorCount)} errors)`],
					["P50 Latency", formatDurationFromMs(h.p50Ms)],
					["P95 Latency", formatDurationFromMs(h.p95Ms)],
					["P99 Latency", formatDurationFromMs(h.p99Ms)],
					["Apdex Score", h.apdex.toFixed(3)],
				]),
				doc.heading("Top Errors"),
				output.topErrors.length === 0
					? doc.text("No errors found for this service.")
					: doc.table(
							["Error", "Count", "Fingerprint"],
							output.topErrors.map((e) => [
								truncate(e.label, 80),
								formatNumber(e.count),
								e.fingerprintHash,
							]),
						),
			]
			if (output.recentTraces.length > 0) {
				blocks.push(
					doc.heading("Recent Traces"),
					doc.table(
						["Trace", "Root Span", "Duration", "Error"],
						output.recentTraces.map((t) => [
							t.traceId,
							truncate(t.rootSpanName, 60),
							formatDurationFromMs(t.durationMs),
							t.hasError ? "yes" : "",
						]),
					),
				)
			}
			if (output.recentLogs.length > 0) {
				blocks.push(
					doc.heading("Recent Logs"),
					doc.table(
						["Time", "Severity", "Body"],
						output.recentLogs.map((log) => [
							log.timestamp.split(" ")[1] ?? log.timestamp,
							log.severityText,
							truncate(log.body, 100),
						]),
					),
				)
			}
			return {
				title: `Diagnosis: ${output.serviceName}`,
				scope: [
					["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
					["Environment", output.environment],
				],
				blocks,
				next: [
					...(output.topErrors.length > 0
						? [doc.next("find_errors", { service: output.serviceName }, "see all error types")]
						: []),
					...(h.p95Ms > 500
						? [doc.next("find_slow_traces", { service: output.serviceName }, "find slow traces")]
						: []),
					...output.recentTraces
						.filter((t) => t.hasError)
						.slice(0, 2)
						.map((t) =>
							doc.next("inspect_trace", { trace_id: t.traceId }, "inspect error trace"),
						),
					doc.next(
						"service_map",
						{ service: output.serviceName },
						"see upstream/downstream dependencies",
					),
				],
			}
		},
	})
}
