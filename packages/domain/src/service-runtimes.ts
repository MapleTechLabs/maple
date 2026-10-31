// Where a traced service runs: each platform integration writes its metrics under `service.name` =
// the resource's name (a Worker's under `cloudflare-worker/<script>`), so the resource and the
// traced service of that name are one thing. Infra pages and service pages link by this rule.

export const CLOUDFLARE_WORKER_SERVICE_PREFIX = "cloudflare-worker/"

export const SERVICE_RUNTIME_KIND_IDS = [
	"cloudRun",
	"cloudFunctions",
	"ecs",
	"lambda",
	"railway",
	"cloudflareWorker",
] as const
export type ServiceRuntimeKindId = (typeof SERVICE_RUNTIME_KIND_IDS)[number]

export type ServiceRuntimeProvider = "gcp" | "aws" | "railway" | "cloudflare"

export interface ServiceRuntimeKind {
	readonly provider: ServiceRuntimeProvider
	/** One resource, as a page names it: "Cloud Run service". */
	readonly label: string
	/** Where a map node has a few characters for it: "Cloud Run". */
	readonly short: string
	/** A gauge every resource of the kind reports while it runs: its presence marks the resource. */
	readonly marker: string
}

export const SERVICE_RUNTIME_KINDS = {
	cloudRun: {
		provider: "gcp",
		label: "Cloud Run service",
		short: "Cloud Run",
		marker: "gcp.cloud_run.container.instance.count",
	},
	cloudFunctions: {
		provider: "gcp",
		label: "Cloud Function",
		short: "Function",
		marker: "gcp.cloud_functions.instance.count",
	},
	ecs: { provider: "aws", label: "ECS service", short: "ECS", marker: "aws.ecs.cpu_utilization" },
	lambda: { provider: "aws", label: "Lambda function", short: "Lambda", marker: "aws.lambda.duration" },
	railway: { provider: "railway", label: "Railway service", short: "Railway", marker: "railway.cpu.usage" },
	cloudflareWorker: {
		provider: "cloudflare",
		label: "Worker",
		short: "Worker",
		marker: "cloudflare.worker.cpu_time",
	},
} as const satisfies Record<ServiceRuntimeKindId, ServiceRuntimeKind>

export const SERVICE_RUNTIME_MARKERS: ReadonlyArray<string> = SERVICE_RUNTIME_KIND_IDS.map(
	(kind) => SERVICE_RUNTIME_KINDS[kind].marker,
)

export const serviceRuntimeKindOfMarker = (metricName: string): ServiceRuntimeKindId | null =>
	SERVICE_RUNTIME_KIND_IDS.find((kind) => SERVICE_RUNTIME_KINDS[kind].marker === metricName) ?? null

/** The `service.name`s a platform resource of this traced service would report under. */
export const runtimeMetricServiceNames = (service: string): ReadonlyArray<string> => [
	service,
	`${CLOUDFLARE_WORKER_SERVICE_PREFIX}${service}`,
]

/** The traced service a platform resource's `service.name` belongs to. */
export const tracedServiceOfRuntime = (metricServiceName: string): string =>
	metricServiceName.startsWith(CLOUDFLARE_WORKER_SERVICE_PREFIX)
		? metricServiceName.slice(CLOUDFLARE_WORKER_SERVICE_PREFIX.length)
		: metricServiceName
