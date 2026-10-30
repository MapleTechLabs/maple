import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { serviceRuntimeResources, type ServiceRuntimesOutput, serviceWorkloadsSQL } from "./service-infra"
import { OrgId } from "@maple/domain"

const baseParams = {
	orgId: OrgId.make("org_1"),
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
}

describe("serviceWorkloadsSQL", () => {
	it.effect("decodes workload rows with numeric strings and nullable utilization", () =>
		Effect.gen(function* () {
			const compiled = yield* serviceWorkloadsSQL({ services: ["checkout-api"] }, baseParams)

			const rows = yield* compiled.decodeRows([
				{
					serviceName: "checkout-api",
					workloadKind: "deployment",
					workloadName: "checkout-api",
					namespace: "default",
					clusterName: "prod",
					podCount: "4",
					avgCpuLimitUtilization: "0.42",
					avgMemoryLimitUtilization: null,
				},
			])

			expect(rows).toEqual([
				{
					serviceName: "checkout-api",
					workloadKind: "deployment",
					workloadName: "checkout-api",
					namespace: "default",
					clusterName: "prod",
					podCount: 4,
					avgCpuLimitUtilization: 0.42,
					avgMemoryLimitUtilization: null,
				},
			])
		}),
	)

	it.effect("fails decoding unknown workload kinds", () =>
		Effect.gen(function* () {
			const compiled = yield* serviceWorkloadsSQL({ services: ["checkout-api"] }, baseParams)

			const exit = yield* Effect.exit(
				compiled.decodeRows([
					{
						serviceName: "checkout-api",
						workloadKind: "cronjob",
						workloadName: "checkout-api",
						namespace: "default",
						clusterName: "prod",
						podCount: 4,
						avgCpuLimitUtilization: 0.42,
						avgMemoryLimitUtilization: 0.5,
					},
				]),
			)

			expect(Exit.isFailure(exit)).toBe(true)
		}),
	)

	it("does not join workloads on clusterName and probes pods via cpu.usage", () => {
		const { sql } = Effect.runSync(serviceWorkloadsSQL({ services: ["checkout-api"] }, baseParams))

		// Regression: spans never carry k8s.cluster.name, so joining on it dropped
		// every row and pod counts always read 0. The identity side must not
		// project a cluster column and the JOIN must not key on it.
		expect(sql).not.toContain("swm.clusterName")
		expect(sql).not.toContain("K8sCluster")

		// cluster is sourced from the metrics side for display only.

		// pods are counted via the always-emitted usage metric, not only the
		// limit-utilization gauges (which require limits to be set).
		expect(sql).toContain("'k8s.pod.cpu.usage'")
	})

	it.effect("empty-service short circuit still carries the workload row schema", () =>
		Effect.gen(function* () {
			const compiled = yield* serviceWorkloadsSQL({ services: [] }, baseParams)

			const rows = yield* compiled.decodeRows([
				{
					serviceName: "checkout-api",
					workloadKind: "unknown",
					workloadName: "",
					namespace: "",
					clusterName: "",
					podCount: "0",
					avgCpuLimitUtilization: null,
					avgMemoryLimitUtilization: null,
				},
			])

			expect(rows).toEqual([
				{
					serviceName: "checkout-api",
					workloadKind: "unknown",
					workloadName: "",
					namespace: "",
					clusterName: "",
					podCount: 0,
					avgCpuLimitUtilization: null,
					avgMemoryLimitUtilization: null,
				},
			])
		}),
	)
})

describe("serviceRuntimeResources", () => {
	const row = (overrides: Partial<ServiceRuntimesOutput>): ServiceRuntimesOutput => ({
		metricServiceName: "fleet-api",
		metricName: "gcp.cloud_run.container.instance.count",
		account: "",
		region: "",
		cluster: "",
		railwayServiceId: "",
		railwayEnvironmentId: "",
		railwayEnvironmentName: "",
		...overrides,
	})
	const railway = (metricServiceName: string, region: string) =>
		row({
			metricServiceName,
			metricName: "railway.cpu.usage",
			region,
			railwayServiceId: "svc_1",
			railwayEnvironmentId: "env_prod",
		})

	it("answers a Worker's series for its script name, never for a service named with the prefix", () => {
		const worker = row({ metricServiceName: "cloudflare-worker/edge", metricName: "cloudflare.worker.cpu_time" })
		expect(serviceRuntimeResources([worker], ["edge"]).map((r) => [r.serviceName, r.kind])).toEqual([
			["edge", "cloudflareWorker"],
		])
		expect(serviceRuntimeResources([worker], ["cloudflare-worker/edge"])).toEqual([])
	})

	it("keeps one Railway resource per environment across regions, and one per name across a rename", () => {
		const regions = serviceRuntimeResources([railway("worker", "us-west"), railway("worker", "eu-west")], ["worker"])
		expect(regions).toHaveLength(1)
		const renamed = serviceRuntimeResources(
			[railway("worker", ""), railway("fleet-worker", "")],
			["worker", "fleet-worker"],
		)
		expect(renamed.map((r) => r.serviceName).sort()).toEqual(["fleet-worker", "worker"])
	})

	it("keeps a Cloud Run service per region and drops series of no runtime kind", () => {
		const resources = serviceRuntimeResources(
			[
				row({ region: "europe-west1" }),
				row({ region: "us-central1" }),
				row({ metricName: "gcp.cloud_run.container.cpu.utilization" }),
			],
			["fleet-api"],
		)
		expect(resources.map((r) => r.region)).toEqual(["europe-west1", "us-central1"])
	})
})
