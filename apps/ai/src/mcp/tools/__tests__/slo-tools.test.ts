import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Option, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import {
	DeleteSloOutput,
	InspectSloOutput,
	ListSlosOutput,
	SloMutationOutput,
} from "@maple/domain/mcp-outputs"
import { RoleName } from "@maple/domain/primitives"
import { formatWarehouseDateTime } from "@maple/query-engine"
import type { McpToolResult } from "../types"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"
import { installFakeWarehouse, restoreWarehouse, type FixtureRule } from "../../__evals__/fake-warehouse"

/** Bad spans per 1000 in every minute of the burn read, by service. */
const BAD_PER_MILLE = { checkout: 20, search: 0 } as const

const badOf = (sql: string): number =>
	Option.match(
		Arr.findFirst(Rec.keys(BAD_PER_MILLE), (service) => Str.includes(`ServiceName = '${service}'`)(sql)),
		{ onNone: () => 0, onSome: (service) => BAD_PER_MILLE[service] },
	)

/** One batched row per service, in production, as the SLOs list reads them. */
const perService = <Row>(row: (service: keyof typeof BAD_PER_MILLE) => Row) =>
	Arr.map(Rec.keys(BAD_PER_MILLE), (service) => ({
		serviceName: service,
		environment: "production",
		...row(service),
	}))

const fixtures: FixtureRule[] = [
	// The list's batched burn read: each window full of the same uniform minutes.
	{
		match: (sql) => Str.includes("AS total360")(sql),
		rows: () =>
			perService((service) =>
				Rec.fromEntries(
					Arr.flatMap([5, 30, 60, 360], (minutes) => [
						[`total${minutes}`, minutes * 1000],
						[`good${minutes}`, minutes * (1000 - BAD_PER_MILLE[service])],
					]),
				),
			),
	},
	// The list's batched window totals.
	{
		match: (sql) => Str.includes("AS serviceName")(sql),
		rows: () =>
			perService((service) => ({
				total: 1_000_000,
				good: BAD_PER_MILLE[service] > 0 ? 999_500 : 1_000_000,
			})),
	},
	// The burn read: 400 minute buckets of uniform traffic ending just before now.
	{
		match: (sql) =>
			Str.includes("FROM service_overview_spans")(sql) && Str.includes("INTERVAL 60 SECOND")(sql),
		rows: (sql) => {
			const minute = Math.floor(Date.now() / 60_000) * 60_000
			return Arr.makeBy(400, (index) => ({
				bucket: formatWarehouseDateTime(minute - (index + 1) * 60_000),
				total: 1000,
				good: 1000 - badOf(sql),
			}))
		},
	},
	// The window totals: half of a 99.9% budget spent on checkout, none on search.
	{
		match: (sql) => Str.includes("FROM service_overview_spans")(sql),
		rows: (sql) => [{ total: 1_000_000, good: badOf(sql) > 0 ? 999_500 : 1_000_000 }],
	},
]

/** Set by one test to make the list's batched status reads fail as the warehouse would. */
let failStatusReads = false

let member: EvalRuntime
let admin: EvalRuntime
beforeAll(() => {
	installFakeWarehouse(fixtures, (sql) => failStatusReads && Str.includes("AS serviceName")(sql))
	member = makeEvalRuntime()
	admin = { ...member, tenant: { ...member.tenant, roles: [Schema.decodeSync(RoleName)("org:admin")] } }
})
afterAll(async () => {
	restoreWarehouse()
	await member.dispose()
})

const decode = <S extends Schema.Codec<unknown, unknown>>(schema: S, result: McpToolResult) =>
	Schema.decodeSync(schema)(result.structuredContent)

const DENIED = "only org admins and engineers"

describe("create_slo", () => {
	it("is refused for a member who is not an admin or engineer", async () => {
		const result = await runToolDirect(member, "create_slo", {
			name: "Member SLO",
			service: "checkout",
			sli: "availability",
			target_percent: 99.9,
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain(DENIED)
	})

	it("creates an availability SLO with its burn-rate alert on, and points at inspect_slo", async () => {
		const result = await runToolDirect(admin, "create_slo", {
			name: "Checkout availability",
			service_name: "checkout",
			sli: "availability",
			target_percent: 99.9,
			environments: ["production"],
		})
		const output = decode(SloMutationOutput, result)
		expect(output).toMatchObject({
			action: "created",
			slo: {
				serviceName: "checkout",
				environments: ["production"],
				sliKind: "availability",
				latencyThresholdMs: null,
				targetPercent: 99.9,
				windowDays: 30,
				alerting: { enabled: true, criticalDestinationIds: [], warningDestinationIds: [] },
			},
		})
		expect(output.slo.alerting.alertRuleId).not.toBeNull()
		expect(markdown(result)).toContain('inspect_slo slo="Checkout availability"')
	})

	it("creates a latency SLO on a threshold from the ladder", async () => {
		const output = decode(
			SloMutationOutput,
			await runToolDirect(admin, "create_slo", {
				name: "Search latency",
				service: "search",
				sli: "latency",
				threshold_ms: "500",
				target_percent: 99,
				window_days: 7,
			}),
		)
		expect(output.slo).toMatchObject({ sliKind: "latency", latencyThresholdMs: 500, windowDays: 7 })
	})

	it("names the latency threshold it needs, and the window days it accepts", async () => {
		const missing = await runToolDirect(admin, "create_slo", {
			name: "No threshold",
			service: "search",
			sli: "latency",
			target_percent: 99,
		})
		expect(missing.isError).toBe(true)
		expect(markdown(missing)).toContain("needs threshold_ms")

		const offLadder = await runToolDirect(admin, "create_slo", {
			name: "Odd threshold",
			service: "search",
			sli: "latency",
			threshold_ms: 300,
			target_percent: 99,
		})
		expect(offLadder.isError).toBe(true)
		expect(markdown(offLadder)).toContain("250, 500")

		const badWindow = await runToolDirect(admin, "create_slo", {
			name: "Odd window",
			service: "search",
			sli: "availability",
			target_percent: 99,
			window_days: 14,
		})
		expect(badWindow.isError).toBe(true)
		expect(markdown(badWindow)).toContain("window_days must be 7, 28 or 30")
	})

	it("refuses a target outside 50 to 99.999 and an unknown destination as bad input", async () => {
		const target = await runToolDirect(admin, "create_slo", {
			name: "Too strict",
			service: "checkout",
			sli: "availability",
			target_percent: 100,
		})
		expect(target.isError).toBe(true)
		expect(markdown(target)).toContain("between 50 and 99.999")

		const destination = await runToolDirect(admin, "create_slo", {
			name: "Ghost pager",
			service: "checkout",
			sli: "availability",
			target_percent: 99,
			critical_destination_ids: ["5f0c8a52-1111-4222-8333-444455556666"],
		})
		expect(destination.isError).toBe(true)
		expect(markdown(destination)).toContain("Unknown alert destination")
	})
})

describe("list_slos", () => {
	it("still lists every SLO's config when the status read fails, and says what to do next", async () => {
		failStatusReads = true
		const result = await runToolDirect(member, "list_slos", {}).finally(() => {
			failStatusReads = false
		})
		const output = decode(ListSlosOutput, result)
		expect(output.slos.length).toBeGreaterThan(0)
		for (const row of output.slos) {
			expect(row).toMatchObject({ sli: null, budgetRemaining: null, burning: null })
			expect(row.statusError).toContain("inspect_slo")
		}
	})

	it("puts the burning SLO first with its SLI, budget left and worst burn", async () => {
		const result = await runToolDirect(member, "list_slos", {})
		const output = decode(ListSlosOutput, result)
		expect(Arr.map(output.slos, (row) => row.name)).toEqual(["Checkout availability", "Search latency"])
		const [checkout, search] = output.slos
		expect(checkout).toMatchObject({
			sli: 0.9995,
			burning: "critical",
			worstBurnWindow: "5m",
			statusError: null,
		})
		expect(checkout?.budgetRemaining).toBeCloseTo(0.5)
		expect(checkout?.worstBurnRate).toBeCloseTo(20)
		expect(search).toMatchObject({ burning: null, worstBurnRate: 0, budgetRemaining: 1 })
		expect(markdown(result)).toContain('inspect_slo slo="Checkout availability"')
	})

	it("filters by service", async () => {
		const output = decode(ListSlosOutput, await runToolDirect(member, "list_slos", { service: "search" }))
		expect(Arr.map(output.slos, (row) => row.name)).toEqual(["Search latency"])
		expect(output.serviceFilter).toBe("search")
	})
})

describe("inspect_slo", () => {
	it("shows each burn window, the breaching tiers and the rule's incidents as the next call", async () => {
		const result = await runToolDirect(member, "inspect_slo", { slo: "Checkout availability" })
		const output = decode(InspectSloOutput, result)
		expect(Arr.map(output.status.burnWindows, (window) => window.window)).toEqual([
			"5m",
			"30m",
			"1h",
			"6h",
		])
		for (const window of output.status.burnWindows) {
			expect(window.total).toBe(window.windowMinutes * 1000)
			expect(window.burnRate).toBeCloseTo(20)
		}
		expect(output.status.tiers).toMatchObject([
			{ severity: "critical", factor: 14.4, longWindow: "1h", shortWindow: "5m", breached: true },
			{ severity: "warning", factor: 6, longWindow: "6h", shortWindow: "30m", breached: true },
		])
		expect(output.status).toMatchObject({ total: 1_000_000, good: 999_500 })
		expect(markdown(result)).toContain("The critical tier is breaching")
		expect(markdown(result)).toContain(
			`get_incident_timeline rule_id="${output.slo.alerting.alertRuleId ?? "missing"}"`,
		)
	})

	it("finds an SLO by its id and says how to list them when nothing matches", async () => {
		const listed = decode(ListSlosOutput, await runToolDirect(member, "list_slos", { service: "search" }))
		const byId = decode(
			InspectSloOutput,
			await runToolDirect(member, "inspect_slo", { slo: listed.slos[0]?.id ?? "missing" }),
		)
		expect(byId.slo.name).toBe("Search latency")
		expect(Arr.every(byId.status.tiers, (tier) => !tier.breached)).toBe(true)

		// The incident tools hint at inspect_slo by the incident's rule id.
		const byRule = decode(
			InspectSloOutput,
			await runToolDirect(member, "inspect_slo", { slo: byId.slo.alerting.alertRuleId ?? "missing" }),
		)
		expect(byRule.slo.id).toBe(byId.slo.id)

		const missing = await runToolDirect(member, "inspect_slo", { slo: "Nope" })
		expect(missing.isError).toBe(true)
		expect(markdown(missing)).toContain("list_slos")
	})
})

describe("update_slo", () => {
	it("is refused for a member", async () => {
		const result = await runToolDirect(member, "update_slo", {
			slo: "Checkout availability",
			target_percent: 99,
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain(DENIED)
	})

	it("silences the burn alert and changes the target, keeping the other fields", async () => {
		const result = await runToolDirect(admin, "update_slo", {
			slo: "Checkout availability",
			alerting_enabled: false,
			target_percent: 99.5,
		})
		const output = decode(SloMutationOutput, result)
		expect(output.slo).toMatchObject({
			targetPercent: 99.5,
			serviceName: "checkout",
			environments: ["production"],
			alerting: { enabled: false },
		})
		expect(markdown(result)).toContain("Burn-rate alerts are off")
	})

	it("changes a latency threshold alone and refuses one on an availability SLI", async () => {
		const latency = decode(
			SloMutationOutput,
			await runToolDirect(admin, "update_slo", { slo: "Search latency", threshold_ms: 1000 }),
		)
		expect(latency.slo).toMatchObject({ sliKind: "latency", latencyThresholdMs: 1000 })

		const availability = await runToolDirect(admin, "update_slo", {
			slo: "Checkout availability",
			threshold_ms: 1000,
		})
		expect(availability.isError).toBe(true)
		expect(markdown(availability)).toContain("threshold_ms applies to a latency SLI")
	})

	it("sets a description, and clear_description removes it", async () => {
		const described = decode(
			SloMutationOutput,
			await runToolDirect(admin, "update_slo", {
				slo: "Search latency",
				description: "Search stays fast",
			}),
		)
		expect(described.slo.description).toBe("Search stays fast")
		const cleared = decode(
			SloMutationOutput,
			await runToolDirect(admin, "update_slo", { slo: "Search latency", clear_description: true }),
		)
		expect(cleared.slo.description).toBeNull()
	})
})

describe("delete_slo", () => {
	it("refuses a member outright, without asking them to confirm first", async () => {
		const result = await runToolDirect(member, "delete_slo", { slo: "Search latency", confirm: false })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain(DENIED)
		expect(markdown(result)).not.toContain("confirm=true")
	})

	it("asks for confirmation, then deletes so the SLO no longer lists", async () => {
		const unconfirmed = await runToolDirect(admin, "delete_slo", {
			slo: "Search latency",
			confirm: false,
		})
		expect(unconfirmed.isError).toBe(true)
		expect(markdown(unconfirmed)).toContain("confirm=true")

		const deleted = decode(
			DeleteSloOutput,
			await runToolDirect(admin, "delete_slo", { slo: "Search latency", confirm: true }),
		)
		expect(deleted).toMatchObject({ deleted: true, name: "Search latency" })
		const listed = decode(ListSlosOutput, await runToolDirect(member, "list_slos", {}))
		expect(Arr.map(listed.slos, (row) => row.name)).toEqual(["Checkout availability"])
	})
})
