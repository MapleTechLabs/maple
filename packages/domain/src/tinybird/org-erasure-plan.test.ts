import { describe, expect, it } from "vitest"
import { Array as Arr } from "effect"
import { RETAINED_ON_ORG_ERASURE, WAREHOUSE_ERASURE_TARGETS, warehouseErasureRank } from "./org-erasure-plan"

const names = Arr.map(WAREHOUSE_ERASURE_TARGETS, (target) => target.datasource)
const position = (name: string) => names.indexOf(name)

describe("WAREHOUSE_ERASURE_TARGETS", () => {
	it("erases a rollup before the raw table it is filled from", () => {
		expect(warehouseErasureRank("traces")).toBe(0)
		expect(warehouseErasureRank("logs")).toBe(0)
		expect(warehouseErasureRank("service_overview_minutely")).toBeGreaterThan(0)
		expect(position("service_overview_minutely")).toBeLessThan(position("traces"))
		// Filled by a scheduled job rather than a view, so only the plan's own list orders it.
		expect(position("service_map_edges_hourly")).toBeLessThan(position("traces"))
	})

	it("ranks a view's target above every table that feeds it", () => {
		expect(warehouseErasureRank("service_map_edges_hourly")).toBeGreaterThan(
			warehouseErasureRank("service_map_edges_hourly_ingest"),
		)
	})

	it("keeps the org audit log and erases the rest, connected platforms' audit events included", () => {
		expect([...RETAINED_ON_ORG_ERASURE]).toEqual(["audit_log"])
		expect(names).not.toContain("audit_log")
		expect(names).toContain("audit_trail_events")
		expect(names).toContain("session_replay_events")
		expect(Arr.dedupe(names)).toEqual(names)
	})

	it("is ordered by rank, deepest first", () => {
		const ranks = Arr.map(WAREHOUSE_ERASURE_TARGETS, (target) => target.rank)
		expect(ranks).toEqual(Arr.sort(ranks, (a: number, b: number) => (a > b ? -1 : a < b ? 1 : 0)))
	})
})
