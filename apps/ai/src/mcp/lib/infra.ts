/**
 * Infrastructure reads for the MCP tools: the queries behind the web app's Infrastructure pages,
 * flattened onto one row shape so an agent reads hosts, pods and containers the same way.
 */
import { Array as Arr, DateTime, Effect } from "effect"
import type { OrgId } from "@maple/domain"
import { CH, formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import { WarehouseExecutor } from "@maple/query-engine/observability"
import type { InfraEntityRow, InfraKind, InfraKindSection, InfraSeriesStats } from "@maple/domain/mcp-outputs"

export type WorkloadKind = "deployment" | "statefulset" | "daemonset"
export const WORKLOAD_KINDS: ReadonlyArray<WorkloadKind> = ["deployment", "statefulset", "daemonset"]

export interface InfraWindow {
	readonly startTime: string
	readonly endTime: string
}

export interface InfraFilters {
	readonly search?: string | undefined
	readonly namespace?: string | undefined
	readonly cluster?: string | undefined
	readonly node?: string | undefined
	readonly host?: string | undefined
	readonly environment?: string | undefined
	readonly workloadKind?: WorkloadKind | undefined
	readonly workload?: string | undefined
	readonly status?: InfraStatusFilter | undefined
	/** Pods that stopped reporting during the window too (rollouts, OOM kills, scale-in). */
	readonly includeEnded?: boolean | undefined
}

/** `hot`: a peak at 60% or more; `at_limit`: 90% or more; `no_limits`: neither CPU nor memory limited. */
export type InfraStatusFilter = "hot" | "at_limit" | "no_limits"

export type InfraSort = "saturation" | "cpu" | "memory" | "name" | "last_seen"

/** Same `YYYY-MM-DD HH:mm:ss` UTC as the window, so a peak reads against its bounds. */
export const iso = (value: DateTime.Utc): string => formatWarehouseDateTime(DateTime.toEpochMillis(value))
const list = (value: string | undefined): ReadonlyArray<string> | undefined =>
	value === undefined ? undefined : [value]
const nonEmpty = (value: string): string | undefined => (value === "" ? undefined : value)

const compileParams = (orgId: OrgId, window: InfraWindow) => ({
	orgId,
	startTime: window.startTime,
	endTime: window.endTime,
})

/** Which kinds report telemetry in the window: the web sidebar's visibility gate. */
export const infraPresence = (window: InfraWindow) =>
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		const rows = yield* executor.compiledQuery(
			CH.compileUnion(CH.infraPresenceQuery(), compileParams(executor.orgId, window)),
			{ profile: "discovery", context: "infraPresence" },
		)
		const surfaces = new Set(rows.map((row) => row.surface))
		const kinds: Array<InfraKind> = []
		if (surfaces.has("hosts")) kinds.push("hosts")
		if (surfaces.has("k8sPods")) kinds.push("pods")
		if (surfaces.has("k8sNodes")) kinds.push("nodes")
		if (surfaces.has("k8sWorkloads")) kinds.push("workloads")
		if (surfaces.has("containers")) kinds.push("containers")
		return kinds
	})

const byNumberDesc =
	<A>(f: (a: A) => number | undefined) =>
	(a: A, b: A): number =>
		(f(b) ?? 0) - (f(a) ?? 0)

/** Sorts rows the warehouse could not sort for us (hosts, nodes, merged workload kinds). */
export const sortRows = (rows: ReadonlyArray<InfraEntityRow>, sort: InfraSort): Array<InfraEntityRow> => {
	const copy = [...rows]
	switch (sort) {
		case "name":
			return copy.sort((a, b) => a.name.localeCompare(b.name))
		case "last_seen":
			return copy.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
		case "cpu":
			return copy.sort(byNumberDesc((r) => r.cpuPeak ?? r.cpu ?? r.cpuCores))
		case "memory":
			return copy.sort(byNumberDesc((r) => r.memoryPeak ?? r.memory))
		case "saturation":
			return copy.sort(
				byNumberDesc(
					(r) =>
						r.saturation ??
						Math.max(r.cpuPeak ?? r.cpu ?? 0, r.memoryPeak ?? r.memory ?? 0, r.disk ?? 0),
				),
			)
	}
}

/** Thresholds the web app tones amber and red at. */
export const HOT_THRESHOLD = 0.6
export const LIMIT_THRESHOLD = 0.9

/**
 * The resource closest to its ceiling over the window: a pod's or container's peak against its
 * limit, a host's average CPU and memory and its fullest disk.
 */
export const pressure = (row: InfraEntityRow): { readonly resource: string; readonly level: number } => {
	const candidates: ReadonlyArray<readonly [string, number | undefined]> = [
		["memory", row.memoryPeak ?? row.memory],
		["cpu", row.cpuPeak ?? row.cpu],
		["disk", row.disk],
	]
	return candidates.reduce<{ resource: string; level: number }>(
		(best, [resource, level]) => (level !== undefined && level > best.level ? { resource, level } : best),
		{ resource: "cpu", level: 0 },
	)
}

const keep =
	(status: InfraStatusFilter | undefined) =>
	(row: InfraEntityRow): boolean => {
		switch (status) {
			case undefined:
				return true
			case "no_limits":
				return row.unbounded === true
			case "hot":
				return pressure(row).level >= HOT_THRESHOLD
			case "at_limit":
				return pressure(row).level >= LIMIT_THRESHOLD
		}
	}

const podSortKey = (sort: InfraSort) => {
	switch (sort) {
		case "saturation":
			return "saturation" as const
		case "cpu":
			return "cpuUsage" as const
		case "memory":
			return "memoryLimitPct" as const
		case "name":
			return "podName" as const
		case "last_seen":
			return "lastSeen" as const
	}
}

const containerSortKey = (sort: InfraSort) => {
	switch (sort) {
		case "saturation":
			return "saturation" as const
		case "cpu":
			return "cpuPct" as const
		case "memory":
			return "memoryPct" as const
		case "name":
			return "containerName" as const
		case "last_seen":
			return "lastSeen" as const
	}
}

const podWorkload = (row: {
	readonly deploymentName: string
	readonly statefulsetName: string
	readonly daemonsetName: string
	readonly jobName?: string
}): { readonly workload?: string; readonly workloadKind?: string } => {
	if (row.deploymentName !== "") return { workload: row.deploymentName, workloadKind: "deployment" }
	if (row.statefulsetName !== "") return { workload: row.statefulsetName, workloadKind: "statefulset" }
	if (row.daemonsetName !== "") return { workload: row.daemonsetName, workloadKind: "daemonset" }
	if (row.jobName !== undefined && row.jobName !== "") return { workload: row.jobName, workloadKind: "job" }
	return {}
}

/** Kubernetes placement fields, each only when the collector reported it. */
const placement = (row: {
	readonly namespace?: string
	readonly clusterName?: string
	readonly environment?: string
	readonly nodeName?: string
	readonly hostName?: string
}) => ({
	...(row.namespace ? { namespace: row.namespace } : undefined),
	...(row.clusterName ? { cluster: row.clusterName } : undefined),
	...(row.environment ? { environment: row.environment } : undefined),
	...(row.nodeName ? { node: row.nodeName } : undefined),
	...(row.hostName ? { host: row.hostName } : undefined),
})

const hostRow = (row: CH.ListHostsOutput): InfraEntityRow => ({
	name: row.hostName,
	lastSeen: iso(row.lastSeen),
	...(row.osType ? { os: row.osType } : undefined),
	cpu: row.cpuPct,
	memory: row.memoryPct,
	disk: row.diskPct,
	load15: row.load15,
})

const podRow = (row: CH.ListPodsOutput): InfraEntityRow => ({
	name: row.podName,
	lastSeen: iso(row.lastSeen),
	...placement(row),
	...podWorkload(row),
	cpuCores: row.cpuUsage,
	cpuCoresPeak: row.cpuUsagePeak,
	cpu: row.cpuLimitPct,
	cpuPeak: row.cpuLimitPctPeak,
	memory: row.memoryLimitPct,
	memoryPeak: row.memoryLimitPctPeak,
	saturation: row.saturation,
	...(row.cpuLimitPct === 0 && row.memoryLimitPct === 0 ? { unbounded: true } : undefined),
})

const nodeRow = (row: CH.ListNodesOutput): InfraEntityRow => ({
	name: row.nodeName,
	lastSeen: iso(row.lastSeen),
	...placement(row),
	cpuCores: row.cpuUsage,
	uptimeSeconds: row.uptime,
})

const workloadRow = (kind: WorkloadKind, row: CH.ListWorkloadsOutput): InfraEntityRow => ({
	name: row.workloadName,
	lastSeen: iso(row.lastSeen),
	workloadKind: kind,
	...placement(row),
	podCount: row.podCount,
	cpuCores: row.avgCpuUsage,
	cpu: row.avgCpuLimitPct,
	memory: row.avgMemoryLimitPct,
	saturation: Math.max(row.avgCpuLimitPct, row.avgMemoryLimitPct),
	...(row.avgCpuLimitPct === 0 && row.avgMemoryLimitPct === 0 ? { unbounded: true } : undefined),
})

const containerRow = (row: CH.ListContainersOutput): InfraEntityRow => ({
	name: row.containerName,
	lastSeen: iso(row.lastSeen),
	...placement(row),
	...(row.imageName ? { image: row.imageName } : undefined),
	...(row.composeService ? { workload: row.composeService, workloadKind: "compose" } : undefined),
	cpu: row.cpuPct,
	cpuPeak: row.cpuPctPeak,
	memory: row.memoryPct,
	memoryPeak: row.memoryPctPeak,
	saturation: row.saturation,
	uptimeSeconds: row.uptimeSeconds,
})

/** Container restarts per pod in the window; pods the k8s_cluster receiver does not report are absent. */
const podRestarts = (podNames: ReadonlyArray<string>, params: ReturnType<typeof compileParams>) =>
	Effect.gen(function* () {
		if (podNames.length === 0) return new Map<string, number>()
		const executor = yield* WarehouseExecutor
		const rows = yield* executor.compiledQuery(
			CH.compile(CH.podRestartsQuery({ podNames, limit: podNames.length * 4 }), params),
			{ profile: "aggregation", context: "podRestarts" },
		)
		return new Map(
			Object.entries(Arr.groupBy(rows, (row) => row.podName)).map(([pod, containers]) => [
				pod,
				containers.reduce((sum, row) => sum + row.restarts, 0),
			]),
		)
	})

export interface ListKindOptions {
	readonly window: InfraWindow
	readonly filters: InfraFilters
	readonly sort: InfraSort
	readonly limit: number
}

/**
 * One page of a kind, ready to render. A status page over-fetches and filters, since those
 * thresholds are not scopes every warehouse query takes.
 */
export const listInfraKind = (kind: InfraKind, options: ListKindOptions) =>
	Effect.gen(function* () {
		const { filters, limit } = options
		const filtering = filters.status !== undefined
		const fetchLimit = filtering ? 500 : limit + 1
		const { rows, summary } = yield* fetchKind(kind, { ...options, limit: fetchLimit })
		const filtered = rows.filter(keep(filters.status))
		const sorted = kind === "pods" || kind === "containers" ? filtered : sortRows(filtered, options.sort)
		return {
			kind,
			...(summary === undefined ? undefined : { summary }),
			rows: sorted.slice(0, limit),
			truncated: sorted.length > limit || (filtering && rows.length >= fetchLimit),
		} satisfies InfraKindSection
	})

const fetchKind = (kind: InfraKind, options: ListKindOptions) =>
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		const params = compileParams(executor.orgId, options.window)
		const { filters, sort, limit } = options
		switch (kind) {
			case "hosts": {
				const rows = yield* executor.compiledQuery(
					CH.compile(CH.listHostsQuery({ search: filters.search ?? filters.host, limit }), params),
					{ profile: "list", context: "listHosts" },
				)
				return { rows: rows.map(hostRow), summary: undefined }
			}
			case "pods": {
				const podFilters = {
					search: filters.search,
					namespaces: list(filters.namespace),
					clusters: list(filters.cluster),
					nodeNames: list(filters.node),
					environments: list(filters.environment),
					...(filters.includeEnded ? { lifecycle: "all" as const } : undefined),
					...(filters.workload === undefined
						? undefined
						: {
								workloadKind: filters.workloadKind ?? "deployment",
								workloadName: filters.workload,
							}),
				}
				const [rows, counts] = yield* Effect.all(
					[
						executor.compiledQuery(
							CH.compile(
								CH.listPodsQuery({
									...podFilters,
									sortBy: podSortKey(sort),
									sortDir: sort === "name" ? "asc" : "desc",
									limit,
								}),
								params,
							),
							{ profile: "list", context: "listPods" },
						),
						executor.compiledQuery(CH.compile(CH.listPodsSummaryQuery(podFilters), params), {
							profile: "aggregation",
							context: "listPodsCount",
						}),
					],
					{ concurrency: 2 },
				)
				const count = counts[0]
				const restarts = yield* podRestarts(
					rows.map((row) => row.podName),
					params,
				)
				return {
					rows: rows.map((row) => {
						const pod = podRow(row)
						const restarted = restarts.get(row.podName)
						return restarted === undefined ? pod : { ...pod, restarts: restarted }
					}),
					summary:
						count === undefined
							? undefined
							: {
									total: count.livePods,
									saturated: count.saturatedPods,
									elevated: count.elevatedPods,
									unbounded: count.unboundedPods,
									ended: count.endedPods,
								},
				}
			}
			case "nodes": {
				const rows = yield* executor.compiledQuery(
					CH.compile(
						CH.listNodesQuery({
							search: filters.search ?? filters.node,
							clusters: list(filters.cluster),
							environments: list(filters.environment),
							limit,
						}),
						params,
					),
					{ profile: "list", context: "listNodes" },
				)
				return { rows: rows.map(nodeRow), summary: undefined }
			}
			case "workloads": {
				const kinds = filters.workloadKind === undefined ? WORKLOAD_KINDS : [filters.workloadKind]
				const perKind = yield* Effect.forEach(
					kinds,
					(workloadKind) =>
						executor
							.compiledQuery(
								CH.compile(
									CH.listWorkloadsQuery({
										kind: workloadKind,
										search: filters.search ?? filters.workload,
										namespaces: list(filters.namespace),
										clusters: list(filters.cluster),
										environments: list(filters.environment),
										limit,
									}),
									params,
								),
								{ profile: "list", context: "listWorkloads" },
							)
							.pipe(Effect.map((rows) => rows.map((row) => workloadRow(workloadKind, row)))),
					{ concurrency: 3 },
				)
				return { rows: perKind.flat(), summary: undefined }
			}
			case "containers": {
				const containerFilters = {
					search: filters.search,
					hostNames: list(filters.host),
					environments: list(filters.environment),
					composeServices: list(filters.workload),
				}
				const [rows, counts] = yield* Effect.all(
					[
						executor.compiledQuery(
							CH.compile(
								CH.listContainersQuery({
									...containerFilters,
									sortBy: containerSortKey(sort),
									sortDir: sort === "name" ? "asc" : "desc",
									limit,
								}),
								params,
							),
							{ profile: "list", context: "listContainers" },
						),
						executor.compiledQuery(
							CH.compile(CH.listContainersSummaryQuery(containerFilters), params),
							{
								profile: "aggregation",
								context: "listContainersCount",
							},
						),
					],
					{ concurrency: 2 },
				)
				const count = counts[0]
				return {
					rows: rows.map(containerRow),
					summary:
						count === undefined
							? undefined
							: {
									total: count.totalContainers,
									saturated: count.saturatedContainers,
									elevated: count.elevatedContainers,
									stale: count.staleContainers,
								},
				}
			}
		}
	})

// inspect_infra

interface SeriesRow {
	readonly bucket: DateTime.Utc
	readonly attributeValue: string
	readonly avgValue: number | null
}

interface SeriesSpec {
	readonly label: string
	readonly unit: InfraSeriesStats["unit"]
}

/** Condenses one bucketed series to the numbers an agent reasons with. Empty in, nothing out. */
export const seriesStats = (
	spec: SeriesSpec,
	points: ReadonlyArray<{ readonly bucket: DateTime.Utc; readonly value: number }>,
	group?: string,
): ReadonlyArray<InfraSeriesStats> => {
	const last = points.at(-1)
	if (last === undefined) return []
	const peak = points.reduce((best, point) => (point.value > best.value ? point : best), last)
	const values = points.map((point) => point.value)
	const third = Math.max(1, Math.floor(values.length / 3))
	const mean = (slice: ReadonlyArray<number>) => slice.reduce((sum, value) => sum + value, 0) / slice.length
	return [
		{
			label: spec.label,
			unit: spec.unit,
			...(group === undefined ? undefined : { group }),
			min: Math.min(...values),
			avg: values.reduce((sum, value) => sum + value, 0) / values.length,
			max: peak.value,
			last: last.value,
			maxAt: iso(peak.bucket),
			points: points.length,
			change: mean(values.slice(-third)) - mean(values.slice(0, third)),
		},
	]
}

/** A bucket with no samples averages to null: it is a gap, not a zero. */
export const ungrouped = (rows: ReadonlyArray<SeriesRow>) =>
	rows.flatMap((row) => (row.avgValue === null ? [] : [{ bucket: row.bucket, value: row.avgValue }]))

/**
 * Host CPU arrives per state, each a share of the CPU, so busy is 1 - idle per bucket.
 * A collector that drops the idle state leaves the sum of the rest.
 */
export const busyFraction = (rows: ReadonlyArray<SeriesRow>) => {
	const byBucket = Arr.groupBy(ungroupedWithState(rows), (row) => iso(row.bucket))
	return Object.values(byBucket).map((states) => {
		const first = states[0]
		const idle = states.find((state) => state.state === "idle")
		const busy = states.reduce((sum, state) => (state.state === "idle" ? sum : sum + state.value), 0)
		return { bucket: first.bucket, value: idle === undefined ? busy : Math.max(0, 1 - idle.value) }
	})
}

const ungroupedWithState = (rows: ReadonlyArray<SeriesRow>) =>
	rows.flatMap((row) =>
		row.avgValue === null ? [] : [{ bucket: row.bucket, state: row.attributeValue, value: row.avgValue }],
	)

export const onlyGroup = (rows: ReadonlyArray<SeriesRow>, value: string) =>
	ungrouped(rows.filter((row) => row.attributeValue === value))

/** About 60 points across the window, on whole minutes. */
export const bucketSecondsFor = (window: InfraWindow): number => {
	const seconds = (parseWarehouseDateTime(window.endTime) - parseWarehouseDateTime(window.startTime)) / 1000
	return Math.max(60, Math.ceil(seconds / 60 / 60) * 60)
}

// diagnose_service

const SERVICE_POD_LIMIT = 5

/**
 * The Kubernetes workload a service's spans name (via the collector's k8sattributes), and its
 * pods closest to a limit. Undefined when the service reports no k8s context.
 */
export const serviceInfrastructure = (service: string, window: InfraWindow) =>
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		const rows = yield* executor.compiledQuery(
			CH.serviceWorkloadsSQL({ services: [service] }, compileParams(executor.orgId, window)),
			{ profile: "aggregation", context: "serviceWorkloads" },
		)
		const workloads = rows.filter((row) => row.workloadName !== "")
		const dominant = workloads.find((row) => row.workloadKind !== "unknown")
		if (workloads.length === 0) return undefined
		const pods =
			dominant === undefined || dominant.workloadKind === "unknown"
				? []
				: (yield* listInfraKind("pods", {
						window,
						filters: {
							workloadKind: dominant.workloadKind,
							workload: dominant.workloadName,
							...(dominant.namespace ? { namespace: dominant.namespace } : undefined),
						},
						sort: "saturation",
						limit: SERVICE_POD_LIMIT,
					})).rows
		return {
			workloads: workloads.map((row) => ({
				kind: row.workloadKind,
				name: row.workloadName,
				namespace: row.namespace,
				...(row.clusterName ? { cluster: row.clusterName } : undefined),
				podCount: row.podCount,
				...(row.avgCpuLimitUtilization === null ? undefined : { cpu: row.avgCpuLimitUtilization }),
				...(row.avgMemoryLimitUtilization === null
					? undefined
					: { memory: row.avgMemoryLimitUtilization }),
			})),
			pods,
		}
	})
