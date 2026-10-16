import { Effect, Schema } from "effect"
import { InspectInfraOutput, type InfraSeriesStats } from "@maple/domain/mcp-outputs"
import type { McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { withTenantExecutor, CurrentMcpTenant } from "../lib/query-warehouse"
import { MCP_DISCOVERY_MAX_HOURS } from "../lib/time"
import * as P from "../lib/params"
import { doc, type DocBlock, type NextCall } from "../lib/tool-doc"
import { WORKLOAD_KINDS, bucketSecondsFor } from "../lib/infra"
import { ENTITY_KINDS, entityKind } from "../lib/infra-params"
import { inspectInfra } from "../lib/infra-inspect"
import { ZONE_DIMENSIONS, ZONE_SECTIONS, inspectProvider, isProviderEntityKind } from "../lib/infra-providers"
import { formatDurationFromMs, formatNumber, formatPercent } from "../lib/format"
import { parseWarehouseDateTime } from "@maple/query-engine"
import {
	ENTITY_KIND,
	KIND_METRICS,
	formatBytes,
	formatUptime,
	kindTable,
	summaryLine,
	windowText,
} from "../lib/infra-render"

const TOOL = "inspect_infra"
const WINDOW = P.timeWindow({ defaultHours: 1, maxHours: MCP_DISCOVERY_MAX_HOURS })

const LIST_KIND = {
	host: "hosts",
	pod: "pods",
	node: "nodes",
	workload: "workloads",
	container: "containers",
	cloudflare_zone: "cloudflare_zones",
	cloudflare_worker: "cloudflare_workers",
	railway_service: "railway_services",
	planetscale_database: "planetscale_databases",
} as const

/** The metrics behind each non-default Cloudflare zone section. */
const ZONE_SECTION_METRICS = {
	breakdown:
		"Metrics: cloudflare.http.requests.by_* families (path, country, client) and cloudflare.http.requests by host, cache.status and http.status_class, under service.name=cloudflare/<zone>.",
	security:
		"Metrics: cloudflare.firewall.events (by firewall.action, firewall.source, firewall.rule_id), under service.name=cloudflare/<zone>.",
	dns: "Metrics: cloudflare.dns.queries (by dns.response_code, dns.query_name), under service.name=cloudflare/<zone>.",
} as const

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`

/** The resource attribute that names the entity on its logs and spans. */
const resourceKeyFor = (kind: (typeof ENTITY_KINDS)[number], workloadKind: string | undefined) => {
	switch (kind) {
		case "pod":
			return "k8s.pod.name"
		case "node":
			return "k8s.node.name"
		case "container":
			return "container.name"
		case "host":
			return "host.name"
		case "workload":
			return workloadKind === undefined ? undefined : `k8s.${workloadKind}.name`
		case "cloudflare_zone":
		case "cloudflare_worker":
		case "railway_service":
		case "planetscale_database":
			return undefined
	}
}

/** Last third against first third: "rising +12.4 pts", "flat". A drop after a peak reads as falling. */
const trend = (stat: InfraSeriesStats): string => {
	const scale = stat.unit === "fraction" ? 100 : 1
	const delta = stat.change * scale
	const relative = stat.avg === 0 ? 0 : Math.abs(stat.change) / Math.abs(stat.avg)
	if (relative < 0.05) return "flat"
	const amount =
		stat.unit === "fraction"
			? `${Math.abs(delta).toFixed(1)} pts`
			: stat.unit === "bytes"
				? `${(Math.abs(stat.change) / 1024 / 1024).toFixed(0)} MiB`
				: stat.unit === "ms"
					? formatDurationFromMs(Math.abs(stat.change))
					: stat.unit === "count"
						? formatNumber(Math.round(Math.abs(stat.change)))
						: Math.abs(delta).toFixed(2)
	return `${stat.change > 0 ? "rising +" : "falling -"}${amount}`
}

const value = (stat: InfraSeriesStats, v: number): string => {
	switch (stat.unit) {
		case "fraction":
			return formatPercent(v)
		case "cores":
			return `${v.toFixed(3)} cores`
		case "load":
			return v.toFixed(2)
		case "bytes":
			return v >= 1024 ** 3
				? `${(v / 1024 ** 3).toFixed(2)} GiB`
				: `${(v / 1024 / 1024).toFixed(0)} MiB`
		case "seconds":
			return v < 60 ? `${v.toFixed(1)}s` : formatUptime(v)
		case "count":
			return formatNumber(Math.round(v))
		case "ms":
			return formatDurationFromMs(v)
	}
}

export function registerInspectInfraTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Inspect Infrastructure",
		description:
			"One host, Kubernetes pod/node/workload, or Docker container in depth: identity (OS, node, owner workload, image, QoS class; restart count for containers; per-mount disk use for hosts), " +
			"CPU and memory over the window as min/avg/max/last with the time of the peak, and its busiest children (a node's or workload's pods, a host's containers). " +
			"Also one Cloudflare zone (section=traffic: requests, 5xx, latency, status and cache mix; breakdown: top values of `dimension`; security: firewall events and top rules; dns: queries and top names), " +
			"Cloudflare Worker (invocations by outcome, duration and CPU time), Railway service (CPU, memory, network, disk, replicas) or PlanetScale database (CPU, memory, connections, replica lag, storage) over the window. " +
			"Use after list_infra, or to check whether a slow or failing service was starved of CPU or memory: compare the peak time with the incident. " +
			"Same default window as list_infra (1 hour), so the numbers match; pass start_time to look further back.",
		parameters: Schema.Struct({
			kind: entityKind("What `name` refers to"),
			name: P.text(
				"Exact name: host.name, k8s.pod.name, k8s.node.name, workload name, or container.name",
			),
			namespace: P.optionalText(
				"Kubernetes namespace, when the same pod or workload name exists in several",
			),
			host: P.optionalText("Host of a container, when the same container name runs on several hosts"),
			workload_kind: P.optionalOneOf(
				WORKLOAD_KINDS,
				"Kubernetes workload kind. Omit to look the name up under each kind",
			),
			environment: P.optionalText(
				"Railway environment name, when the same service runs in several environments",
			),
			section: P.optionalOneOf(ZONE_SECTIONS, "Cloudflare zones only: which view (default traffic)"),
			dimension: P.optionalOneOf(
				ZONE_DIMENSIONS,
				"Cloudflare zones with section=breakdown: what to rank requests by (default path)",
			),
			...WINDOW.fields,
		}),
		output: InspectInfraOutput,
		hints: { readOnly: true },
		phrases: ["Inspecting infrastructure", "Checking resource usage"],
		handler: Effect.fn("McpTool.inspectInfra")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, TOOL)
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, kind: params.kind })
			const window = { startTime: st, endTime: et }
			const kind = params.kind
			const result = yield* withTenantExecutor(
				isProviderEntityKind(kind)
					? inspectProvider(
							{
								kind,
								name: params.name,
								environment: params.environment,
								section: params.section,
								dimension: params.dimension,
							},
							window,
						)
					: inspectInfra(
							{
								kind,
								name: params.name,
								namespace: params.namespace,
								host: params.host,
								workloadKind: params.workload_kind,
							},
							window,
						),
			).pipe(Effect.catchTags(warehouseToMcpHandlers(TOOL)))

			return {
				timeRange: { start: st, end: et },
				kind: params.kind,
				name: params.name,
				bucketSeconds: bucketSecondsFor({ startTime: st, endTime: et }),
				...result,
			}
		}),
		render: (output) => {
			const entity = output.entity
			const scope: Array<readonly [string, string | undefined]> = [
				["Window", windowText(output.timeRange)],
			]
			if (!output.found || entity === undefined) {
				return {
					title: `${output.kind}: ${output.name}`,
					scope,
					empty: {
						message: `No ${output.kind} named "${output.name}" reported metrics in this window.`,
						hints: [
							`Names are exact; list_infra kind="${LIST_KIND[output.kind]}" search="${output.name}" finds near matches.`,
							"Widen start_time/end_time if it stopped reporting earlier.",
						],
					},
					blocks: [],
					next: [
						doc.next(
							"list_infra",
							{ kind: LIST_KIND[output.kind], search: output.name },
							"find the exact name",
						),
					],
				}
			}
			const identity: Array<readonly [string, string | undefined]> = [
				["Namespace", entity.namespace],
				[
					"Owner",
					entity.workload === undefined
						? undefined
						: `${entity.workloadKind ?? ""}/${entity.workload}`,
				],
				["Node", entity.node],
				["Host", entity.host],
				["Image", entity.image],
				["OS", entity.os],
				["Pods", entity.podCount === undefined ? undefined : String(entity.podCount)],
				[
					"Uptime",
					entity.uptimeSeconds === undefined ? undefined : formatUptime(entity.uptimeSeconds),
				],
				[
					"First seen",
					output.firstSeen === undefined
						? undefined
						: parseWarehouseDateTime(output.firstSeen) -
									parseWarehouseDateTime(output.timeRange.start) <
							  output.bucketSeconds * 1000
							? `${output.firstSeen} (the window start: it was already running)`
							: output.firstSeen,
				],
				["Restarts in window", entity.restarts === undefined ? undefined : String(entity.restarts)],
				[output.kind === "cloudflare_worker" ? "Account" : "Project", entity.project],
				["Environment", entity.environment],
				["Replicas", entity.replicas === undefined ? undefined : String(entity.replicas)],
				["Last seen", entity.lastSeen],
				...Object.entries(output.details ?? {}),
			]
			const both = (a: number | undefined, b: number | undefined, f: (v: number) => string) =>
				a === undefined ? undefined : b === undefined ? f(a) : `${f(a)} → ${f(b)}`
			const isZone = output.kind === "cloudflare_zone"
			// Window totals for provider kinds: what list_infra showed, before the series below.
			const totals: Array<readonly [string, string | undefined]> = [
				[
					isZone ? "Requests" : "Invocations",
					entity.requests === undefined ? undefined : formatNumber(entity.requests),
				],
				[
					isZone ? "5xx" : "Errors",
					entity.errors === undefined
						? undefined
						: `${formatNumber(entity.errors)} (${formatPercent(entity.errorRate ?? 0)})`,
				],
				["4xx", entity.errors4xx === undefined ? undefined : formatNumber(entity.errors4xx)],
				[
					"Cache hit rate",
					entity.cacheHitRate === undefined ? undefined : formatPercent(entity.cacheHitRate),
				],
				["Bandwidth", entity.bytes === undefined ? undefined : formatBytes(entity.bytes)],
				["Visits", entity.visits === undefined ? undefined : formatNumber(entity.visits)],
				[
					"Subrequests",
					entity.subrequests === undefined ? undefined : formatNumber(entity.subrequests),
				],
				[
					isZone ? "Edge TTFB p50 → p95 → p99" : "Duration p50 → p99",
					isZone
						? entity.latencyP50Ms === undefined
							? undefined
							: [entity.latencyP50Ms, entity.latencyP95Ms ?? 0, entity.latencyP99Ms ?? 0]
									.map(formatDurationFromMs)
									.join(" → ")
						: both(entity.latencyP50Ms, entity.latencyP99Ms, formatDurationFromMs),
				],
				[
					"Origin p95",
					entity.originP95Ms === undefined ? undefined : formatDurationFromMs(entity.originP95Ms),
				],
				["CPU time p50 → p99", both(entity.cpuTimeP50Ms, entity.cpuTimeP99Ms, formatDurationFromMs)],
				[
					"Connections avg → peak",
					both(entity.connections, entity.connectionsPeak, (v) => v.toFixed(1)),
				],
				[
					"Replica lag (worst)",
					entity.replicaLagSeconds === undefined
						? undefined
						: `${entity.replicaLagSeconds.toFixed(1)}s`,
				],
				...(output.kind === "planetscale_database"
					? ([
							[
								"CPU peak (busiest pod)",
								entity.cpuPeak === undefined ? undefined : formatPercent(entity.cpuPeak),
							],
							[
								"Memory peak (busiest pod)",
								entity.memoryPeak === undefined
									? undefined
									: formatPercent(entity.memoryPeak),
							],
						] as const)
					: []),
			]
			const always: Array<readonly [string, string | undefined]> = [
				["Fullest disk", entity.disk === undefined ? undefined : formatPercent(entity.disk)],
				[
					"Limits",
					entity.unbounded
						? "none set: CPU and memory cannot be measured against a limit"
						: undefined,
				],
			]
			// Window averages from the summary query, shown only when no series covers them.
			const averages: Array<readonly [string, string | undefined]> = [
				["CPU (avg)", entity.cpu === undefined ? undefined : formatPercent(entity.cpu)],
				["CPU cores (avg)", entity.cpuCores === undefined ? undefined : entity.cpuCores.toFixed(3)],
				["Memory (avg)", entity.memory === undefined ? undefined : formatPercent(entity.memory)],
				["Load 15m (avg)", entity.load15 === undefined ? undefined : entity.load15.toFixed(2)],
			]
			const blocks: Array<DocBlock> = [
				doc.fields(
					[
						...identity,
						...totals,
						...always,
						...(output.series.length === 0 ? averages : []),
					].filter(([, v]) => v !== undefined && v !== ""),
				),
			]
			// A per-pod series names its pod; the entity's own series is the entity.
			const restartsOf = (pod: string | undefined) =>
				pod === undefined
					? entity.restarts
					: output.children?.rows.find((row) => row.name === pod)?.restarts
			const drops = output.series.filter(
				(s) => s.unit === "fraction" && s.max >= 0.9 && s.last <= s.max * 0.6,
			)
			// The workload average mirrors its hottest pod's drop; say it once, about the pod.
			const notices = (
				drops.some((s) => s.group !== undefined) ? drops.filter((s) => s.group !== undefined) : drops
			).map((s) => {
				const restarts = restartsOf(s.group)
				const who = s.group === undefined ? s.label : `${s.group}'s ${s.label}`
				const cause =
					restarts === undefined
						? "most likely a restart (OOM kill or eviction); no restart count is collected for it"
						: restarts > 0
							? `with ${plural(restarts, "container restart")} recorded in the window: consistent with an OOM kill (the termination reason is not collected)`
							: "with no restart recorded, so usage fell on its own"
				return `${who} reached ${formatPercent(s.max)} at ${s.maxAt}, then fell to ${formatPercent(s.last)} by the end of the window, ${cause}.`
			})
			if (output.series.length > 0) {
				blocks.push(
					doc.heading(
						`Over the window (${output.series[0]?.points ?? 0} buckets of ${formatUptime(output.bucketSeconds)}; min/avg/max of bucket averages)`,
					),
					doc.table(
						["Metric", "Min", "Avg", "Max", "Peak at", "Last", "Trend"],
						output.series.map((s) => [
							s.group === undefined ? s.label : `${s.label} (${s.group})`,
							value(s, s.min),
							value(s, s.avg),
							value(s, s.max),
							s.maxAt,
							value(s, s.last),
							trend(s),
						]),
					),
				)
			} else if ((output.breakdowns ?? []).length === 0) {
				blocks.push(doc.text("No time series in this window."))
			}
			for (const breakdown of output.breakdowns ?? []) {
				blocks.push(
					doc.heading(breakdown.title),
					breakdown.rows.length === 0
						? doc.text("Nothing recorded in this window.")
						: doc.table(
								[breakdown.keyLabel, ...breakdown.valueLabels],
								breakdown.rows.map((row) => [
									row.key,
									...row.values.map((v, i) =>
										breakdown.valueLabels[i] === "Share"
											? formatPercent(v)
											: breakdown.valueLabels[i] === "Bytes"
												? formatBytes(v)
												: formatNumber(Math.round(v)),
									),
								]),
							),
				)
			}
			blocks.push(
				doc.text(
					output.section === undefined || output.section === "traffic"
						? KIND_METRICS[LIST_KIND[output.kind]]
						: ZONE_SECTION_METRICS[output.section],
				),
			)
			const children = output.children
			if (children !== undefined) {
				blocks.push(
					doc.heading(
						children.kind === "pods"
							? "Pods, closest to a limit first"
							: "Containers, busiest first",
					),
					doc.text(summaryLine(children)),
					kindTable(children),
				)
			}
			const resourceKey = resourceKeyFor(output.kind, entity.workloadKind)
			const peak = output.series.reduce<InfraSeriesStats | undefined>(
				(best, s) => (s.unit === "fraction" && (best === undefined || s.max > best.max) ? s : best),
				undefined,
			)
			const window = { start_time: output.timeRange.start, end_time: output.timeRange.end }
			const otherSections: Array<NextCall> =
				output.kind === "cloudflare_zone"
					? ZONE_SECTIONS.filter((section) => section !== (output.section ?? "traffic")).map(
							(section) =>
								doc.next(
									TOOL,
									{ kind: output.kind, name: output.name, section, ...window },
									section === "breakdown"
										? "top paths by requests and 5xx (dimension= host, country, method, ...)"
										: section === "security"
											? "firewall events and the rules that fired"
											: section === "dns"
												? "DNS queries, NXDOMAIN and top names"
												: "requests, 5xx and latency over the window",
								),
						)
					: []
			const next: Array<NextCall> = [
				...otherSections,
				...(children?.rows[0] === undefined
					? []
					: [
							doc.next(
								TOOL,
								{
									kind: ENTITY_KIND[children.kind],
									name: children.rows[0].name,
									namespace: children.rows[0].namespace,
									host: children.kind === "containers" ? children.rows[0].host : undefined,
									start_time: output.timeRange.start,
									end_time: output.timeRange.end,
								},
								`drill into ${children.rows[0].name}`,
							),
						]),
				...(resourceKey === undefined
					? []
					: [
							doc.next(
								"query_data",
								{
									source: "logs",
									kind: "timeseries",
									group_by: "severity",
									attribute_key: resourceKey,
									attribute_value: output.name,
									attribute_scope: "resource",
									start_time: output.timeRange.start,
									end_time: output.timeRange.end,
								},
								peak !== undefined && peak.max >= 0.9
									? `log volume by severity around the ${peak.label} peak at ${peak.maxAt}`
									: `log volume by severity from this ${output.kind}`,
							),
						]),
			]
			return {
				title: `${output.kind}: ${entity.name}`,
				scope: output.section === undefined ? scope : [...scope, ["Section", output.section]],
				blocks,
				notices,
				next,
			}
		},
	})
}
