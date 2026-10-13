import { describe, expect, it } from "vitest"
import type { CH } from "@maple/query-engine"
import { aggregateEdges, classifyPlatform } from "./use-local-service-map"

const bucket = (overrides: Partial<Parameters<typeof aggregateEdges>[0][number]> = {}) => ({
	SourceService: "api",
	TargetService: "auth",
	CallCount: 10,
	ErrorCount: 1,
	DurationSumMs: 100,
	MaxDurationMs: 30,
	SampleRateSum: 10,
	...overrides,
})

const platformRow = (overrides: Partial<CH.ServicePlatformsOutput> = {}): CH.ServicePlatformsOutput => ({
	serviceName: "api",
	k8sCluster: "",
	k8sPodName: "",
	k8sDeploymentName: "",
	cloudPlatform: "",
	cloudProvider: "",
	faasName: "",
	mapleSdkType: "",
	processRuntimeName: "",
	...overrides,
})

describe("aggregateEdges", () => {
	it("merges hour and environment buckets of one edge into call-weighted totals", () => {
		const [edge] = aggregateEdges(
			[
				bucket(),
				bucket({
					CallCount: 30,
					ErrorCount: 2,
					DurationSumMs: 500,
					MaxDurationMs: 90,
					SampleRateSum: 30,
				}),
			],
			3600,
		)
		expect(edge).toMatchObject({
			sourceService: "api",
			targetService: "auth",
			callCount: 40,
			estimatedCallCount: 40,
			errorCount: 3,
			avgDurationMs: 15,
			maxDurationMs: 90,
			hasSampling: false,
		})
		expect(edge.errorRate).toBeCloseTo(3 / 40)
	})

	it("carries the sample weight as an estimate, like the cloud edges", () => {
		const [edge] = aggregateEdges([bucket({ CallCount: 10, SampleRateSum: 100 })], 3600)
		expect(edge.hasSampling).toBe(true)
		expect(edge.estimatedCallCount).toBe(100)
		expect(edge.samplingWeight).toBeCloseTo(10)
	})

	it("counts a bucket without a sample-rate sum as unsampled", () => {
		const [edge] = aggregateEdges([bucket({ SampleRateSum: 0 })], 3600)
		expect(edge.estimatedCallCount).toBe(10)
		expect(edge.hasSampling).toBe(false)
	})

	it("keeps distinct edges apart, busiest first", () => {
		const edges = aggregateEdges(
			[bucket(), bucket({ TargetService: "db-proxy", CallCount: 50, SampleRateSum: 50 })],
			60,
		)
		expect(edges.map((e) => e.targetService)).toEqual(["db-proxy", "auth"])
	})
})

describe("classifyPlatform", () => {
	it("prefers host infrastructure over the SDK's self-report", () => {
		expect(classifyPlatform(platformRow({ cloudProvider: "cloudflare", mapleSdkType: "client" }))).toBe(
			"cloudflare",
		)
		expect(classifyPlatform(platformRow({ faasName: "fn", k8sPodName: "pod" }))).toBe("lambda")
		expect(classifyPlatform(platformRow({ k8sDeploymentName: "api" }))).toBe("kubernetes")
		expect(classifyPlatform(platformRow({ mapleSdkType: "client" }))).toBe("web")
	})

	it("does not treat a bare cluster name as Kubernetes", () => {
		expect(classifyPlatform(platformRow({ k8sCluster: "prod" }))).toBe("unknown")
	})
})
