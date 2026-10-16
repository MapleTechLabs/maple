import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Schema } from "effect"
import { InspectInfraOutput, ListInfraOutput } from "@maple/domain/mcp-outputs"
import type { McpToolResult } from "../types"
import { installFakeWarehouse, restoreWarehouse } from "../../__evals__/fake-warehouse"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"
import { infraFixtureRules } from "../../__evals__/infra-world"
import { PROVIDER_WORLD, providerFixtureRules } from "../../__evals__/provider-world"

const WINDOW = { start_time: "2026-10-01 06:00:00", end_time: "2026-10-01 12:00:00" }

let rt: EvalRuntime
beforeAll(() => {
	installFakeWarehouse([...providerFixtureRules(), ...infraFixtureRules()], undefined, "empty")
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

describe("list_infra provider kinds", () => {
	it("lists Cloudflare zones with the one serving 5xx first and flags it", async () => {
		const result = await call("list_infra", { kind: "cloudflare_zones" })
		const output = decode(ListInfraOutput, result)
		expect(output.reporting).toEqual(["cloudflare_zones"])
		const zone = output.sections[0]?.rows[0]
		expect(zone?.name).toBe(PROVIDER_WORLD.failingZone)
		expect(zone?.errorRate).toBeCloseTo(0.065, 3)
		const text = markdown(result)
		expect(text).toContain("HIGH 5xx: 6.50%")
		expect(text).toContain(`inspect_infra kind="cloudflare_zone" name="${PROVIDER_WORLD.failingZone}"`)
	})

	it("reads status=hot on a traffic kind as an error rate, counted against the whole fleet", async () => {
		const result = await call("list_infra", { kind: "cloudflare_zones", status: "hot" })
		const section = decode(ListInfraOutput, result).sections[0]
		expect(section?.rows.map((row) => row.name)).toEqual([PROVIDER_WORLD.failingZone])
		expect(section?.summary?.total).toBe(3)
	})

	it("measures Railway services against their limits and scopes by environment", async () => {
		const output = decode(
			ListInfraOutput,
			await call("list_infra", { kind: "railway_services", environment: "staging" }),
		)
		const rows = output.sections[0]?.rows ?? []
		expect(rows.map((row) => [row.name, row.environment])).toEqual([["api", "staging"]])
		expect(rows[0]?.cpuPeak).toBeCloseTo(0.1, 3)
	})

	it("leaves provider kinds out of the overview when no integration is connected", async () => {
		const output = decode(ListInfraOutput, await call("list_infra", {}))
		expect(output.sections.some((section) => section.kind.startsWith("cloudflare"))).toBe(false)
		expect(output.reporting).not.toContain("railway_services")
	})
})

describe("inspect_infra provider kinds", () => {
	it("shows when a zone's 5xx climbed and offers the other sections", async () => {
		const result = await call("inspect_infra", {
			kind: "cloudflare_zone",
			name: PROVIDER_WORLD.failingZone,
		})
		const output = decode(InspectInfraOutput, result)
		expect(output.section).toBe("traffic")
		const fiveXx = output.series.find((s) => s.label === "5xx per bucket")
		expect(fiveXx?.change).toBeGreaterThan(0)
		expect(output.breakdowns?.map((b) => b.title)).toEqual([
			"Requests by status class",
			"Requests by cache status",
		])
		expect(markdown(result)).toContain('section="security"')
	})

	it("lists the firewall rules that fired in the security section", async () => {
		const output = decode(
			InspectInfraOutput,
			await call("inspect_infra", {
				kind: "cloudflare_zone",
				name: PROVIDER_WORLD.failingZone,
				section: "security",
			}),
		)
		const rules = output.breakdowns?.find((b) => b.title === "Top firewall rules")
		expect(rules?.rows[0]?.key).toBe(`firewallManaged / block / 100015 / ${PROVIDER_WORLD.failingZone}`)
	})

	it("picks the busiest environment of a Railway service and names the others", async () => {
		const result = await call("inspect_infra", {
			kind: "railway_service",
			name: PROVIDER_WORLD.hotRailwayService,
		})
		const output = decode(InspectInfraOutput, result)
		expect(output.entity?.environment).toBe("production")
		expect(output.details?.Environments).toContain("staging")
		const staging = decode(
			InspectInfraOutput,
			await call("inspect_infra", {
				kind: "railway_service",
				name: PROVIDER_WORLD.hotRailwayService,
				environment: "staging",
			}),
		)
		expect(staging.entity?.environment).toBe("staging")
	})

	it("reads PlanetScale percentages as fractions", async () => {
		const output = decode(
			InspectInfraOutput,
			await call("inspect_infra", { kind: "planetscale_database", name: PROVIDER_WORLD.fullDatabase }),
		)
		expect(output.entity?.disk).toBeCloseTo(0.785, 3)
		const storage = output.series.find((s) => s.label.startsWith("storage used"))
		expect(storage?.max).toBeLessThan(1)
	})

	it("points at list_infra when the zone does not exist", async () => {
		const result = await call("inspect_infra", { kind: "cloudflare_zone", name: "nope.example.com" })
		expect(decode(InspectInfraOutput, result).found).toBe(false)
		expect(markdown(result)).toContain('list_infra kind="cloudflare_zones" search="nope.example.com"')
	})
})
