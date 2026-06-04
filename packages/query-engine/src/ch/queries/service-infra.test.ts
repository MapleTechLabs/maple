import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { serviceWorkloadsSQL } from "./service-infra"

const baseParams = {
	orgId: "org_1",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
}

describe("serviceWorkloadsSQL", () => {
	it.effect("decodes workload rows with numeric strings and nullable utilization", () =>
		Effect.gen(function* () {
			const compiled = serviceWorkloadsSQL({ services: ["checkout-api"] }, baseParams)

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
			const compiled = serviceWorkloadsSQL({ services: ["checkout-api"] }, baseParams)

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

	it.effect("empty-service short circuit still carries the workload row schema", () =>
		Effect.gen(function* () {
			const compiled = serviceWorkloadsSQL({ services: [] }, baseParams)

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
