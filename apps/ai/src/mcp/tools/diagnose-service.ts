import type { McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { formatDurationFromMs, formatPercent, formatNumber, truncate } from "../lib/format"
import { toMcpQueryError } from "../lib/map-warehouse-error"
import * as P from "../lib/params"
import { doc, type DocBlock } from "../lib/tool-doc"
import { Effect, Result, Schema } from "effect"
import { DiagnoseServiceOutput } from "@maple/domain/mcp-outputs"
import { diagnoseService } from "@maple/query-engine/observability"
import { provideWarehouseExecutorFromTenant } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { serviceInfrastructure } from "../lib/infra"
import { kindTable } from "../lib/infra-render"
import { warehouseErrorText } from "../lib/map-warehouse-error"
import { servicePlatform } from "../lib/service-platform"
import { IntegrationInventoryService } from "@maple/backend/services/integrations/IntegrationInventoryService"

const WINDOW = P.timeWindow({ defaultHours: 6 })

/** The inspect_infra kind for one platform entity, and what its trend shows. */
const platformEntity = (kind: string) => {
	switch (kind) {
		case "cloudflare_workers":
			return { kind: "cloudflare_worker", trend: "invocations, errors and CPU time over the window" }
		case "planetscale_databases":
			return {
				kind: "planetscale_database",
				trend: "CPU, memory, storage and connections over the window",
			}
		default:
			return { kind: "railway_service", trend: "CPU and memory against its limits over the window" }
	}
}

export function registerDiagnoseServiceTool(server: McpToolRegistrar) {
	server.define({
		name: "diagnose_service",
		title: "Diagnose Service",
		description:
			"Deep investigation of one service: health metrics, Apdex, top errors, recent traces and logs, the Kubernetes workload it runs as, and the connected-platform resources behind it (its Railway service or Cloudflare Worker, and the PlanetScale databases it calls). Use after list_services identifies a problem service.",
		parameters: Schema.Struct({
			service: P.text("The service (exact `service.name`)"),
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

			// Platform lookups cost a fleet rollup each, so only connected providers are read.
			const connected = yield* IntegrationInventoryService.pipe(
				Effect.flatMap((inventory) => inventory.list(tenant.orgId)),
				Effect.map((inventory) => new Set<string>(inventory.integrations.map((i) => i.provider))),
				Effect.orElseSucceed(() => new Set<string>()),
			)

			const [result, infrastructure, platform] = yield* Effect.all(
				[
					diagnoseService({
						serviceName: params.service,
						timeRange: { startTime: st, endTime: et },
						environment: params.environment,
					}).pipe(
						provideWarehouseExecutorFromTenant(tenant),
						Effect.mapError(toMcpQueryError("service_overview")),
					),
					// Optional context: a failed lookup is reported beside the diagnosis, never instead of it.
					serviceInfrastructure(params.service, { startTime: st, endTime: et }).pipe(
						provideWarehouseExecutorFromTenant(tenant),
						Effect.result,
					),
					servicePlatform(
						params.service,
						{ startTime: st, endTime: et },
						connected,
						params.environment,
					).pipe(provideWarehouseExecutorFromTenant(tenant), Effect.result),
				],
				{ concurrency: 3 },
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
				...(Result.isSuccess(infrastructure)
					? infrastructure.success === undefined
						? undefined
						: { infrastructure: infrastructure.success }
					: { infrastructureError: warehouseErrorText(infrastructure.failure) }),
				...(Result.isSuccess(platform)
					? platform.success.length === 0
						? undefined
						: { platform: platform.success }
					: { platformError: warehouseErrorText(platform.failure) }),
			}
		}),
		render: (output) => {
			const h = output.health
			const blocks: Array<DocBlock> = [
				...(h.throughput === 0
					? [
							doc.text(
								"No spans from this service in the window, so the rates below are empty, not healthy. The infrastructure and platform sections still apply.",
							),
						]
					: []),
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
			const infra = output.infrastructure
			if (infra !== undefined) {
				blocks.push(
					doc.heading("Infrastructure"),
					doc.table(
						["Workload", "Namespace", "Pods", "CPU of limit", "Memory of limit"],
						infra.workloads.map((w) => [
							`${w.kind}/${w.name}`,
							w.namespace,
							formatNumber(w.podCount),
							w.cpu === undefined ? "no limit" : formatPercent(w.cpu),
							w.memory === undefined ? "no limit" : formatPercent(w.memory),
						]),
					),
				)
				if (infra.pods.length > 0) {
					blocks.push(
						doc.text("Pods, closest to a limit first:"),
						kindTable({ kind: "pods", rows: infra.pods, truncated: false }),
					)
				}
			} else if (output.infrastructureError !== undefined) {
				blocks.push(doc.text(`Infrastructure lookup failed: ${output.infrastructureError}`))
			}
			if (output.platform !== undefined) {
				blocks.push(
					doc.heading("Platform"),
					...output.platform.flatMap((section) => [
						...(section.rows.length === 0 ? [] : [kindTable(section)]),
						...(section.truncated
							? [
									doc.text(
										`Only part of the ${section.kind.replace("_", " ")} fleet was read, so a match may be missing; inspect_infra by name checks one directly.`,
									),
								]
							: []),
					]),
				)
			} else if (output.platformError !== undefined) {
				blocks.push(doc.text(`Platform lookup failed: ${output.platformError}`))
			}
			const platformNext = (output.platform ?? []).flatMap((section) =>
				section.rows.slice(0, 1).map((row) =>
					doc.next(
						"inspect_infra",
						{
							kind: platformEntity(section.kind).kind,
							name: row.name,
							...(row.environment === undefined ? undefined : { environment: row.environment }),
						},
						`${row.name}: ${platformEntity(section.kind).trend}`,
					),
				),
			)
			const workload = infra?.workloads.find((w) => w.kind !== "unknown")
			const hotPod = infra?.pods.find((p) => (p.saturation ?? 0) >= 0.9)
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
					...(hotPod === undefined
						? []
						: [
								doc.next(
									"inspect_infra",
									{ kind: "pod", name: hotPod.name, namespace: hotPod.namespace },
									`${hotPod.name} is at a CPU or memory limit: see when it peaked`,
								),
							]),
					...(workload === undefined || hotPod !== undefined
						? []
						: [
								doc.next(
									"inspect_infra",
									{
										kind: "workload",
										name: workload.name,
										namespace: workload.namespace,
										workload_kind: workload.kind,
									},
									"check whether its pods were short of CPU or memory",
								),
							]),
					...platformNext,
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
