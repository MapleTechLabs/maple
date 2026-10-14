/** Markdown for infrastructure rows: one table layout per kind, shared by list_infra and inspect_infra. */
import type { InfraEntityRow, InfraKind, InfraKindSection } from "@maple/domain/mcp-outputs"
import { formatNumber, formatPercent, tableCell } from "./format"
import { doc, type DocBlock } from "./tool-doc"
import { HOT_THRESHOLD, LIMIT_THRESHOLD, pressure } from "./infra"
import { parseWarehouseDateTime } from "@maple/query-engine"

/** "21:54 to 22:54 UTC (1 hour)": the window with its length, so a default is visible. */
export const windowText = (range: { readonly start: string; readonly end: string }): string => {
	const minutes = Math.round(
		(parseWarehouseDateTime(range.end) - parseWarehouseDateTime(range.start)) / 60_000,
	)
	const length =
		minutes % 1440 === 0
			? `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`
			: minutes % 60 === 0
				? `${minutes / 60} hour${minutes === 60 ? "" : "s"}`
				: `${minutes} minutes`
	return `${range.start} to ${range.end} UTC (${length})`
}

export const KIND_NOUN = {
	hosts: "hosts",
	pods: "pods",
	nodes: "nodes",
	workloads: "workloads",
	containers: "containers",
} as const satisfies Record<InfraKind, string>

/** The `inspect_infra` kind for a `list_infra` kind. */
export const ENTITY_KIND = {
	hosts: "host",
	pods: "pod",
	nodes: "node",
	workloads: "workload",
	containers: "container",
} as const satisfies Record<InfraKind, string>

const pct = (value: number | undefined): string => (value === undefined ? "" : formatPercent(value))

/** "41.00% → 97.00%": the window average, then its peak when the kind reports one. */
const avgPeak = (avg: number | undefined, peak: number | undefined): string =>
	avg === undefined ? "" : peak === undefined ? pct(avg) : `${pct(avg)} → ${pct(peak)}`

/** A share of a limit; "no limit" rather than a misleading 0% when none is set. */
const limitPct = (row: InfraEntityRow, value: string): string => (row.unbounded ? "no limit" : value)

const cores = (value: number | undefined, peak?: number): string =>
	value === undefined
		? ""
		: peak === undefined
			? value.toFixed(2)
			: `${value.toFixed(2)} → ${peak.toFixed(2)}`

export const formatUptime = (seconds: number | undefined): string => {
	if (seconds === undefined || seconds <= 0) return ""
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`
	if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)}h`
	return `${(seconds / 86_400).toFixed(1)}d`
}

/** Peaks are against a limit for pods and containers; hosts have no limit, so their averages and fullest disk. */
const pressureText = (kind: InfraKind, resource: string, level: number): string => {
	if (kind === "hosts")
		return resource === "disk" ? `disk ${pct(level)} full` : `${resource} ${pct(level)} avg`
	const ofLimit = kind === "containers" ? "" : " of limit"
	return kind === "workloads"
		? `${resource} ${pct(level)}${ofLimit} avg`
		: `${resource} peaked at ${pct(level)}${ofLimit}`
}

/** Every resource at 60% or more, worst first, under the label of the worst. */
export const statusOf = (row: InfraEntityRow, kind: InfraKind): string => {
	if (row.unbounded) return "no limits set"
	const resources: ReadonlyArray<readonly [string, number | undefined]> = [
		["memory", row.memoryPeak ?? row.memory],
		["cpu", row.cpuPeak ?? row.cpu],
		["disk", row.disk],
	]
	const hot = resources
		.flatMap(([resource, level]) =>
			level !== undefined && level >= HOT_THRESHOLD ? [{ resource, level }] : [],
		)
		.sort((a, b) => b.level - a.level)
	const worst = hot[0]
	const restartText = row.restarts ? `${row.restarts} restart${row.restarts === 1 ? "" : "s"}` : ""
	if (worst === undefined) return restartText
	// Hosts have no limit to be at; their 90% is just high.
	const label = worst.level >= LIMIT_THRESHOLD ? (kind === "hosts" ? "HIGH" : "AT LIMIT") : "hot"
	const restarts = restartText === "" ? "" : `; ${restartText}`
	return `${label}: ${hot.map((h) => pressureText(kind, h.resource, h.level)).join(", ")}${restarts}`
}

const owner = (row: InfraEntityRow): string =>
	row.workload === undefined ? "" : `${row.workloadKind ?? ""}/${row.workload}`

export const kindTable = (section: InfraKindSection): DocBlock => {
	const rows = section.rows
	const status = (row: InfraEntityRow) => statusOf(row, section.kind)
	switch (section.kind) {
		case "hosts":
			return doc.table(
				[
					"Host",
					"CPU busy (avg)",
					"Memory used (avg)",
					"Fullest disk",
					"Load 15m (avg)",
					"OS",
					"Status",
					"Last seen",
				],
				rows.map((r) => [
					tableCell(r.name),
					pct(r.cpu),
					pct(r.memory),
					pct(r.disk),
					r.load15 === undefined ? "" : r.load15.toFixed(2),
					r.os ?? "",
					status(r),
					r.lastSeen,
				]),
			)
		case "pods":
			return doc.table(
				[
					"Pod",
					"Namespace",
					"Owner",
					"Node",
					"CPU cores avg → peak",
					"CPU of limit avg → peak",
					"Memory of limit avg → peak",
					"Status",
				],
				rows.map((r) => [
					tableCell(r.name),
					r.namespace ?? "",
					owner(r),
					r.node ?? "",
					cores(r.cpuCores, r.cpuCoresPeak),
					limitPct(r, avgPeak(r.cpu, r.cpuPeak)),
					limitPct(r, avgPeak(r.memory, r.memoryPeak)),
					status(r),
				]),
			)
		case "nodes":
			return doc.table(
				["Node", "Cluster", "CPU cores in use (avg)", "Uptime", "Last seen"],
				rows.map((r) => [
					tableCell(r.name),
					r.cluster ?? "",
					cores(r.cpuCores),
					formatUptime(r.uptimeSeconds),
					r.lastSeen,
				]),
			)
		case "workloads":
			return doc.table(
				[
					"Workload",
					"Kind",
					"Namespace",
					"Pods",
					"CPU cores per pod (avg)",
					"CPU of limit (avg)",
					"Memory of limit (avg)",
					"Status",
				],
				rows.map((r) => [
					tableCell(r.name),
					r.workloadKind ?? "",
					r.namespace ?? "",
					r.podCount === undefined ? "" : formatNumber(r.podCount),
					cores(r.cpuCores),
					limitPct(r, pct(r.cpu)),
					limitPct(r, pct(r.memory)),
					status(r),
				]),
			)
		case "containers":
			return doc.table(
				["Container", "Host", "Image", "CPU avg → peak", "Memory avg → peak", "Uptime", "Status"],
				rows.map((r) => [
					tableCell(r.name),
					r.host ?? "",
					tableCell(r.image ?? "", 50),
					avgPeak(r.cpu, r.cpuPeak),
					avgPeak(r.memory, r.memoryPeak),
					formatUptime(r.uptimeSeconds),
					status(r),
				]),
			)
	}
}

/** The metrics behind each kind, and how to chart them: query_data or create_dashboard on source=metrics. */
export const KIND_METRICS = {
	hosts: "Metrics: system.cpu.utilization (by state; busy = 1 - idle), system.memory.utilization, system.filesystem.utilization, system.cpu.load_average.15m. Chart per host with group_by resource.host.name.",
	pods: "Metrics: k8s.pod.cpu.usage (cores), k8s.pod.cpu_limit_utilization, k8s.pod.memory_limit_utilization. Chart per pod with group_by resource.k8s.pod.name.",
	nodes: "Metrics: k8s.node.cpu.usage (cores). Chart per node with group_by resource.k8s.node.name.",
	workloads:
		"Metrics: the pod metrics (k8s.pod.*) of the workload's pods. Chart per workload with group_by resource.k8s.deployment.name (or statefulset/daemonset).",
	containers:
		"Metrics: container.cpu.utilization and container.memory.percent (0-100), container.restarts. Chart per container with group_by resource.container.name.",
} as const satisfies Record<InfraKind, string>

/** What the CPU and memory percentages of a kind are measured against. */
export const KIND_BASIS = {
	hosts: "CPU and memory are the host's own utilization averaged over the window; disk is the fullest filesystem.",
	pods: "CPU and memory are measured against each pod's configured limit; status uses the window peak.",
	nodes: "CPU is cores in use; node capacity is not reported, so compare nodes with each other.",
	workloads: "CPU and memory are averaged across the workload's pods, against their limits.",
	containers:
		"CPU is a share of the host's CPUs; memory is a share of the container's memory limit (the host's memory when none is set); status uses the window peak.",
} as const satisfies Record<InfraKind, string>

export const summaryLine = (section: InfraKindSection, status?: string): string => {
	const s = section.summary
	const showing = section.rows.length
	const total = s?.total
	const noun = section.kind === "pods" ? "live pods" : KIND_NOUN[section.kind]
	const head =
		status !== undefined
			? `${formatNumber(showing)}${section.truncated ? "+" : ""} of ${total === undefined ? "the" : formatNumber(total)} ${noun} match status="${status}"`
			: total === undefined
				? `${formatNumber(showing)} ${KIND_NOUN[section.kind]}${section.truncated ? " shown (more exist)" : ""}`
				: `${formatNumber(total)} ${noun}${showing < total ? `, showing the top ${formatNumber(showing)}` : ""}`
	const parts = [
		head,
		s?.saturated === undefined || s.saturated === 0
			? undefined
			: `${formatNumber(s.saturated)} at a limit (peak ≥90%)`,
		s?.elevated === undefined || s.elevated === 0
			? undefined
			: `${formatNumber(s.elevated)} hot (peak 60-90%)`,
		s?.unbounded === undefined || s.unbounded === 0
			? undefined
			: `${formatNumber(s.unbounded)} running with no limits set (status="no_limits" lists them)`,
		s?.stale === undefined || s.stale === 0
			? undefined
			: `${formatNumber(s.stale)} stale (no recent scrape)`,
		s?.ended === undefined || s.ended === 0
			? undefined
			: `${formatNumber(s.ended)} ended in the window (include_ended=true lists them)`,
	]
	// A cut list must say whether it cut anything that matters.
	const flagged = (s?.saturated ?? 0) + (s?.elevated ?? 0) + (s?.unbounded ?? 0)
	const flaggedShown = section.rows.filter((row) => statusOf(row, section.kind) !== "").length
	const coverage =
		status === undefined && total !== undefined && showing < total && flagged > 0
			? flaggedShown >= flagged
				? " Every flagged one is shown."
				: ` ${formatNumber(flagged - flaggedShown)} flagged not shown: pass kind="${section.kind}" to list them.`
			: ""
	return `${parts.filter((part) => part !== undefined).join(", ")}.${coverage} ${KIND_BASIS[section.kind]}`
}

/** The row an agent should look at first: closest to a limit, when anything is hot. */
export const hottest = (section: InfraKindSection): InfraEntityRow | undefined =>
	[...section.rows]
		.filter((row) => !row.unbounded && pressure(row).level >= HOT_THRESHOLD)
		.sort((a, b) => pressure(b).level - pressure(a).level)[0]
