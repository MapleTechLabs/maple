import { makePrng, type Prng } from "../prng.ts"
import { ACME_SERVICES, commitShaFor } from "./acme-shop.ts"
import { formatMicros, type WarehouseRow } from "./rows.ts"

/**
 * Kubernetes (kubeletstats + k8s_cluster receivers) and Docker (docker_stats receiver) metrics for
 * Acme Shop's cluster. Pod names, nodes and rollouts match `acmeShopTelemetry`, so spans and pods join.
 */

const MINUTE_MICROS = 60_000_000
const SLOT_MICROS = 5 * MINUTE_MICROS
const HOURS = 13
const CLUSTER = "prod-us-east-1"
const GIB = 1024 * 1024 * 1024
/** Same nodes and pod-to-node rule as acme-shop.ts `resourceFor`. */
export const INFRA_NODES = ["ip-10-0-12-84", "ip-10-0-13-201", "ip-10-0-21-17", "ip-10-0-22-140"] as const
const PODS_PER_SERVICE = 2

const nodeFor = (name: string, pod: number) =>
	INFRA_NODES[(name.length + pod) % INFRA_NODES.length] ?? INFRA_NODES[0]

const hashHex = (text: string, length: number) =>
	Array.from({ length: Math.ceil(length / 8) }, (_, round) =>
		Array.from(`${round}:${text}`)
			.reduce((acc, char) => (Math.imul(acc, 31) + char.charCodeAt(0)) >>> 0, 17)
			.toString(16)
			.padStart(8, "0"),
	)
		.join("")
		.slice(0, length)

const uidOf = (text: string) => {
	const hex = hashHex(text, 32)
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

type Attributes = Readonly<Record<string, string>>

const base = (
	orgId: string,
	resource: Attributes,
	scope: string,
	name: string,
	unit: string,
	micros: number,
) => ({
	OrgId: orgId,
	ResourceAttributes: resource,
	ResourceSchemaUrl: "",
	ScopeName: `github.com/open-telemetry/opentelemetry-collector-contrib/receiver/${scope}`,
	ScopeVersion: "0.120.0",
	ScopeAttributes: {},
	ScopeSchemaUrl: "",
	ServiceName: resource["service.name"] ?? "",
	MetricName: name,
	MetricDescription: "",
	MetricUnit: unit,
	StartTimeUnix: formatMicros(micros - SLOT_MICROS),
	TimeUnix: formatMicros(micros),
	ExemplarsTraceId: [],
	ExemplarsSpanId: [],
	ExemplarsTimestamp: [],
	ExemplarsValue: [],
	ExemplarsFilteredAttributes: [],
	Flags: 0,
})

interface Sink {
	readonly orgId: string
	readonly gauge: Array<WarehouseRow>
	readonly sum: Array<WarehouseRow>
}

const gauge = (
	sink: Sink,
	resource: Attributes,
	scope: string,
	name: string,
	unit: string,
	micros: number,
	value: number,
	attributes: Attributes = {},
) =>
	sink.gauge.push({
		...base(sink.orgId, resource, scope, name, unit, micros),
		Attributes: attributes,
		Value: value,
	})

const sum = (
	sink: Sink,
	resource: Attributes,
	name: string,
	unit: string,
	micros: number,
	value: number,
	monotonic: boolean,
	attributes: Attributes = {},
) =>
	sink.sum.push({
		...base(sink.orgId, resource, "dockerstatsreceiver", name, unit, micros),
		Attributes: attributes,
		Value: value,
		AggregationTemporality: monotonic ? 1 : 2,
		IsMonotonic: monotonic,
	})

/** One pod's life: `[fromMicros, toMicros]`, owner and resource limits. */
interface PodSpec {
	readonly name: string
	readonly namespace: string
	readonly node: string
	readonly owner: Attributes
	readonly service: string | undefined
	readonly fromMicros: number
	readonly toMicros: number
	readonly cpuCores: number
	readonly cpuLimit: number | undefined
	readonly memoryLimitShare: (rng: Prng, micros: number) => number | undefined
	readonly restartEveryMinutes?: number
	readonly qos: string
}

const deploymentPods = (nowMicros: number, startMicros: number): ReadonlyArray<PodSpec> =>
	ACME_SERVICES.flatMap((service, serviceIndex) => {
		const deployAt =
			service.deploy === undefined
				? undefined
				: nowMicros - service.deploy.minutesBeforeNow * MINUTE_MICROS
		const phases = [
			{ version: service.version, from: startMicros, to: deployAt ?? nowMicros },
			...(service.deploy === undefined || deployAt === undefined
				? []
				: [{ version: service.deploy.version, from: deployAt, to: nowMicros }]),
		].filter((phase) => phase.to > startMicros)
		const isPayment = service.name === "payment-svc"
		const isCatalog = service.name === "catalog-api"
		return phases.flatMap((phase) => {
			const sha = commitShaFor(service.name, phase.version)
			const incident = isPayment && phase.version === service.deploy?.version
			return Array.from({ length: PODS_PER_SERVICE }, (_, pod): PodSpec => ({
				name: `${service.name}-${sha.slice(0, 9)}-p${pod}`,
				namespace: "shop",
				node: nodeFor(service.name, pod),
				owner: {
					"k8s.deployment.name": service.name,
					"k8s.replicaset.name": `${service.name}-${sha.slice(0, 9)}`,
				},
				service: service.name,
				fromMicros: Math.max(phase.from, startMicros),
				toMicros: phase.to,
				cpuCores: 0.08 + serviceIndex * 0.06 + (incident ? 0.25 : 0),
				// catalog-api runs without limits, so it lands in the "unbounded" scope.
				cpuLimit: isCatalog ? undefined : 1,
				memoryLimitShare: (rng, micros) =>
					isCatalog
						? undefined
						: incident
							? Math.min(0.99, 0.82 + ((micros - phase.from) / (120 * MINUTE_MICROS)) * 0.16)
							: 0.32 + serviceIndex * 0.05 + rng.next() * 0.04,
				restartEveryMinutes: incident && pod === 1 ? 30 : undefined,
				qos: isCatalog ? "BestEffort" : "Burstable",
			}))
		})
	})

const platformPods = (nowMicros: number, startMicros: number): ReadonlyArray<PodSpec> => [
	{
		name: "postgres-0",
		namespace: "data",
		node: INFRA_NODES[2],
		owner: { "k8s.statefulset.name": "postgres" },
		service: undefined,
		fromMicros: startMicros,
		toMicros: nowMicros,
		cpuCores: 0.62,
		cpuLimit: 2,
		memoryLimitShare: (rng) => 0.71 + rng.next() * 0.03,
		qos: "Guaranteed",
	},
	...INFRA_NODES.map((node, index): PodSpec => ({
		name: `otel-agent-${hashHex(node, 5)}`,
		namespace: "observability",
		node,
		owner: { "k8s.daemonset.name": "otel-agent" },
		service: undefined,
		fromMicros: startMicros,
		toMicros: nowMicros,
		cpuCores: 0.04 + index * 0.01,
		cpuLimit: 0.5,
		memoryLimitShare: (rng) => 0.22 + rng.next() * 0.05,
		qos: "Burstable",
	})),
	{
		name: "nightly-report-29312400-x7k2p",
		namespace: "shop",
		node: INFRA_NODES[1],
		owner: { "k8s.job.name": "nightly-report-29312400", "k8s.cronjob.name": "nightly-report" },
		service: undefined,
		fromMicros: nowMicros - 6 * 60 * MINUTE_MICROS,
		toMicros: nowMicros - 6 * 60 * MINUTE_MICROS + 25 * MINUTE_MICROS,
		cpuCores: 0.45,
		cpuLimit: 1,
		memoryLimitShare: (rng) => 0.4 + rng.next() * 0.1,
		qos: "Burstable",
	},
]

const podResource = (pod: PodSpec): Attributes => {
	const base = {
		"k8s.cluster.name": CLUSTER,
		"k8s.namespace.name": pod.namespace,
		"k8s.node.name": pod.node,
		"k8s.pod.name": pod.name,
		"k8s.pod.uid": uidOf(pod.name),
		"k8s.pod.qos_class": pod.qos,
		"k8s.pod.start_time": new Date(pod.fromMicros / 1000).toISOString(),
		"deployment.environment.name": "production",
		"cloud.provider": "aws",
		"cloud.region": "us-east-1",
		...pod.owner,
	}
	return pod.service === undefined ? base : { "service.name": pod.service, ...base }
}

const emitPod = (sink: Sink, rng: Prng, pod: PodSpec, micros: number) => {
	const resource = podResource(pod)
	const diurnal = 0.75 + 0.25 * Math.sin((2 * Math.PI * micros) / (24 * 60 * MINUTE_MICROS))
	const cores = pod.cpuCores * diurnal * rng.spread(0.2)
	const scope = "kubeletstatsreceiver"
	gauge(sink, resource, scope, "k8s.pod.cpu.usage", "{cpu}", micros, cores)
	gauge(
		sink,
		resource,
		scope,
		"k8s.pod.cpu_request_utilization",
		"1",
		micros,
		cores / Math.max(0.05, (pod.cpuLimit ?? 0.4) / 2),
	)
	gauge(sink, resource, scope, "k8s.pod.memory_request_utilization", "1", micros, 0.5 + rng.next() * 0.3)
	if (pod.cpuLimit !== undefined)
		gauge(sink, resource, scope, "k8s.pod.cpu_limit_utilization", "1", micros, cores / pod.cpuLimit)
	const memory = pod.memoryLimitShare(rng, micros)
	if (memory !== undefined)
		gauge(sink, resource, scope, "k8s.pod.memory_limit_utilization", "1", micros, memory)
	const restarts =
		pod.restartEveryMinutes === undefined
			? 0
			: Math.floor((micros - pod.fromMicros) / (pod.restartEveryMinutes * MINUTE_MICROS))
	const containerName = Object.values(pod.owner)[0] ?? pod.name
	gauge(
		sink,
		restarts > 0
			? {
					...resource,
					"k8s.container.name": containerName,
					"k8s.container.status.last_terminated_reason": "OOMKilled",
				}
			: { ...resource, "k8s.container.name": containerName },
		"k8sclusterreceiver",
		"k8s.container.restarts",
		"{restart}",
		micros,
		restarts,
	)
}

const ownerResource = (namespace: string, owner: Attributes): Attributes => ({
	"k8s.cluster.name": CLUSTER,
	"k8s.namespace.name": namespace,
	"deployment.environment.name": "production",
	...owner,
})

/** k8s_cluster replica gauges: payment-svc is one replica short since its pod started crash-looping. */
const emitReplicas = (sink: Sink, nowMicros: number, micros: number) => {
	const scope = "k8sclusterreceiver"
	ACME_SERVICES.forEach((service) => {
		const resource = ownerResource("shop", { "k8s.deployment.name": service.name })
		const short = service.name === "payment-svc" && micros >= nowMicros - 40 * MINUTE_MICROS
		gauge(sink, resource, scope, "k8s.deployment.desired", "{pod}", micros, PODS_PER_SERVICE)
		gauge(
			sink,
			resource,
			scope,
			"k8s.deployment.available",
			"{pod}",
			micros,
			short ? PODS_PER_SERVICE - 1 : PODS_PER_SERVICE,
		)
	})
	const postgres = ownerResource("data", { "k8s.statefulset.name": "postgres" })
	gauge(sink, postgres, scope, "k8s.statefulset.desired_pods", "{pod}", micros, 1)
	gauge(sink, postgres, scope, "k8s.statefulset.ready_pods", "{pod}", micros, 1)
	const agent = ownerResource("observability", { "k8s.daemonset.name": "otel-agent" })
	gauge(sink, agent, scope, "k8s.daemonset.desired_scheduled_nodes", "{node}", micros, INFRA_NODES.length)
	gauge(sink, agent, scope, "k8s.daemonset.ready_nodes", "{node}", micros, INFRA_NODES.length)
	const jobStart = nowMicros - 6 * 60 * MINUTE_MICROS
	if (micros >= jobStart) {
		const job = ownerResource("shop", { "k8s.job.name": "nightly-report-29312400" })
		gauge(sink, job, scope, "k8s.job.desired_successful_pods", "{pod}", micros, 1)
		gauge(
			sink,
			job,
			scope,
			"k8s.job.successful_pods",
			"{pod}",
			micros,
			micros >= jobStart + 25 * MINUTE_MICROS ? 1 : 0,
		)
		gauge(sink, job, scope, "k8s.job.failed_pods", "{pod}", micros, 0)
	}
}

const emitNodes = (sink: Sink, rng: Prng, pods: ReadonlyArray<PodSpec>, nowMicros: number, micros: number) =>
	INFRA_NODES.forEach((node, index) => {
		const resource = {
			"k8s.cluster.name": CLUSTER,
			"k8s.node.name": node,
			"k8s.node.uid": uidOf(node),
			"k8s.kubelet.version": "v1.31.4-eks-aeac579",
			"container.runtime": "containerd",
			"deployment.environment.name": "production",
		} satisfies Attributes
		const podCores = pods
			.filter((pod) => pod.node === node && micros >= pod.fromMicros && micros <= pod.toMicros)
			.reduce((total, pod) => total + pod.cpuCores, 0)
		const scope = "kubeletstatsreceiver"
		gauge(
			sink,
			resource,
			scope,
			"k8s.node.cpu.usage",
			"{cpu}",
			micros,
			(0.3 + podCores) * rng.spread(0.1),
		)
		gauge(
			sink,
			resource,
			scope,
			"k8s.node.memory.working_set",
			"By",
			micros,
			(5.5 + index * 1.6 + rng.next() * 0.4) * GIB,
		)
		gauge(sink, resource, "k8sclusterreceiver", "k8s.node.allocatable_cpu", "{cpu}", micros, 4)
		gauge(sink, resource, "k8sclusterreceiver", "k8s.node.allocatable_memory", "By", micros, 15.3 * GIB)
		gauge(
			sink,
			resource,
			scope,
			"k8s.node.uptime",
			"s",
			micros,
			(9 + index * 3) * 86_400 + (micros - (nowMicros - HOURS * 60 * MINUTE_MICROS)) / 1_000_000,
		)
	})

const CONTAINERS = [
	{ service: "postgres", image: "postgres:16.4", cpu: 18, memory: 41, limit: 2, pids: 34 },
	{ service: "redis", image: "redis:7.4-alpine", cpu: 4, memory: 12, limit: 0.5, pids: 6 },
	{ service: "grafana", image: "grafana/grafana:11.3.0", cpu: 7, memory: 28, limit: 1, pids: 21 },
	{
		service: "ci-worker",
		image: "ghcr.io/acme-shop/ci-worker:2026.9.3",
		cpu: 63,
		memory: 88,
		limit: 4,
		pids: 112,
	},
] as const

/** A Docker Compose host outside the cluster; ci-worker runs hot and restarted twice. */
const emitContainers = (sink: Sink, rng: Prng, startMicros: number, micros: number) =>
	CONTAINERS.forEach((container, index) => {
		const resource = {
			"container.name": `ci-stack-${container.service}-1`,
			"container.id": hashHex(container.service, 64),
			"container.image.name": container.image,
			"container.runtime": "docker",
			"compose.project": "ci-stack",
			"compose.service": container.service,
			"host.name": "build-runner-01",
			"deployment.environment.name": "staging",
		} satisfies Attributes
		const cpu = Math.min(99, container.cpu * rng.spread(0.25))
		const memoryPct = Math.min(99, container.memory * rng.spread(0.05))
		const limitBytes = (index + 1) * 2 * GIB
		const scope = "dockerstatsreceiver"
		gauge(sink, resource, scope, "container.cpu.utilization", "%", micros, cpu)
		gauge(sink, resource, scope, "container.memory.percent", "%", micros, memoryPct)
		gauge(sink, resource, scope, "container.cpu.limit", "{cpus}", micros, container.limit)
		gauge(
			sink,
			resource,
			scope,
			"container.uptime",
			"s",
			micros,
			(3 + index) * 86_400 + (micros - startMicros) / 1_000_000,
		)
		sum(
			sink,
			resource,
			"container.memory.usage.total",
			"By",
			micros,
			(limitBytes * memoryPct) / 100,
			false,
		)
		sum(sink, resource, "container.memory.usage.limit", "By", micros, limitBytes, false)
		sum(
			sink,
			resource,
			"container.restarts",
			"{restart}",
			micros,
			container.service === "ci-worker"
				? Math.min(2, Math.floor((micros - startMicros) / (300 * MINUTE_MICROS)))
				: 0,
			true,
		)
		sum(sink, resource, "container.pids.count", "{pid}", micros, container.pids + rng.int(0, 4), false)
		sum(
			sink,
			resource,
			"container.network.io.usage.rx_bytes",
			"By",
			micros,
			(index + 1) * 4_200_000 * rng.spread(0.3),
			true,
		)
		sum(
			sink,
			resource,
			"container.network.io.usage.tx_bytes",
			"By",
			micros,
			(index + 1) * 1_900_000 * rng.spread(0.3),
			true,
		)
		sum(
			sink,
			resource,
			"container.blockio.io_service_bytes_recursive",
			"By",
			micros,
			(index + 1) * 800_000 * rng.spread(0.4),
			true,
			{ operation: "read" },
		)
		sum(
			sink,
			resource,
			"container.blockio.io_service_bytes_recursive",
			"By",
			micros,
			(index + 1) * 1_300_000 * rng.spread(0.4),
			true,
			{ operation: "write" },
		)
	})

export const infraK8sMetrics = (options: {
	readonly orgId: string
	readonly now: Date
	readonly seed: number
}) => {
	const rng = makePrng(options.seed)
	const nowMicros = options.now.getTime() * 1000
	const slots = (HOURS * 60) / 5
	const startMicros = nowMicros - (slots - 1) * SLOT_MICROS
	const pods = [...deploymentPods(nowMicros, startMicros), ...platformPods(nowMicros, startMicros)]
	const sink: Sink = { orgId: options.orgId, gauge: [], sum: [] }
	Array.from({ length: slots }, (_, index) => startMicros + index * SLOT_MICROS).forEach((micros) => {
		pods.filter((pod) => micros >= pod.fromMicros && micros <= pod.toMicros).forEach((pod) =>
			emitPod(sink, rng, pod, micros),
		)
		emitReplicas(sink, nowMicros, micros)
		emitNodes(sink, rng, pods, nowMicros, micros)
		emitContainers(sink, rng, startMicros, micros)
	})
	return { metrics_gauge: sink.gauge, metrics_sum: sink.sum }
}
