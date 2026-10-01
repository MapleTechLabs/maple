import { describe, expect, it } from "vitest"
import { parseWhereClause } from "@/lib/traces/advanced-filter-sync"
import { dependencyDrillWhereClause, type DependencyDrillKind } from "./dependency-drill"

const filtersOf = (kind: DependencyDrillKind, target: string, system: string) =>
	parseWhereClause(dependencyDrillWhereClause(kind, target, system))

describe("dependencyDrillWhereClause", () => {
	it("drills a messaging destination on the current key", () => {
		expect(filtersOf("messaging", "orders", "kafka").filters.attributeFilters).toEqual([
			{ key: "messaging.destination.name", value: "orders" },
		])
	})

	// The rollup merges spans whose destination is literally `kafka` into the
	// same edge as the fallback spans, so the drill reaches both halves.
	it("drills both halves of an edge named after its system", () => {
		expect(filtersOf("messaging", "kafka", "kafka").filters.attributeFilters).toEqual([
			{ key: "messaging.system", value: "kafka" },
			{
				key: "messaging.destination.name",
				value: "kafka",
				or: [{ key: "messaging.destination.name", value: "", matchMode: "exists", negated: true }],
			},
		])
	})

	it("drills an rpc service, or the legacy system key when the edge is named by it", () => {
		expect(filtersOf("rpc", "checkout.Cart", "grpc").filters.attributeFilters).toEqual([
			{ key: "rpc.service", value: "checkout.Cart" },
		])
		expect(filtersOf("rpc", "grpc", "grpc").filters.attributeFilters).toEqual([
			{ key: "rpc.system", value: "grpc" },
			{
				key: "rpc.service",
				value: "grpc",
				or: [{ key: "rpc.service", value: "", matchMode: "exists", negated: true }],
			},
		])
	})

	it("drills http, database and service edges on their target key", () => {
		expect(filtersOf("http", "api.stripe.test", "").filters.attributeFilters).toEqual([
			{ key: "server.address", value: "api.stripe.test" },
		])
		expect(filtersOf("database", "postgresql", "").filters.attributeFilters).toEqual([
			{ key: "db.system.name", value: "postgresql" },
		])
		expect(filtersOf("service", "billing", "").filters.attributeFilters).toEqual([
			{ key: "server.address", value: "billing", matchMode: "contains" },
		])
	})

	// A client span is almost never a trace root, and the traces page filters
	// roots unless told otherwise. A dropped clause or a `SpanKind` pseudo-attribute
	// used to leave every drill on an empty or unfiltered list.
	it("opens the span-level list with no dropped clauses or pseudo-attributes", () => {
		for (const [kind, target, system] of [
			["service", "billing", ""],
			["database", "postgresql", ""],
			["messaging", "orders", "kafka"],
			["messaging", "kafka", "kafka"],
			["rpc", "grpc", "grpc"],
			["http", "api.stripe.test", ""],
		] as const) {
			const { filters, warnings } = filtersOf(kind, target, system)
			expect(warnings).toEqual([])
			expect(filters.rootOnly).toBe(false)
			expect(filters.attributeFilters.map((f) => f.key)).not.toContain("SpanKind")
		}
	})
})
