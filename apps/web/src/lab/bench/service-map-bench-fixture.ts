import type { ServiceOverview } from "@maple/query-engine"

/**
 * Deterministic synthetic topology for the service-map bench. Framework-free.
 *
 * The row types restate the warehouse row types structurally.
 */

type ServicePlatform = "kubernetes" | "cloudflare" | "gcp" | "lambda" | "web" | "unknown"

interface ServiceEdge {
	sourceService: string
	targetService: string
	callCount: number
	estimatedCallCount: number
	errorCount: number
	errorRate: number
	avgDurationMs: number
	maxDurationMs: number
	hasSampling: boolean
	samplingWeight: number
}

interface ServiceDbEdge extends Omit<ServiceEdge, "targetService"> {
	dbSystem: string
	dbNamespace: string
	p95DurationMs: number
}

interface ServiceWorkload {
	serviceName: string
	workloadKind: "deployment"
	workloadName: string
	namespace: string
	clusterName: string
	podCount: number
	avgCpuLimitUtilization: number
	avgMemoryLimitUtilization: number
}

interface CloudflareService {
	serviceName: string
	kind: "worker"
	displayName: string
	requests: number
	throughput: number
	errorRate: number
	latencyP99Ms: number
	cpuP99Ms?: number
}

// Fixed window so callsPerSecond (and thus particle pressure) is driven purely
// by generated callCount, independent of wall-clock.
export const DURATION_SECONDS = 3600
export type BenchRps = "low" | "med" | "high"

export interface BenchParams {
	services: number
	edges: number
	rps: BenchRps
	seed: number
	/** Number of `service.namespace` groups to spread services across (0 = none). */
	groups: number
	/** Low-traffic filter threshold (% of peak edge rate; 0 = off). */
	minTraffic: number
	/** Service to focus (dim non-neighbors); "" = no focus. */
	focus: string
}

export const DEFAULT_BENCH_PARAMS: BenchParams = {
	services: 120,
	edges: 400,
	rps: "high",
	seed: 1,
	groups: 0,
	minTraffic: 0,
	focus: "",
}

// Realistic-ish namespace names; falls back to `team-<n>` past the pool length.
const NAMESPACE_POOL = [
	"payments",
	"checkout",
	"platform",
	"identity",
	"search",
	"growth",
	"billing",
	"notifications",
	"inventory",
	"shipping",
]
const namespaceName = (group: number): string => NAMESPACE_POOL[group] ?? `team-${group}`

function makeRng(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a |= 0
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const PLATFORMS: ServicePlatform[] = ["kubernetes", "cloudflare", "gcp", "lambda", "web", "unknown"]
const RUNTIMES = ["nodejs", "bun", "deno", "edge-light", "workerd"]
const DB_SYSTEMS = ["postgresql", "mysql", "clickhouse", "redis", "mongodb"]

const rpsRange = (rps: BenchRps): [number, number] =>
	rps === "high" ? [50, 500] : rps === "med" ? [5, 50] : [0.5, 5]

export interface BenchGraph {
	edges: ServiceEdge[]
	dbEdges: ServiceDbEdge[]
	overviews: ServiceOverview[]
	workloads: ServiceWorkload[]
	platforms: Map<string, ServicePlatform>
	runtimes: Map<string, string>
}

export function refreshBenchMetrics(graph: BenchGraph, revision: number): BenchGraph {
	const callScale = 1 + ((revision % 7) - 3) * 0.01
	const latencyScale = 1 + ((revision % 5) - 2) * 0.015

	return {
		...graph,
		edges: graph.edges.map((edge) => ({
			...edge,
			callCount: Math.max(1, Math.round(edge.callCount * callScale)),
			estimatedCallCount: Math.max(1, Math.round(edge.estimatedCallCount * callScale)),
			avgDurationMs: edge.avgDurationMs * latencyScale,
			maxDurationMs: edge.maxDurationMs * latencyScale,
		})),
		dbEdges: graph.dbEdges.map((edge) => ({
			...edge,
			callCount: Math.max(1, Math.round(edge.callCount * callScale)),
			estimatedCallCount: Math.max(1, Math.round(edge.estimatedCallCount * callScale)),
			avgDurationMs: edge.avgDurationMs * latencyScale,
			maxDurationMs: edge.maxDurationMs * latencyScale,
		})),
		overviews: graph.overviews.map((overview) => ({
			...overview,
			throughput: overview.throughput * callScale,
			tracedThroughput: overview.tracedThroughput * callScale,
			p50LatencyMs: overview.p50LatencyMs * latencyScale,
			p95LatencyMs: overview.p95LatencyMs * latencyScale,
			p99LatencyMs: overview.p99LatencyMs * latencyScale,
		})),
	}
}

export function generateBenchGraph(params: BenchParams): BenchGraph {
	const rng = makeRng(params.seed)
	const serviceCount = Math.max(2, params.services)
	const names = Array.from({ length: serviceCount }, (_, i) => `svc-${String(i).padStart(3, "0")}`)

	const platforms = new Map<string, ServicePlatform>()
	const runtimes = new Map<string, string>()
	for (const name of names) {
		const platform = PLATFORMS[Math.floor(rng() * PLATFORMS.length)]
		platforms.set(name, platform)
		if (rng() > 0.4) runtimes.set(name, RUNTIMES[Math.floor(rng() * RUNTIMES.length)])
	}

	const [rpsLo, rpsHi] = rpsRange(params.rps)
	const callsFor = () => Math.round((rpsLo + rng() * (rpsHi - rpsLo)) * DURATION_SECONDS)

	// Edge set: a spanning backbone (every node reachable) plus extra random
	// forward edges up to the requested count. Source index < target index keeps
	// the graph mostly-acyclic so the layered layout stays meaningful.
	const seen = new Set<string>()
	const edges: ServiceEdge[] = []
	const addEdge = (sIdx: number, tIdx: number) => {
		if (sIdx === tIdx) return
		const source = names[sIdx]
		const target = names[tIdx]
		const key = `${source}->${target}`
		if (seen.has(key)) return
		seen.add(key)
		const callCount = callsFor()
		const errorRate = rng() < 0.15 ? rng() * 0.12 : rng() * 0.005
		edges.push({
			sourceService: source,
			targetService: target,
			callCount,
			estimatedCallCount: Math.round(callCount * (rng() < 0.3 ? 1.5 + rng() : 1)),
			errorCount: Math.round(callCount * errorRate),
			errorRate,
			avgDurationMs: 2 + rng() * 80,
			maxDurationMs: 20 + rng() * 400,
			hasSampling: rng() < 0.3,
			samplingWeight: 1 + Math.floor(rng() * 9),
		})
	}
	for (let i = 1; i < serviceCount; i++) addEdge(Math.floor(rng() * i), i)
	let guard = 0
	while (edges.length < params.edges && guard++ < params.edges * 20) {
		const s = Math.floor(rng() * serviceCount)
		const t = Math.floor(rng() * serviceCount)
		addEdge(Math.min(s, t), Math.max(s, t))
	}

	// DB edges: connect ~15% of services to a random database system.
	const dbEdges: ServiceDbEdge[] = []
	for (const name of names) {
		if (rng() > 0.15) continue
		const callCount = callsFor()
		const errorRate = rng() * 0.02
		dbEdges.push({
			sourceService: name,
			dbSystem: DB_SYSTEMS[Math.floor(rng() * DB_SYSTEMS.length)],
			dbNamespace: `bench_db_${Math.floor(rng() * 3)}`,
			callCount,
			estimatedCallCount: callCount,
			errorCount: Math.round(callCount * errorRate),
			errorRate,
			avgDurationMs: 1 + rng() * 40,
			maxDurationMs: 10 + rng() * 200,
			p95DurationMs: 8 + rng() * 120,
			hasSampling: false,
			samplingWeight: 1,
		})
	}

	// Assign a `service.namespace` per service. Deterministic and rng-free so the
	// generated topology is identical regardless of `groups` (only namespaces
	// change) — and `groups=0` reproduces the original namespace-less graph exactly.
	// ~1 in 7 services is left ungrouped to exercise the unboxed region.
	const groupCount = Math.max(0, Math.floor(params.groups))
	const namespaceFor = (i: number): string =>
		groupCount <= 0 || i % 7 === 6 ? "" : namespaceName(i % groupCount)

	const overviews: ServiceOverview[] = names.map((name, i) => {
		const errorRate = rng() < 0.15 ? rng() * 0.1 : rng() * 0.004
		const throughput = rpsLo + rng() * (rpsHi - rpsLo)
		const hasSampling = rng() < 0.3
		const samplingWeight = hasSampling ? 1 + Math.floor(rng() * 9) : 1
		return {
			serviceName: name,
			serviceNamespace: namespaceFor(i),
			environment: "prod",
			commits: [],
			p50LatencyMs: 2 + rng() * 50,
			p95LatencyMs: 20 + rng() * 300,
			p99LatencyMs: 40 + rng() * 600,
			errorRate,
			throughput: throughput * samplingWeight,
			tracedThroughput: throughput,
			hasSampling,
			samplingWeight,
			spanCount: Math.round(throughput * 3600),
		}
	})

	const workloads: ServiceWorkload[] = []
	for (const name of names) {
		if (platforms.get(name) !== "kubernetes") continue
		const count = 1 + Math.floor(rng() * 3)
		for (let w = 0; w < count; w++) {
			workloads.push({
				serviceName: name,
				workloadKind: "deployment",
				workloadName: `${name}-${w}`,
				namespace: "default",
				clusterName: "bench",
				podCount: 1 + Math.floor(rng() * 12),
				avgCpuLimitUtilization: rng(),
				avgMemoryLimitUtilization: rng(),
			})
		}
	}

	return { edges, dbEdges, overviews, workloads, platforms, runtimes }
}

// Exercises the instrumented-Worker overlay: svc-000 gets CF edge analytics
// attached; the unmatched script must NOT create a node.
export const BENCH_CLOUDFLARE_SERVICES: CloudflareService[] = [
	{
		serviceName: "cloudflare-worker/svc-000",
		kind: "worker",
		displayName: "svc-000",
		requests: 120_000,
		throughput: 120_000 / DURATION_SECONDS,
		errorRate: 0.004,
		latencyP99Ms: 38,
		cpuP99Ms: 9,
	},
	{
		serviceName: "cloudflare-worker/unmatched-script",
		kind: "worker",
		displayName: "unmatched-script",
		requests: 5_000,
		throughput: 5_000 / DURATION_SECONDS,
		errorRate: 0.2,
		latencyP99Ms: 55,
		cpuP99Ms: 12,
	},
]
