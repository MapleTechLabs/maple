/**
 * A small infrastructure world for the infra tools' tests and usability runs: one Kubernetes
 * cluster where a checkout pod runs out of memory, a CI host whose build container pins the CPU,
 * and a quiet bastion. Every entity is a curve over the window; list aggregates (avg, peak) and
 * time series are both sampled from it, so the two views agree the way real data would. Rows
 * answer the compiled SQL, honoring its name filters, sort and limit.
 */
import { parseWarehouseDateTime } from "@maple/query-engine"
import type { FixtureRule } from "./fake-warehouse"

export const INFRA_WORLD = {
	cluster: "prod-eu",
	environment: "production",
	/** Climbs to 98% of its memory limit 70% through the window, then drops: an OOM kill. */
	oomPod: "checkout-6f9c7d-k2x8p",
	hotNode: "ip-10-0-3-57",
	hotHost: "ci-runner-01",
	hotContainer: "buildkitd",
	unboundedWorkload: "otel-agent",
} as const

/** Value at t in [0, 1) across the window. */
type Curve = (t: number) => number

const SAMPLES = 60
const samples = (curve: Curve) => Array.from({ length: SAMPLES }, (_, i) => curve(i / SAMPLES))
const avgOf = (curve: Curve) => samples(curve).reduce((sum, v) => sum + v, 0) / SAMPLES
const peakOf = (curve: Curve) => Math.max(...samples(curve))

/** Three full periods across the window, so the mean is `base` and the peak `base * (1 + amp)`. */
const wave =
	(base: number, amp = 0.08): Curve =>
	(t) =>
		base * (1 + amp * Math.sin(2 * Math.PI * 3 * t))
const OOM_PEAK_AT = 0.7
const oom: Curve = (t) => (t <= OOM_PEAK_AT ? 0.55 + (0.98 - 0.55) * (t / OOM_PEAK_AT) : 0.45)

type OwnerKind = "deployment" | "statefulset" | "daemonset"

interface Pod {
	readonly podName: string
	readonly namespace: string
	readonly nodeName: string
	readonly owner: readonly [OwnerKind, string]
	readonly cpu: Curve
	/** 0 when no limit is set. */
	readonly cpuLimitCores: number
	/** Fraction of the memory limit; never sampled when no limit is set. */
	readonly memory: Curve
	readonly unbounded: boolean
}

const pod = (
	podName: string,
	namespace: string,
	nodeName: string,
	owner: Pod["owner"],
	cores: number,
	cpuLimitCores: number,
	memory: Curve,
): Pod => ({
	podName,
	namespace,
	nodeName,
	owner,
	cpu: wave(cores, 0.25),
	cpuLimitCores,
	memory,
	unbounded: cpuLimitCores === 0,
})

const PODS: ReadonlyArray<Pod> = [
	pod("checkout-6f9c7d-k2x8p", "shop", "ip-10-0-3-57", ["deployment", "checkout"], 0.41, 1, oom),
	pod("checkout-6f9c7d-p9wq2", "shop", "ip-10-0-3-21", ["deployment", "checkout"], 0.33, 1, wave(0.58)),
	pod("checkout-6f9c7d-z7m4c", "shop", "ip-10-0-3-21", ["deployment", "checkout"], 0.35, 1, wave(0.55)),
	pod("cart-5b8d9-h3j5k", "shop", "ip-10-0-3-21", ["deployment", "cart"], 0.12, 0.5, wave(0.31)),
	pod("cart-5b8d9-r2t6y", "shop", "ip-10-0-3-57", ["deployment", "cart"], 0.11, 0.5, wave(0.3)),
	pod(
		"api-gateway-7c4f-a1b2c",
		"edge",
		"ip-10-0-3-57",
		["deployment", "api-gateway"],
		0.62,
		1.25,
		wave(0.44),
	),
	pod(
		"api-gateway-7c4f-d3e4f",
		"edge",
		"ip-10-0-3-21",
		["deployment", "api-gateway"],
		0.58,
		1.25,
		wave(0.42),
	),
	pod("postgres-0", "data", "ip-10-0-3-57", ["statefulset", "postgres"], 0.9, 2, wave(0.72)),
	pod("otel-agent-x8k2l", "observability", "ip-10-0-3-21", ["daemonset", "otel-agent"], 0.22, 0, () => 0),
	pod("otel-agent-q4w9e", "observability", "ip-10-0-3-57", ["daemonset", "otel-agent"], 0.27, 0, () => 0),
]

const NODES = [
	{ nodeName: "ip-10-0-3-21", nodeUid: "4f1c-21", kubeletVersion: "v1.31.2", uptime: 1_814_400 },
	{ nodeName: "ip-10-0-3-57", nodeUid: "9a7e-57", kubeletVersion: "v1.31.2", uptime: 86_400 },
]
/** System daemons outside any pod. */
const NODE_OVERHEAD_CORES = 0.3
const nodeCpu =
	(nodeName: string): Curve =>
	(t) =>
		PODS.filter((p) => p.nodeName === nodeName).reduce((sum, p) => sum + p.cpu(t), NODE_OVERHEAD_CORES)

const HOSTS = [
	{
		hostName: "ci-runner-01",
		osType: "linux",
		hostArch: "amd64",
		cpu: wave(0.91, 0.04),
		memory: wave(0.64),
		load15: wave(7.8, 0.1),
		filesystems: [
			{ mountpoint: "/var/lib/docker", device: "/dev/nvme1n1", used: 0.93 },
			{ mountpoint: "/", device: "/dev/nvme0n1p1", used: 0.41 },
		],
	},
	{
		hostName: "bastion-01",
		osType: "linux",
		hostArch: "arm64",
		cpu: wave(0.04, 0.5),
		memory: wave(0.21),
		load15: wave(0.05, 0.5),
		filesystems: [{ mountpoint: "/", device: "/dev/nvme0n1p1", used: 0.38 }],
	},
]

const CONTAINERS = [
	{
		containerName: "buildkitd",
		hostName: "ci-runner-01",
		imageName: "moby/buildkit:v0.17.0",
		composeService: "buildkit",
		cpu: wave(0.8, 0.22),
		memory: wave(0.52, 0.12),
		cpuLimitCores: 4,
		restarts: 2,
	},
	{
		containerName: "registry-cache",
		hostName: "ci-runner-01",
		imageName: "registry:2",
		composeService: "registry",
		cpu: wave(0.06, 0.5),
		memory: wave(0.4, 0.03),
		cpuLimitCores: 0,
		restarts: 0,
	},
]

/** The window the SQL asked for, from its first two DateTime literals. */
const windowOf = (sql: string): { start: number; end: number } => {
	const stamps = [...sql.matchAll(/'(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)'/g)].map((m) =>
		parseWarehouseDateTime(m[1] ?? ""),
	)
	const start = stamps[0] ?? parseWarehouseDateTime("2026-10-01 06:00:00")
	const end = stamps[1] ?? start + 6 * 3_600_000
	return { start, end }
}

const fmt = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ")
const lastSeen = (sql: string) => fmt(windowOf(sql).end - 30_000)
const firstSeen = (sql: string) => fmt(windowOf(sql).start + 30_000)

/** Values for `ResourceAttributes['key'] = 'v'` or `IN ('a', 'b')` in the SQL; undefined when unfiltered. */
const filterValues = (sql: string, key: string): ReadonlyArray<string> | undefined => {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const eq = [...sql.matchAll(new RegExp(`\\['${escaped}'\\] = '([^']*)'`, "g"))].map((m) => m[1] ?? "")
	const inList = [...sql.matchAll(new RegExp(`\\['${escaped}'\\] IN \\(([^)]*)\\)`, "g"))].flatMap((m) =>
		[...(m[1] ?? "").matchAll(/'([^']*)'/g)].map((v) => v[1] ?? ""),
	)
	const all = [...eq, ...inList]
	return all.length === 0 ? undefined : all
}

const matches = (sql: string, key: string, value: string): boolean => {
	const wanted = filterValues(sql, key)
	return wanted === undefined || wanted.includes(value)
}

const searched = (sql: string, name: string): boolean => {
	const term = /positionCaseInsensitive\([^,]+, '([^']*)'\)/.exec(sql)?.[1]?.toLowerCase()
	return term === undefined || name.toLowerCase().includes(term)
}

const limitOf = (sql: string): number => Number([...sql.matchAll(/LIMIT (\d+)/g)].at(-1)?.[1] ?? 1000)

const OWNER_KINDS: ReadonlyArray<OwnerKind> = ["deployment", "statefulset", "daemonset"]

const podsFor = (sql: string): ReadonlyArray<Pod> =>
	PODS.filter(
		(p) =>
			matches(sql, "k8s.pod.name", p.podName) &&
			matches(sql, "k8s.namespace.name", p.namespace) &&
			matches(sql, "k8s.node.name", p.nodeName) &&
			matches(sql, "k8s.cluster.name", INFRA_WORLD.cluster) &&
			// An owner filter of any kind selects only pods owned by that kind and name.
			OWNER_KINDS.every((kind) => {
				const wanted = filterValues(sql, `k8s.${kind}.name`)
				return wanted === undefined || (p.owner[0] === kind && wanted.includes(p.owner[1]))
			}) &&
			searched(sql, p.podName),
	)

const podStats = (p: Pod) => {
	const cpuUsage = avgOf(p.cpu)
	const cpuUsagePeak = peakOf(p.cpu)
	const ofLimit = (cores: number) => (p.cpuLimitCores === 0 ? 0 : cores / p.cpuLimitCores)
	const memoryLimitPct = p.unbounded ? 0 : avgOf(p.memory)
	const memoryLimitPctPeak = p.unbounded ? 0 : peakOf(p.memory)
	return {
		cpuUsage,
		cpuUsagePeak,
		cpuLimitPct: ofLimit(cpuUsage),
		cpuLimitPctPeak: ofLimit(cpuUsagePeak),
		memoryLimitPct,
		memoryLimitPctPeak,
		saturation: Math.max(ofLimit(cpuUsagePeak), memoryLimitPctPeak),
	}
}

const podListRow = (sql: string, p: Pod) => {
	const stats = podStats(p)
	return {
		podName: p.podName,
		namespace: p.namespace,
		nodeName: p.nodeName,
		clusterName: INFRA_WORLD.cluster,
		environment: INFRA_WORLD.environment,
		deploymentName: p.owner[0] === "deployment" ? p.owner[1] : "",
		statefulsetName: p.owner[0] === "statefulset" ? p.owner[1] : "",
		daemonsetName: p.owner[0] === "daemonset" ? p.owner[1] : "",
		jobName: "",
		qosClass: p.unbounded ? "BestEffort" : "Burstable",
		podUid: `uid-${p.podName}`,
		computeType: "",
		lastSeen: lastSeen(sql),
		...stats,
		cpuRequestPct: stats.cpuLimitPct * 2,
		memoryRequestPct: stats.memoryLimitPct * 1.5,
	}
}

const sortedPods = (sql: string) => {
	const rows = podsFor(sql).map((p) => podListRow(sql, p))
	// The first key of the last ORDER BY decides; later keys are tiebreaks.
	const key = /ORDER BY\s+(?:\w+\.)?(\w+)/i.exec(sql.slice(sql.lastIndexOf("ORDER BY")))?.[1]
	if (key === "podName") return rows.sort((a, b) => a.podName.localeCompare(b.podName))
	if (key === "cpuUsage") return rows.sort((a, b) => b.cpuUsage - a.cpuUsage)
	if (key === "memoryLimitPct") return rows.sort((a, b) => b.memoryLimitPct - a.memoryLimitPct)
	return rows.sort((a, b) => b.saturation - a.saturation)
}

/** Buckets across the SQL's window, sampled at the same points as the list aggregates. */
const series = (sql: string, curve: Curve, attributeValue = "") => {
	const { start, end } = windowOf(sql)
	const step = (end - start) / SAMPLES
	return Array.from({ length: SAMPLES }, (_, i) => ({
		bucket: fmt(start + i * step),
		attributeValue,
		avgValue: curve(i / SAMPLES),
	}))
}

const metricOf = (sql: string): string => /MetricName = '([^']+)'/.exec(sql)?.[1] ?? ""
const meanCurve =
	(curves: ReadonlyArray<Curve>): Curve =>
	(t) =>
		curves.reduce((sum, curve) => sum + curve(t), 0) / Math.max(1, curves.length)

const podSeries = (sql: string): ReturnType<typeof series> => {
	const pods = podsFor(sql)
	if (pods.length === 0) return []
	// A workload chart grouped by pod: one series per pod, labeled with its name.
	if (sql.includes("['k8s.pod.name'] AS attributeValue")) {
		return pods.flatMap((p) =>
			podSeries(sql.replace("['k8s.pod.name'] AS attributeValue", "")).length === 0
				? []
				: seriesForPod(sql, p),
		)
	}
	const bounded = pods.filter((p) => !p.unbounded)
	switch (metricOf(sql)) {
		case "k8s.pod.cpu.usage":
			return series(sql, meanCurve(pods.map((p) => p.cpu)))
		case "k8s.pod.cpu_limit_utilization":
			return bounded.length === 0
				? []
				: series(sql, meanCurve(bounded.map((p) => (t: number) => p.cpu(t) / p.cpuLimitCores)))
		case "k8s.pod.memory_limit_utilization":
			return bounded.length === 0 ? [] : series(sql, meanCurve(bounded.map((p) => p.memory)))
		case "k8s.pod.memory.working_set":
			return series(sql, meanCurve(pods.map(workingSet)))
		default:
			return []
	}
}

const seriesForPod = (sql: string, p: Pod) => {
	if (p.unbounded) return []
	switch (metricOf(sql)) {
		case "k8s.pod.cpu.usage":
			return series(sql, p.cpu, p.podName)
		case "k8s.pod.cpu_limit_utilization":
			return series(sql, (t) => p.cpu(t) / p.cpuLimitCores, p.podName)
		case "k8s.pod.memory_limit_utilization":
			return series(sql, p.memory, p.podName)
		case "k8s.pod.memory.working_set":
			return series(sql, workingSet(p), p.podName)
		default:
			return []
	}
}

/** The metrics this world reports, for metric discovery (`list_metrics`) and the query builder. */
interface WorldMetric {
	readonly name: string
	readonly type: "gauge" | "sum"
	readonly unit: string
	readonly service: string
	/** Resource key that names an entity, and each entity's value over the window. */
	readonly key: string
	readonly entities: ReadonlyArray<readonly [name: string, curve: Curve]>
}

const WORLD_METRICS: ReadonlyArray<WorldMetric> = [
	{
		name: "system.cpu.utilization",
		type: "gauge",
		unit: "1",
		service: "otel-collector",
		key: "host.name",
		entities: HOSTS.map((h) => [h.hostName, h.cpu]),
	},
	{
		name: "system.memory.utilization",
		type: "gauge",
		unit: "1",
		service: "otel-collector",
		key: "host.name",
		entities: HOSTS.map((h) => [h.hostName, h.memory]),
	},
	{
		name: "system.memory.usage",
		type: "gauge",
		unit: "By",
		service: "otel-collector",
		key: "host.name",
		entities: HOSTS.map((h) => [h.hostName, (t: number) => h.memory(t) * 16 * 2 ** 30]),
	},
	{
		name: "system.cpu.load_average.1m",
		type: "gauge",
		unit: "{thread}",
		service: "otel-collector",
		key: "host.name",
		entities: HOSTS.map((h) => [h.hostName, wave(avgOf(h.load15), 0.3)]),
	},
	{
		name: "system.disk.io",
		type: "sum",
		unit: "By",
		service: "otel-collector",
		key: "host.name",
		entities: HOSTS.map((h) => [h.hostName, wave(h.hostName === "ci-runner-01" ? 9e7 : 2e5, 0.5)]),
	},
	{
		name: "system.network.io",
		type: "sum",
		unit: "By",
		service: "otel-collector",
		key: "host.name",
		entities: HOSTS.map((h) => [h.hostName, wave(h.hostName === "ci-runner-01" ? 4e7 : 1e5, 0.5)]),
	},
	{
		name: "system.cpu.load_average.15m",
		type: "gauge",
		unit: "{thread}",
		service: "otel-collector",
		key: "host.name",
		entities: HOSTS.map((h) => [h.hostName, h.load15]),
	},
	{
		name: "system.filesystem.utilization",
		type: "gauge",
		unit: "1",
		service: "otel-collector",
		key: "host.name",
		entities: HOSTS.map((h) => [h.hostName, () => Math.max(...h.filesystems.map((fs) => fs.used))]),
	},
	{
		name: "k8s.pod.cpu.usage",
		type: "gauge",
		unit: "{cpu}",
		service: "k8s-agent",
		key: "k8s.pod.name",
		entities: PODS.map((p) => [p.podName, p.cpu]),
	},
	{
		name: "k8s.pod.memory_limit_utilization",
		type: "gauge",
		unit: "1",
		service: "k8s-agent",
		key: "k8s.pod.name",
		entities: PODS.filter((p) => !p.unbounded).map((p) => [p.podName, p.memory]),
	},
	{
		name: "k8s.pod.cpu_limit_utilization",
		type: "gauge",
		unit: "1",
		service: "k8s-agent",
		key: "k8s.pod.name",
		entities: PODS.filter((p) => !p.unbounded).map((p) => [
			p.podName,
			(t: number) => p.cpu(t) / p.cpuLimitCores,
		]),
	},
	{
		name: "k8s.node.cpu.usage",
		type: "gauge",
		unit: "{cpu}",
		service: "k8s-agent",
		key: "k8s.node.name",
		entities: NODES.map((n) => [n.nodeName, nodeCpu(n.nodeName)]),
	},
	{
		name: "container.cpu.utilization",
		type: "gauge",
		unit: "%",
		service: "docker-agent",
		key: "container.name",
		entities: CONTAINERS.map((c) => [c.containerName, (t: number) => c.cpu(t) * 100]),
	},
	{
		name: "container.memory.percent",
		type: "gauge",
		unit: "%",
		service: "docker-agent",
		key: "container.name",
		entities: CONTAINERS.map((c) => [c.containerName, (t: number) => c.memory(t) * 100]),
	},
]

/** A query-builder metric series: one row per bucket and group, grouped by a resource key or not at all. */
const builderSeries = (sql: string) => {
	const metric = WORLD_METRICS.find((m) => m.name === metricOf(sql))
	if (metric === undefined) return []
	const groupKey = /ResourceAttributes\['([^']+)'\] AS groupName/.exec(sql)?.[1]
	const groups: ReadonlyArray<readonly [string, Curve]> =
		groupKey === metric.key
			? metric.entities.filter(([name]) => matches(sql, metric.key, name))
			: [["", meanCurve(metric.entities.map(([, curve]) => curve))]]
	return groups.flatMap(([group, curve]) =>
		series(sql, curve, group).map((row) => ({
			bucket: row.bucket,
			serviceName: metric.service,
			attributeValue: group,
			groupName: group,
			avgValue: row.avgValue,
			minValue: row.avgValue,
			maxValue: row.avgValue,
			sumValue: row.avgValue,
			dataPointCount: 4,
		})),
	)
}

const metricCatalogRows = (sql: string) => {
	const term = /ilike\([^,]+, '%([^%']*)%'\)/i.exec(sql)?.[1]?.toLowerCase()
	return WORLD_METRICS.filter((m) => term === undefined || m.name.toLowerCase().includes(term)).map(
		(m) => ({
			metricName: m.name,
			metricType: m.type,
			serviceName: m.service,
			metricDescription: "",
			metricUnit: m.unit,
			dataPointCount: 14_400,
			firstSeen: firstSeen(sql),
			lastSeen: lastSeen(sql),
			isMonotonic: 0,
		}),
	)
}

/** Memory limits: 512 MiB for checkout and cart, 4 GiB for postgres; unlimited pods sit near 150 MiB. */
const MEMORY_LIMIT_BYTES = new Map([
	["checkout", 512 * 2 ** 20],
	["cart", 512 * 2 ** 20],
	["postgres", 4 * 2 ** 30],
	["api-gateway", 2 ** 30],
])
const workingSet =
	(p: Pod): Curve =>
	(t) =>
		p.unbounded ? 150 * 2 ** 20 : p.memory(t) * (MEMORY_LIMIT_BYTES.get(p.owner[1]) ?? 2 ** 30)

/** Container restarts: the OOM-killed checkout pod restarted once in the window. */
const RESTARTS = new Map<string, number>([[INFRA_WORLD.oomPod, 1]])

const has = (sql: string, alias: string) => sql.includes(` AS ${alias}`)

const workloadRows = (sql: string) => {
	const kind = OWNER_KINDS.find((k) => sql.includes(`['k8s.${k}.name']`))
	const owned = podsFor(sql).filter((p) => p.owner[0] === kind && searched(sql, p.owner[1]))
	const names = [...new Set(owned.map((p) => p.owner[1]))]
	return names.map((name) => {
		const pods = owned.filter((p) => p.owner[1] === name)
		const stats = pods.map(podStats)
		const mean = (f: (s: (typeof stats)[number]) => number) =>
			stats.reduce((sum, s) => sum + f(s), 0) / stats.length
		return {
			workloadName: name,
			kind,
			namespace: pods[0]?.namespace ?? "",
			clusterName: INFRA_WORLD.cluster,
			environment: INFRA_WORLD.environment,
			podCount: pods.length,
			firstSeen: firstSeen(sql),
			lastSeen: lastSeen(sql),
			avgCpuLimitPct: mean((s) => s.cpuLimitPct),
			avgMemoryLimitPct: mean((s) => s.memoryLimitPct),
			avgCpuUsage: mean((s) => s.cpuUsage),
		}
	})
}

const containerRow = (sql: string, c: (typeof CONTAINERS)[number]) => ({
	containerName: c.containerName,
	hostName: c.hostName,
	imageName: c.imageName,
	composeService: c.composeService,
	containerId: `c0ffee${c.containerName.length}`,
	composeProject: "ci",
	runtime: "docker",
	environment: "ci",
	firstSeen: firstSeen(sql),
	lastSeen: lastSeen(sql),
	cpuPct: avgOf(c.cpu),
	cpuPctPeak: peakOf(c.cpu),
	memoryPct: avgOf(c.memory),
	memoryPctPeak: peakOf(c.memory),
	cpuLimitCores: c.cpuLimitCores,
	uptimeSeconds: 5_400,
	saturation: Math.max(peakOf(c.cpu), peakOf(c.memory)),
})

export const infraFixtureRules = (): FixtureRule[] => [
	// Metric discovery and the query builder, so infra metrics can be found and charted.
	{ match: (sql) => has(sql, "groupName") && has(sql, "dataPointCount"), rows: builderSeries },
	{ match: (sql) => has(sql, "isMonotonic"), rows: metricCatalogRows },
	{
		match: (sql) => has(sql, "metricCount"),
		rows: [
			{
				metricType: "gauge",
				metricCount: WORLD_METRICS.length,
				dataPointCount: 14_400 * WORLD_METRICS.length,
			},
		],
	},
	{
		match: (sql) => has(sql, "surface"),
		rows: ["hosts", "containers", "k8sPods", "k8sNodes", "k8sWorkloads"].map((surface) => ({ surface })),
	},
	// Pod detail before pod list: both lead with podName.
	{
		match: (sql) => has(sql, "totalRestarts"),
		rows: (sql) =>
			podsFor(sql).map((p) => ({
				namespace: p.namespace,
				podName: p.podName,
				containerName: p.owner[1],
				restarts: RESTARTS.get(p.podName) ?? 0,
				totalRestarts: (RESTARTS.get(p.podName) ?? 0) + 2,
			})),
	},
	{
		match: (sql) => has(sql, "podStartTime"),
		rows: (sql) =>
			podsFor(sql)
				.slice(0, 1)
				.map((p) => ({
					...podListRow(sql, p),
					podStartTime: new Date(windowOf(sql).start - 3 * 86_400_000).toISOString(),
					firstSeen: firstSeen(sql),
				})),
	},
	{
		match: (sql) => has(sql, "livePods"),
		rows: (sql) => {
			const pods = sortedPods(sql)
			return [
				{
					livePods: pods.length,
					endedPods: 0,
					saturatedPods: pods.filter((p) => p.saturation >= 0.9).length,
					elevatedPods: pods.filter((p) => p.saturation >= 0.6 && p.saturation < 0.9).length,
					unboundedPods: pods.filter((p) => p.cpuLimitPct === 0 && p.memoryLimitPct === 0).length,
				},
			]
		},
	},
	{
		match: (sql) => has(sql, "podName") && has(sql, "cpuUsagePeak"),
		rows: (sql) => sortedPods(sql).slice(0, limitOf(sql)),
	},
	{
		match: (sql) => has(sql, "avgCpuLimitUtilization"),
		rows: (sql) => {
			if (!sql.includes("'checkout'")) return []
			const stats = PODS.filter((p) => p.owner[1] === "checkout").map(podStats)
			const mean = (f: (s: (typeof stats)[number]) => number) =>
				stats.reduce((sum, s) => sum + f(s), 0) / stats.length
			return [
				{
					serviceName: "checkout",
					workloadKind: "deployment",
					workloadName: "checkout",
					namespace: "shop",
					clusterName: INFRA_WORLD.cluster,
					podCount: stats.length,
					avgCpuLimitUtilization: mean((s) => s.cpuLimitPct),
					avgMemoryLimitUtilization: mean((s) => s.memoryLimitPct),
				},
			]
		},
	},
	{ match: (sql) => has(sql, "workloadName"), rows: workloadRows },
	{
		match: (sql) => has(sql, "kubeletVersion"),
		rows: (sql) =>
			NODES.filter((n) => matches(sql, "k8s.node.name", n.nodeName) && searched(sql, n.nodeName)).map(
				(n) => ({
					...n,
					cpuUsage: avgOf(nodeCpu(n.nodeName)),
					clusterName: INFRA_WORLD.cluster,
					environment: INFRA_WORLD.environment,
					containerRuntime: "containerd://1.7.22",
					firstSeen: firstSeen(sql),
					lastSeen: lastSeen(sql),
				}),
			),
	},
	{
		match: (sql) => has(sql, "totalContainers"),
		rows: (sql) => {
			const rows = CONTAINERS.filter((c) => matches(sql, "host.name", c.hostName)).map((c) =>
				containerRow(sql, c),
			)
			return [
				{
					totalContainers: rows.length,
					saturatedContainers: rows.filter((c) => c.saturation >= 0.9).length,
					elevatedContainers: rows.filter((c) => c.saturation >= 0.6 && c.saturation < 0.9).length,
					staleContainers: 0,
				},
			]
		},
	},
	{
		match: (sql) => has(sql, "restartsDelta"),
		rows: (sql) =>
			CONTAINERS.filter((c) => matches(sql, "container.name", c.containerName)).map((c) => ({
				memoryBytesAvg: 1_200_000_000,
				memoryLimitBytes: 2_147_483_648,
				restartsDelta: c.restarts,
				pidsAvg: 48,
			})),
	},
	{
		match: (sql) => has(sql, "composeService") || has(sql, "imageName"),
		rows: (sql) =>
			CONTAINERS.filter(
				(c) =>
					matches(sql, "container.name", c.containerName) &&
					matches(sql, "host.name", c.hostName) &&
					matches(sql, "compose.service", c.composeService) &&
					searched(sql, c.containerName),
			).map((c) => containerRow(sql, c)),
	},
	{
		match: (sql) => has(sql, "mountpoint"),
		rows: (sql) =>
			HOSTS.filter((h) => matches(sql, "host.name", h.hostName)).flatMap((h) =>
				h.filesystems.map((fs) => ({
					mountpoint: fs.mountpoint,
					device: fs.device,
					usedAvg: fs.used - 0.01,
					usedMax: fs.used,
				})),
			),
	},
	{
		match: (sql) => has(sql, "load15") || has(sql, "cloudRegion"),
		rows: (sql) =>
			HOSTS.filter((h) => matches(sql, "host.name", h.hostName) && searched(sql, h.hostName)).map(
				(h) => ({
					hostName: h.hostName,
					osType: h.osType,
					hostArch: h.hostArch,
					cpuPct: avgOf(h.cpu),
					memoryPct: avgOf(h.memory),
					diskPct: Math.max(...h.filesystems.map((fs) => fs.used)),
					load15: avgOf(h.load15),
					cloudProvider: "aws",
					cloudRegion: "eu-central-1",
					firstSeen: firstSeen(sql),
					lastSeen: lastSeen(sql),
				}),
			),
	},
	{
		match: (sql) => has(sql, "avgValue"),
		rows: (sql) => {
			const metric = metricOf(sql)
			if (metric.startsWith("k8s.pod.")) return podSeries(sql)
			if (metric === "k8s.node.cpu.usage") {
				const node = NODES.find((n) => n.nodeName === filterValues(sql, "k8s.node.name")?.[0])
				return node === undefined ? [] : series(sql, nodeCpu(node.nodeName))
			}
			const container = CONTAINERS.find(
				(c) => c.containerName === filterValues(sql, "container.name")?.[0],
			)
			if (metric === "container.cpu.utilization" && container) return series(sql, container.cpu)
			if (metric === "container.memory.percent" && container) return series(sql, container.memory)
			const host = HOSTS.find((h) => h.hostName === filterValues(sql, "host.name")?.[0])
			if (host === undefined) return []
			if (metric === "system.cpu.utilization")
				return [
					...series(sql, (t) => 1 - host.cpu(t), "idle"),
					...series(sql, (t) => host.cpu(t) * 0.8, "user"),
					...series(sql, (t) => host.cpu(t) * 0.2, "system"),
				]
			if (metric === "system.memory.utilization")
				return [
					...series(sql, host.memory, "used"),
					...series(sql, (t) => 1 - host.memory(t), "free"),
				]
			if (metric === "system.cpu.load_average.15m") return series(sql, host.load15)
			return []
		},
	},
]
