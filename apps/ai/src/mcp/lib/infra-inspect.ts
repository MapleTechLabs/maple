/** One infrastructure entity in depth: what the web app's host/pod/node/workload/container pages show. */
import { Array as Arr, Effect } from "effect"
import { CH } from "@maple/query-engine"
import { formatPercent } from "./format"
import { WarehouseExecutor } from "@maple/query-engine/observability"
import type {
	InfraEntityKind,
	InfraEntityRow,
	InfraKindSection,
	InfraSeriesStats,
} from "@maple/domain/mcp-outputs"
import {
	WORKLOAD_KINDS,
	bucketSecondsFor,
	busyFraction,
	iso,
	listInfraKind,
	onlyGroup,
	seriesStats,
	ungrouped,
	type InfraWindow,
	type WorkloadKind,
} from "./infra"

export interface InspectTarget {
	readonly kind: InfraEntityKind
	readonly name: string
	readonly namespace?: string | undefined
	readonly host?: string | undefined
	readonly workloadKind?: WorkloadKind | undefined
}

export interface InspectResult {
	readonly found: boolean
	readonly entity?: InfraEntityRow
	readonly firstSeen?: string
	readonly details?: Record<string, string>
	readonly series: ReadonlyArray<InfraSeriesStats>
	readonly children?: InfraKindSection
}

const NOT_FOUND: InspectResult = { found: false, series: [] }
const CHILD_LIMIT = 10
/** Pods of a workload whose own memory series is shown, highest peak first. */
const PER_POD_SERIES = 3

/** Keeps only the details a collector actually reported. */
const details = (entries: ReadonlyArray<readonly [string, string]>): Record<string, string> =>
	Object.fromEntries(entries.filter(([, value]) => value !== ""))

export const inspectInfra = (target: InspectTarget, window: InfraWindow) =>
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		const params = { orgId: executor.orgId, startTime: window.startTime, endTime: window.endTime }
		const seriesParams = { ...params, bucketSeconds: bucketSecondsFor(window) }
		const series = <Row>(query: CH.CompiledQueryInput<Row>, context: string) =>
			executor.compiledQuery(query, { profile: "aggregation", context })
		const first = <Row>(query: CH.CompiledQueryInput<Row>, context: string) =>
			executor
				.compiledQuery(query, { profile: "aggregation", context })
				.pipe(Effect.map((rows) => rows[0]))
		const children = (
			kind: "pods" | "containers",
			filters: Parameters<typeof listInfraKind>[1]["filters"],
		) => listInfraKind(kind, { window, filters, sort: "saturation", limit: CHILD_LIMIT })

		switch (target.kind) {
			case "host": {
				const host = target.name
				const [summary, cpu, memory, load, filesystems] = yield* Effect.all(
					[
						first(
							CH.compile(CH.hostDetailSummaryQuery({ hostName: host }), params),
							"hostDetailSummary",
						),
						series(
							CH.compile(
								CH.hostGaugeTimeseriesQuery({
									hostName: host,
									metricName: "system.cpu.utilization",
									groupByAttributeKey: "state",
								}),
								seriesParams,
							),
							"hostInfraGaugeTimeseries",
						),
						series(
							CH.compile(
								CH.hostGaugeTimeseriesQuery({
									hostName: host,
									metricName: "system.memory.utilization",
									groupByAttributeKey: "state",
								}),
								seriesParams,
							),
							"hostInfraGaugeTimeseries",
						),
						series(
							CH.compile(
								CH.hostGaugeTimeseriesQuery({
									hostName: host,
									metricName: "system.cpu.load_average.15m",
								}),
								seriesParams,
							),
							"hostInfraGaugeTimeseries",
						),
						series(
							CH.compile(CH.hostFilesystemsQuery({ hostName: host }), params),
							"hostFilesystems",
						),
					],
					{ concurrency: 5 },
				)
				if (summary === undefined) return NOT_FOUND
				const containers = yield* children("containers", { host })
				return {
					found: true,
					entity: {
						name: summary.hostName,
						lastSeen: iso(summary.lastSeen),
						...(summary.osType ? { os: summary.osType } : undefined),
						cpu: summary.cpuPct,
						memory: summary.memoryPct,
						disk: summary.diskPct,
						load15: summary.load15,
					},
					firstSeen: iso(summary.firstSeen),
					details: details([
						["arch", summary.hostArch],
						["cloud.provider", summary.cloudProvider],
						["cloud.region", summary.cloudRegion],
						...filesystems.map((fs): readonly [string, string] => [
							`disk ${fs.mountpoint}`,
							`${formatPercent(fs.usedMax)} full at most (avg ${formatPercent(fs.usedAvg)})${fs.device ? `, ${fs.device}` : ""}`,
						]),
					]),
					series: [
						...seriesStats({ label: "cpu busy", unit: "fraction" }, busyFraction(cpu)),
						...seriesStats({ label: "memory used", unit: "fraction" }, onlyGroup(memory, "used")),
						...seriesStats({ label: "load average (15m)", unit: "load" }, ungrouped(load)),
					],
					...(containers.rows.length > 0 ? { children: containers } : undefined),
				} satisfies InspectResult
			}
			case "pod": {
				const pod = { podName: target.name, namespace: target.namespace }
				const podSeries = (metricName: string) =>
					series(
						CH.compile(CH.podGaugeTimeseriesQuery({ ...pod, metricName }), seriesParams),
						"podInfraTimeseries",
					)
				const [summary, cores, cpuLimit, memoryLimit, workingSet, restarts] = yield* Effect.all(
					[
						first(CH.compile(CH.podDetailSummaryQuery(pod), params), "podDetailSummary"),
						podSeries("k8s.pod.cpu.usage"),
						podSeries("k8s.pod.cpu_limit_utilization"),
						podSeries("k8s.pod.memory_limit_utilization"),
						podSeries("k8s.pod.memory.working_set"),
						series(
							CH.compile(
								CH.podRestartsQuery({ podNames: [target.name], namespace: target.namespace }),
								params,
							),
							"podRestarts",
						),
					],
					{ concurrency: 6 },
				)
				if (summary === undefined) return NOT_FOUND
				const restarted = restarts.reduce((sum, row) => sum + row.restarts, 0)
				// The limit itself is not collected; working set over its share of the limit recovers it.
				const workingSetAvg = seriesStats({ label: "", unit: "bytes" }, ungrouped(workingSet))[0]?.avg
				const memoryLimitBytes =
					workingSetAvg !== undefined && summary.memoryLimitPct > 0
						? workingSetAvg / summary.memoryLimitPct
						: undefined
				const workload = summary.deploymentName || summary.statefulsetName || summary.daemonsetName
				const workloadKind = summary.deploymentName
					? "deployment"
					: summary.statefulsetName
						? "statefulset"
						: summary.daemonsetName
							? "daemonset"
							: undefined
				return {
					found: true,
					entity: {
						name: summary.podName,
						lastSeen: iso(summary.lastSeen),
						...(summary.namespace ? { namespace: summary.namespace } : undefined),
						...(summary.nodeName ? { node: summary.nodeName } : undefined),
						...(workloadKind === undefined ? undefined : { workload, workloadKind }),
						cpuCores: summary.cpuUsage,
						cpu: summary.cpuLimitPct,
						memory: summary.memoryLimitPct,
						saturation: Math.max(summary.cpuLimitPct, summary.memoryLimitPct),
						...(summary.cpuLimitPct === 0 && summary.memoryLimitPct === 0
							? { unbounded: true }
							: undefined),
						...(restarts.length > 0 ? { restarts: restarted } : undefined),
					},
					firstSeen: iso(summary.firstSeen),
					details: details([
						["qos class", summary.qosClass],
						["pod uid", summary.podUid],
						["pod started", summary.podStartTime],
						["compute type", summary.computeType],
						[
							"memory limit",
							memoryLimitBytes === undefined
								? ""
								: `about ${Math.round(memoryLimitBytes / 2 ** 20)} MiB (working set ÷ % of limit)`,
						],
						...restarts.map((row): readonly [string, string] => [
							`restarts of container ${row.containerName}`,
							`${row.restarts} in this window (${row.totalRestarts} since the pod started)`,
						]),
						[
							"CPU vs request (avg)",
							summary.cpuRequestPct > 0
								? `${formatPercent(summary.cpuRequestPct)} (above 100% is allowed up to the limit)`
								: "",
						],
						[
							"memory vs request (avg)",
							summary.memoryRequestPct > 0
								? `${formatPercent(summary.memoryRequestPct)} (above 100% is allowed up to the limit)`
								: "",
						],
					]),
					series: [
						...seriesStats({ label: "cpu cores", unit: "cores" }, ungrouped(cores)),
						...seriesStats({ label: "cpu % of limit", unit: "fraction" }, ungrouped(cpuLimit)),
						...seriesStats(
							{ label: "memory % of limit", unit: "fraction" },
							ungrouped(memoryLimit),
						),
						...seriesStats({ label: "memory working set", unit: "bytes" }, ungrouped(workingSet)),
					],
				} satisfies InspectResult
			}
			case "node": {
				const node = target.name
				const [summary, cores] = yield* Effect.all(
					[
						first(
							CH.compile(CH.nodeDetailSummaryQuery({ nodeName: node }), params),
							"nodeDetailSummary",
						),
						series(
							CH.compile(
								CH.nodeGaugeTimeseriesQuery({
									nodeName: node,
									metricName: "k8s.node.cpu.usage",
								}),
								seriesParams,
							),
							"nodeInfraTimeseries",
						),
					],
					{ concurrency: 2 },
				)
				if (summary === undefined) return NOT_FOUND
				const [pods, peers] = yield* Effect.all(
					[
						children("pods", { node }),
						listInfraKind("nodes", { window, filters: {}, sort: "cpu", limit: CHILD_LIMIT }),
					],
					{ concurrency: 2 },
				)
				const podCores = pods.rows.reduce((sum, pod) => sum + (pod.cpuCores ?? 0), 0)
				const allPods = pods.summary === undefined || pods.rows.length >= pods.summary.total
				const others = peers.rows.filter((peer) => peer.name !== summary.nodeName)
				return {
					found: true,
					entity: {
						name: summary.nodeName,
						lastSeen: iso(summary.lastSeen),
						cpuCores: summary.cpuUsage,
						uptimeSeconds: summary.uptime,
					},
					firstSeen: iso(summary.firstSeen),
					details: details([
						["node uid", summary.nodeUid],
						["kubelet", summary.kubeletVersion],
						["container runtime", summary.containerRuntime],
						[
							"CPU by pods",
							pods.rows.length === 0
								? ""
								: `${allPods ? "its" : `the ${pods.rows.length} busiest of its`} pods use ${podCores.toFixed(2)} of the node's ${summary.cpuUsage.toFixed(2)} cores (avg); the rest is the kubelet and system daemons${allPods ? "" : " and pods not listed"}`,
						],
						[
							"other nodes (CPU cores, avg)",
							others
								.map((peer) => `${peer.name} ${(peer.cpuCores ?? 0).toFixed(2)}`)
								.join(", "),
						],
						[
							"capacity",
							"not collected: compare with the other nodes, or the pods against their limits",
						],
					]),
					series: seriesStats({ label: "cpu cores", unit: "cores" }, ungrouped(cores)),
					...(pods.rows.length > 0 ? { children: pods } : undefined),
				} satisfies InspectResult
			}
			case "workload":
				return yield* inspectWorkload(target, window)
			case "container": {
				const container = { containerName: target.name, hostName: target.host }
				const [summary, counters, cpu, memory] = yield* Effect.all(
					[
						first(
							CH.compile(CH.containerDetailSummaryQuery(container), params),
							"containerDetailSummary",
						),
						first(
							CH.compile(CH.containerCountersSummaryQuery(container), params),
							"containerCountersSummary",
						),
						series(
							CH.compile(
								CH.containerGaugeTimeseriesQuery({
									...container,
									metricName: "container.cpu.utilization",
									divideBy: 100,
								}),
								seriesParams,
							),
							"containerInfraTimeseries",
						),
						series(
							CH.compile(
								CH.containerGaugeTimeseriesQuery({
									...container,
									metricName: "container.memory.percent",
									divideBy: 100,
								}),
								seriesParams,
							),
							"containerInfraTimeseries",
						),
					],
					{ concurrency: 4 },
				)
				if (summary === undefined) return NOT_FOUND
				return {
					found: true,
					entity: {
						name: summary.containerName,
						lastSeen: iso(summary.lastSeen),
						...(summary.hostName ? { host: summary.hostName } : undefined),
						...(summary.imageName ? { image: summary.imageName } : undefined),
						...(summary.composeService
							? { workload: summary.composeService, workloadKind: "compose" }
							: undefined),
						cpu: summary.cpuPct,
						memory: summary.memoryPct,
						uptimeSeconds: summary.uptimeSeconds,
					},
					firstSeen: iso(summary.firstSeen),
					details: details([
						["container id", summary.containerId],
						["runtime", summary.runtime],
						["compose project", summary.composeProject],
						["cpu limit (cores)", summary.cpuLimitCores > 0 ? String(summary.cpuLimitCores) : ""],
						["restarts in window", counters === undefined ? "" : String(counters.restartsDelta)],
						[
							"memory limit (bytes)",
							counters !== undefined && counters.memoryLimitBytes > 0
								? String(counters.memoryLimitBytes)
								: "",
						],
					]),
					series: [
						...seriesStats({ label: "cpu", unit: "fraction" }, ungrouped(cpu)),
						...seriesStats({ label: "memory", unit: "fraction" }, ungrouped(memory)),
					],
				} satisfies InspectResult
			}
		}
	})

/** A workload name does not say its kind, so an unqualified one is looked up under each. */
const inspectWorkload = (target: InspectTarget, window: InfraWindow) =>
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		const params = { orgId: executor.orgId, startTime: window.startTime, endTime: window.endTime }
		const kinds = target.workloadKind === undefined ? WORKLOAD_KINDS : [target.workloadKind]
		const matches = yield* Effect.forEach(
			kinds,
			(kind) =>
				executor
					.compiledQuery(
						CH.compile(
							CH.workloadDetailSummaryQuery({
								kind,
								workloadName: target.name,
								namespace: target.namespace,
							}),
							params,
						),
						{ profile: "aggregation", context: "workloadDetailSummary" },
					)
					.pipe(Effect.map((rows) => rows.map((row) => ({ kind, row })))),
			{ concurrency: 3 },
		)
		const match = matches.flat().sort((a, b) => b.row.podCount - a.row.podCount)[0]
		if (match === undefined) return NOT_FOUND
		const { kind, row } = match
		const workload = { kind, workloadName: target.name, namespace: target.namespace }
		const seriesParams = { ...params, bucketSeconds: bucketSecondsFor(window) }
		const workloadSeries = (metricName: string) =>
			executor.compiledQuery(
				CH.compile(CH.workloadGaugeTimeseriesQuery({ ...workload, metricName }), seriesParams),
				{ profile: "aggregation", context: "workloadInfraTimeseries" },
			)
		const [cores, cpuLimit, memoryLimit, memoryByPod, pods] = yield* Effect.all(
			[
				workloadSeries("k8s.pod.cpu.usage"),
				workloadSeries("k8s.pod.cpu_limit_utilization"),
				workloadSeries("k8s.pod.memory_limit_utilization"),
				executor.compiledQuery(
					CH.compile(
						CH.workloadGaugeTimeseriesQuery({
							...workload,
							metricName: "k8s.pod.memory_limit_utilization",
							groupByPod: true,
						}),
						seriesParams,
					),
					{ profile: "aggregation", context: "workloadInfraTimeseries" },
				),
				listInfraKind("pods", {
					window,
					filters: { workloadKind: kind, workload: target.name, namespace: target.namespace },
					sort: "saturation",
					limit: CHILD_LIMIT,
				}),
			],
			{ concurrency: 5 },
		)
		const podPeaks = Object.entries(Arr.groupBy(memoryByPod, (r) => r.attributeValue))
			.flatMap(([pod, rows]) =>
				seriesStats({ label: "memory % of limit", unit: "fraction" }, ungrouped(rows), pod),
			)
			.sort((a, b) => b.max - a.max)
			.slice(0, PER_POD_SERIES)
		return {
			found: true,
			entity: {
				name: row.workloadName,
				lastSeen: iso(row.lastSeen),
				workloadKind: kind,
				...(row.namespace ? { namespace: row.namespace } : undefined),
				podCount: row.podCount,
				cpuCores: row.avgCpuUsage,
				cpu: row.avgCpuLimitPct,
				memory: row.avgMemoryLimitPct,
				saturation: Math.max(row.avgCpuLimitPct, row.avgMemoryLimitPct),
				...(row.avgCpuLimitPct === 0 && row.avgMemoryLimitPct === 0
					? { unbounded: true }
					: undefined),
			},
			firstSeen: iso(row.firstSeen),
			series: [
				...seriesStats({ label: "cpu cores (avg per pod)", unit: "cores" }, ungrouped(cores)),
				...seriesStats(
					{ label: "cpu % of limit (avg per pod)", unit: "fraction" },
					ungrouped(cpuLimit),
				),
				...seriesStats(
					{ label: "memory % of limit (avg per pod)", unit: "fraction" },
					ungrouped(memoryLimit),
				),
				...podPeaks,
			],
			...(pods.rows.length > 0 ? { children: pods } : undefined),
		} satisfies InspectResult
	})
