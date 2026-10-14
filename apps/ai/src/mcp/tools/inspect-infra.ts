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
import { formatPercent } from "../lib/format"
import { parseWarehouseDateTime } from "@maple/query-engine"
import {
	ENTITY_KIND,
	KIND_METRICS,
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
			return formatUptime(v)
	}
}

export function registerInspectInfraTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Inspect Infrastructure",
		description:
			"One host, Kubernetes pod/node/workload, or Docker container in depth: identity (OS, node, owner workload, image, QoS class; restart count for containers; per-mount disk use for hosts), " +
			"CPU and memory over the window as min/avg/max/last with the time of the peak, and its busiest children (a node's or workload's pods, a host's containers). " +
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
			...WINDOW.fields,
		}),
		output: InspectInfraOutput,
		hints: { readOnly: true },
		phrases: ["Inspecting infrastructure", "Checking resource usage"],
		handler: Effect.fn("McpTool.inspectInfra")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, TOOL)
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, kind: params.kind })
			const result = yield* withTenantExecutor(
				inspectInfra(
					{
						kind: params.kind,
						name: params.name,
						namespace: params.namespace,
						host: params.host,
						workloadKind: params.workload_kind,
					},
					{ startTime: st, endTime: et },
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
				["Last seen", entity.lastSeen],
				...Object.entries(output.details ?? {}),
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
					[...identity, ...always, ...(output.series.length === 0 ? averages : [])].filter(
						([, v]) => v !== undefined && v !== "",
					),
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
			} else {
				blocks.push(doc.text("No time series in this window."))
			}
			blocks.push(doc.text(KIND_METRICS[LIST_KIND[output.kind]]))
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
			const next: Array<NextCall> = [
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
				scope,
				blocks,
				notices,
				next,
			}
		},
	})
}
