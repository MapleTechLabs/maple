import { dependencyDrillWhereClause } from "../../../components/services/dependency-drill"
import type { DependencyKind } from "./derive-panels"
import type { DependencyBundle } from "./model-tabs"
import { Array as Arr, String as Str } from "effect"

// The rows, host folding and summary of the Dependencies tab.

export type DependencyRow = Readonly<{
	id: string
	kind: DependencyKind
	name: string
	subtitle: string | undefined
	callsPerSec: number
	tracedCallsPerSec: number
	totalCalls: number
	estimatedCalls: number
	errorRate: number
	avgDurationMs: number
	p95DurationMs: number
	hasSampling: boolean
	samplingWeight: number
	whereClause: string
}>

type EdgeStats = Readonly<{
	callCount: number
	estimatedCallCount: number
	errorRate: number
	avgDurationMs: number
	hasSampling: boolean
	samplingWeight: number
}>

const rowOf = (
	edge: EdgeStats,
	seconds: number,
	fields: Readonly<{
		id: string
		kind: DependencyKind
		name: string
		subtitle?: string | undefined
		p95: number
		whereClause: string
	}>,
): DependencyRow => ({
	id: fields.id,
	kind: fields.kind,
	name: fields.name,
	subtitle: fields.subtitle,
	callsPerSec: edge.estimatedCallCount / seconds,
	tracedCallsPerSec: edge.callCount / seconds,
	totalCalls: edge.callCount,
	estimatedCalls: edge.estimatedCallCount,
	errorRate: edge.errorRate,
	avgDurationMs: edge.avgDurationMs,
	p95DurationMs: fields.p95,
	hasSampling: edge.hasSampling,
	samplingWeight: edge.samplingWeight,
	whereClause: fields.whereClause,
})

/** One row per downstream target: services, databases (per identity), then external targets. */
export const dependencyRows = (bundle: DependencyBundle, seconds: number): ReadonlyArray<DependencyRow> => [
	...Arr.flatMap(bundle.serviceEdges, (edge) =>
		edge.targetService === ""
			? []
			: [
					rowOf(edge, seconds, {
						id: `service:${edge.targetService}`,
						kind: "service",
						name: edge.targetService,
						p95: 0,
						whereClause: dependencyDrillWhereClause("service", edge.targetService, ""),
					}),
				],
	),
	...Arr.flatMap(bundle.dbEdges, (edge) =>
		edge.dbSystem === ""
			? []
			: [
					rowOf(edge, seconds, {
						id: `database:${edge.dbSystem}:${edge.dbNamespace}`,
						kind: "database",
						name: edge.dbNamespace ? `${edge.dbSystem} · ${edge.dbNamespace}` : edge.dbSystem,
						p95: edge.p95DurationMs,
						whereClause: dependencyDrillWhereClause("database", edge.dbSystem, ""),
					}),
				],
	),
	...Arr.flatMap(bundle.externalEdges, (edge) =>
		edge.targetName === ""
			? []
			: [
					rowOf(edge, seconds, {
						id: `${edge.targetType}:${edge.targetName}`,
						kind: edge.targetType,
						name: edge.targetName,
						subtitle: edge.targetSystem === "" ? undefined : edge.targetSystem,
						p95: edge.p95DurationMs,
						whereClause: dependencyDrillWhereClause(
							edge.targetType,
							edge.targetName,
							edge.targetSystem,
						),
					}),
				],
	),
]

/** `mergeDependencyRows`: traffic sums, error rate and avg weighted, p95 the worst part. */
const mergeRows = (first: DependencyRow, rest: ReadonlyArray<DependencyRow>): DependencyRow => {
	const all = [first, ...rest]
	const sum = (pick: (row: DependencyRow) => number) => Arr.reduce(all, 0, (acc, row) => acc + pick(row))
	const estimatedCalls = sum((row) => row.estimatedCalls)
	const totalCalls = sum((row) => row.totalCalls)
	return {
		...first,
		callsPerSec: sum((row) => row.callsPerSec),
		tracedCallsPerSec: sum((row) => row.tracedCallsPerSec),
		totalCalls,
		estimatedCalls,
		errorRate:
			estimatedCalls > 0
				? sum((row) => row.errorRate * row.estimatedCalls) / estimatedCalls
				: first.errorRate,
		avgDurationMs:
			totalCalls > 0
				? sum((row) => row.avgDurationMs * row.totalCalls) / totalCalls
				: first.avgDurationMs,
		p95DurationMs: Math.max(...Arr.map(all, (row) => row.p95DurationMs)),
		hasSampling: Arr.some(all, (row) => row.hasSampling),
		samplingWeight: Math.max(...Arr.map(all, (row) => row.samplingWeight)),
	}
}

/** `dedupedRows`: an HTTP host naming a known service (5+ chars) folds into that service's row. */
export const foldHostRows = (rows: ReadonlyArray<DependencyRow>): ReadonlyArray<DependencyRow> => {
	const services = Arr.map(
		Arr.filter(rows, (row) => row.kind === "service" && row.name.length >= 5),
		(row) => ({ canonical: row.name, lower: Str.toLowerCase(row.name) }),
	)
	const matchOf = (row: DependencyRow) =>
		row.kind !== "http"
			? undefined
			: services.find((service) => Str.includes(service.lower)(Str.toLowerCase(row.name)))
	const hostsFor = (name: string) => Arr.filter(rows, (row) => matchOf(row)?.canonical === name)
	if (!Arr.some(rows, (row) => matchOf(row) !== undefined)) return rows
	return Arr.flatMap(rows, (row) => {
		if (matchOf(row) !== undefined) return []
		if (row.kind !== "service") return [row]
		const hosts = hostsFor(row.name)
		const [firstHost] = hosts
		if (firstHost === undefined) return [row]
		const subtitle =
			hosts.length === 1 ? `via ${firstHost.name}` : `via ${firstHost.name} +${hosts.length - 1} more`
		return [{ ...mergeRows(row, hosts), subtitle }]
	})
}

const KIND_ORDER: ReadonlyArray<DependencyKind> = ["service", "database", "http", "messaging", "rpc"]
const KIND_LABELS = new Map<DependencyKind, readonly [string, string]>([
	["service", ["service", "services"]],
	["database", ["database", "databases"]],
	["http", ["external HTTP", "external HTTP"]],
	["messaging", ["queue", "queues"]],
	["rpc", ["RPC target", "RPC targets"]],
])

export type DependencySummary = Readonly<{
	breakdown: string
	topByCalls: DependencyRow
	topByErrors: DependencyRow | undefined
	topByLatency: DependencyRow
}>

/** The summary strip's facts: the kind breakdown, the busiest, most failing and slowest targets. */
export const dependencySummary = (rows: ReadonlyArray<DependencyRow>): DependencySummary | undefined => {
	const topByCalls = rows.toSorted((a, b) => b.callsPerSec - a.callsPerSec)[0]
	const topByLatency = rows.toSorted((a, b) => b.p95DurationMs - a.p95DurationMs)[0]
	if (topByCalls === undefined || topByLatency === undefined) return undefined
	const breakdown = Arr.join(
		Arr.flatMap(KIND_ORDER, (kind) => {
			const count = Arr.filter(rows, (row) => row.kind === kind).length
			const [singular, plural] = KIND_LABELS.get(kind) ?? [kind, kind]
			return count === 0 ? [] : [`${count} ${count === 1 ? singular : plural}`]
		}),
		" · ",
	)
	return {
		breakdown,
		topByCalls,
		topByErrors: Arr.filter(rows, (row) => row.errorRate > 0).toSorted(
			(a, b) => b.errorRate - a.errorRate,
		)[0],
		topByLatency,
	}
}
