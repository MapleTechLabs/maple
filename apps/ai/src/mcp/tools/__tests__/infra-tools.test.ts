import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Schema } from "effect"
import { DiagnoseServiceOutput, InspectInfraOutput, ListInfraOutput } from "@maple/domain/mcp-outputs"
import type { McpToolResult } from "../types"
import { installFakeWarehouse, restoreWarehouse, type FixtureRule } from "../../__evals__/fake-warehouse"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"
import { INFRA_WORLD, infraFixtureRules } from "../../__evals__/infra-world"

const WINDOW = { start_time: "2026-10-01 06:00:00", end_time: "2026-10-01 12:00:00" }

let rt: EvalRuntime
// The fake client is installed once; a case swaps what it answers by replacing the rules in place.
const rules: Array<FixtureRule> = infraFixtureRules()
beforeAll(() => {
	installFakeWarehouse(rules, undefined, "empty")
	rt = makeEvalRuntime()
})
afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

const call = (name: string, params: Record<string, unknown>): Promise<McpToolResult> =>
	runToolDirect(rt, name, { ...WINDOW, ...params })

const decode = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, result: McpToolResult) =>
	Schema.decodeUnknownSync(schema)(result.structuredContent)

describe("list_infra", () => {
	it("gives an overview of every reporting kind, hottest first", async () => {
		const result = await call("list_infra", {})
		const output = decode(ListInfraOutput, result)
		expect(output.reporting).toEqual(["hosts", "pods", "nodes", "workloads", "containers"])
		const pods = output.sections.find((s) => s.kind === "pods")
		expect(pods?.rows[0]?.name).toBe(INFRA_WORLD.oomPod)
		expect(pods?.summary?.saturated).toBe(1)
		expect(pods?.truncated).toBe(true)
		const text = markdown(result)
		expect(text).toContain("## Infrastructure overview")
		expect(text).toContain("AT LIMIT: memory peaked at 98.00% of limit")
		expect(text).toContain(`inspect_infra kind="pod" name="${INFRA_WORLD.oomPod}"`)
	})

	it("narrows pods by namespace and keeps only hot ones", async () => {
		const output = decode(
			ListInfraOutput,
			await call("list_infra", { kind: "pods", namespace: "shop", status: "hot" }),
		)
		const names = output.sections[0]?.rows.map((r) => r.name) ?? []
		expect(names[0]).toBe(INFRA_WORLD.oomPod)
		expect(names.every((name) => name.startsWith("checkout-"))).toBe(true)
	})

	it("reads a singular kind as its plural", async () => {
		const output = decode(ListInfraOutput, await call("list_infra", { kind: "host" }))
		expect(output.kind).toBe("hosts")
	})

	it("leaves kinds out of an overview when they cannot apply the filter", async () => {
		const output = decode(ListInfraOutput, await call("list_infra", { node: INFRA_WORLD.hotNode }))
		expect(output.sections.map((s) => s.kind)).toEqual(["pods", "nodes"])
		expect(output.sections[0]?.rows.every((r) => r.node === INFRA_WORLD.hotNode)).toBe(true)
	})

	it("shows pod restarts in the pod list", async () => {
		const output = decode(ListInfraOutput, await call("list_infra", { kind: "pods" }))
		expect(output.sections[0]?.rows.find((r) => r.name === INFRA_WORLD.oomPod)?.restarts).toBe(1)
	})

	it("keys pod restarts by namespace as well as name", async () => {
		rules.unshift({
			match: (sql) => sql.includes(" AS totalRestarts"),
			rows: [
				{
					namespace: "shop",
					podName: INFRA_WORLD.oomPod,
					containerName: "checkout",
					restarts: 1,
					totalRestarts: 3,
				},
				{
					namespace: "staging",
					podName: INFRA_WORLD.oomPod,
					containerName: "checkout",
					restarts: 7,
					totalRestarts: 9,
				},
			],
		})
		const output = decode(ListInfraOutput, await call("list_infra", { kind: "pods" }))
		rules.shift()
		expect(output.sections[0]?.rows.find((r) => r.name === INFRA_WORLD.oomPod)?.restarts).toBe(1)
	})

	it("lists only pods without limits", async () => {
		const output = decode(
			ListInfraOutput,
			await call("list_infra", { kind: "pods", status: "no_limits" }),
		)
		expect(output.sections[0]?.rows.map((r) => r.name).sort()).toEqual([
			"otel-agent-q4w9e",
			"otel-agent-x8k2l",
		])
	})

	it("flags workloads that set no limits", async () => {
		const result = await call("list_infra", { kind: "workloads", workload_kind: "daemonset" })
		const row = decode(ListInfraOutput, result).sections[0]?.rows[0]
		expect(row?.name).toBe(INFRA_WORLD.unboundedWorkload)
		expect(row?.unbounded).toBe(true)
		expect(markdown(result)).toContain("no limits")
	})

	it("says which kinds report when the asked-for kind does not", async () => {
		rules.unshift({ match: (sql) => sql.includes(" AS surface"), rows: [{ surface: "hosts" }] })
		const text = markdown(await call("list_infra", { kind: "pods" }))
		rules.shift()
		expect(text).toContain("No pods report metrics in this window. Reporting: hosts.")
	})
})

describe("inspect_infra", () => {
	it("finds the time a pod peaked against its memory limit", async () => {
		const output = decode(
			InspectInfraOutput,
			await call("inspect_infra", { kind: "pod", name: INFRA_WORLD.oomPod }),
		)
		expect(output.found).toBe(true)
		expect(output.entity?.workload).toBe("checkout")
		const memory = output.series.find((s) => s.label.startsWith("memory"))
		expect(memory?.max).toBeCloseTo(0.98, 2)
		expect(memory?.maxAt.startsWith("2026-10-01 10:")).toBe(true)
	})

	it("resolves a workload without its kind and lists its pods", async () => {
		const result = await call("inspect_infra", { kind: "workload", name: "checkout" })
		const output = decode(InspectInfraOutput, result)
		expect(output.entity?.workloadKind).toBe("deployment")
		expect(output.children?.rows.map((r) => r.name)).toContain(INFRA_WORLD.oomPod)
		expect(markdown(result)).toContain('attribute_key="k8s.deployment.name"')
	})

	it("reads host CPU as 1 - idle and lists the host's containers", async () => {
		const output = decode(
			InspectInfraOutput,
			await call("inspect_infra", { kind: "host", name: INFRA_WORLD.hotHost }),
		)
		const cpu = output.series.find((s) => s.label === "cpu busy")
		expect(cpu?.avg).toBeGreaterThan(0.85)
		expect(output.children?.rows[0]?.name).toBe(INFRA_WORLD.hotContainer)
		expect(output.details?.["disk /var/lib/docker"]).toContain("93.00% full at most")
	})

	it("compares a node with its peers", async () => {
		const result = await call("inspect_infra", { kind: "nodes", name: INFRA_WORLD.hotNode })
		const output = decode(InspectInfraOutput, result)
		expect(output.kind).toBe("node")
		expect(output.details?.["other nodes (CPU cores, avg)"]).toContain("ip-10-0-3-21")
	})

	it("calls out a drop after a memory peak", async () => {
		const text = markdown(await call("inspect_infra", { kind: "pod", name: INFRA_WORLD.oomPod }))
		expect(text).toContain("then fell to")
		expect(text).toContain("OOM kill")
	})

	it("points at list_infra when the name does not exist", async () => {
		const result = await call("inspect_infra", { kind: "pod", name: "checkout-typo" })
		expect(decode(InspectInfraOutput, result).found).toBe(false)
		expect(markdown(result)).toContain('list_infra kind="pods" search="checkout-typo"')
	})
})

describe("diagnose_service", () => {
	it("shows the workload and pods a service runs on", async () => {
		const result = await call("diagnose_service", { service: "checkout" })
		const output = decode(DiagnoseServiceOutput, result)
		expect(output.infrastructure?.workloads[0]?.name).toBe("checkout")
		expect(output.infrastructure?.pods[0]?.name).toBe(INFRA_WORLD.oomPod)
		expect(markdown(result)).toContain(`inspect_infra kind="pod" name="${INFRA_WORLD.oomPod}"`)
	})

	it("omits infrastructure for a service with no Kubernetes context", async () => {
		const output = decode(DiagnoseServiceOutput, await call("diagnose_service", { service: "cron" }))
		expect(output.infrastructure).toBeUndefined()
		expect(output.infrastructureError).toBeUndefined()
	})
})
