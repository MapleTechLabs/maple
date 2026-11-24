import {
	classifyServiceIdentity,
	EMPTY_SERVICE_IDENTITY_SIGNALS,
	type ServiceIdentitySignals,
} from "@maple/domain/service-identity"
import { ServiceName } from "@maple/domain"
import { Schema } from "effect"
import type { MapBundle } from "../page/service-map/model"

// `/lab/service-map-runtimes`: the fleet topology over one hour. `fleet-web` and `fleet-worker`
// call `fleet-api` (Google Cloud Run), which reads Postgres. No Kubernetes anywhere.

/** 2026-10-24T15:00:00Z. */
export const MAP_RUNTIMES_NOW = 1_792_854_000_000

export const MAP_RUNTIMES_SELECTED = "fleet-api"

const DURATION_SECONDS = 3600
const name = Schema.decodeSync(ServiceName)

const edgeStats = (callCount: number, errorCount: number, avgDurationMs: number, maxDurationMs: number) => ({
	callCount,
	estimatedCallCount: callCount,
	errorCount,
	errorRate: errorCount / callCount,
	avgDurationMs,
	maxDurationMs,
	hasSampling: false,
	samplingWeight: 1,
})

const overview = (serviceName: string, spanCount: number, errorRate: number, p50: number) => ({
	serviceName,
	serviceNamespace: "fleet",
	environment: "production",
	commits: [],
	p50LatencyMs: p50,
	p95LatencyMs: p50 * 3.2,
	p99LatencyMs: p50 * 6.5,
	errorRate,
	throughput: spanCount / DURATION_SECONDS,
	tracedThroughput: spanCount / DURATION_SECONDS,
	hasSampling: false,
	samplingWeight: 1,
	spanCount,
})

const platform = (
	serviceName: string,
	row: Readonly<{
		platform: "gcp" | "web" | "unknown"
		cloudPlatform: string
		cloudProvider: string
		faasName: string
		runtime: string
		identity: Partial<ServiceIdentitySignals>
	}>,
) => ({
	serviceName: name(serviceName),
	platform: row.platform,
	k8sCluster: "",
	cloudPlatform: row.cloudPlatform,
	cloudProvider: row.cloudProvider,
	faasName: row.faasName,
	mapleSdkType: "",
	runtime: row.runtime,
	identity: classifyServiceIdentity({ ...EMPTY_SERVICE_IDENTITY_SIGNALS, ...row.identity }),
})


export const MAP_RUNTIMES_BUNDLE: MapBundle["value"] = {
	edges: [
		{ sourceService: "fleet-web", targetService: "fleet-api", ...edgeStats(98_200, 140, 21.4, 920) },
		{ sourceService: "fleet-worker", targetService: "fleet-api", ...edgeStats(44_100, 52, 28.9, 1_310) },
	],
	dbEdges: [
		{
			sourceService: "fleet-api",
			dbSystem: "postgresql",
			dbNamespace: "fleet",
			p95DurationMs: 12.6,
			...edgeStats(186_400, 64, 3.8, 840),
		},
	],
	dbEdgesTimedOut: false,
	overview: [
		overview("fleet-web", 128_400, 0.0011, 42),
		overview("fleet-api", 151_480, 0.0023, 18),
		overview("fleet-worker", 61_900, 0.0009, 35),
	],
	platforms: [
		platform("fleet-api", {
			platform: "gcp",
			cloudPlatform: "gcp_cloud_run",
			cloudProvider: "gcp",
			faasName: "fleet-api",
			runtime: "go",
			identity: {
				scopeNames: ["go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic/gin/otelgin"],
				serverSpans: 98_000,
				classifiedSpans: 151_480,
			},
		}),
		platform("fleet-worker", {
			platform: "gcp",
			cloudPlatform: "gcp_cloud_run",
			cloudProvider: "gcp",
			faasName: "fleet-worker",
			runtime: "go",
			identity: { consumerSpans: 42_000, classifiedSpans: 61_900 },
		}),
		platform("fleet-web", {
			platform: "web",
			cloudPlatform: "",
			cloudProvider: "",
			faasName: "",
			runtime: "browser",
			identity: { scopeNames: ["next.js"], serverSpans: 30_000, classifiedSpans: 128_400 },
		}),
	],
	/** No Kubernetes: the bundle's workload rows are empty. */
	workloads: [],
	runtimes: [
		{
			serviceName: Schema.decodeSync(ServiceName)("fleet-api"),
			kind: "cloudRun",
			account: "fleet-prod",
			region: "europe-west1",
			cluster: "",
			railwayServiceId: "",
			railwayEnvironmentId: "",
			railwayEnvironmentName: "",
			vercelProjectId: "",
		},
		{
			serviceName: Schema.decodeSync(ServiceName)("fleet-worker"),
			kind: "cloudRun",
			account: "fleet-prod",
			region: "europe-west1",
			cluster: "",
			railwayServiceId: "",
			railwayEnvironmentId: "",
			railwayEnvironmentName: "",
			vercelProjectId: "",
		},
	],
}

export const MAP_RUNTIMES_ENVIRONMENTS: ReadonlyArray<string> = ["production", "staging"]
