import { describe, expect, it } from "vitest"
import { parseWhereClause } from "@maple/domain/where-clause"
import { dependencyDrillWhereClause } from "./dependency-drill"

describe("dependencyDrillWhereClause", () => {
	it("drills a messaging destination on the current key", () => {
		expect(dependencyDrillWhereClause("messaging", "orders", "kafka")).toBe(
			`SpanKind = 'Producer' AND messaging.destination.name = "orders"`,
		)
	})

	it("drills a messaging edge named by its system on messaging.system", () => {
		expect(dependencyDrillWhereClause("messaging", "kafka", "kafka")).toBe(
			`SpanKind = 'Producer' AND messaging.system = "kafka"`,
		)
	})

	it("drills an rpc service, or the system when the edge is named by it", () => {
		expect(dependencyDrillWhereClause("rpc", "checkout.Cart", "grpc")).toBe(
			`SpanKind = 'Client' AND rpc.service = "checkout.Cart"`,
		)
		expect(dependencyDrillWhereClause("rpc", "grpc", "grpc")).toBe(
			`SpanKind = 'Client' AND rpc.system.name = "grpc"`,
		)
	})

	it("drills an http edge on server.address", () => {
		expect(dependencyDrillWhereClause("http", "api.stripe.test", "")).toBe(
			`SpanKind = 'Client' AND server.address = "api.stripe.test"`,
		)
	})

	// The parser drops `(a OR b)` groups with a warning; a drill that relied on
	// one silently filtered on SpanKind alone.
	it("parses every drill into clauses without warnings", () => {
		for (const [kind, target, system] of [
			["messaging", "orders", "kafka"],
			["messaging", "kafka", "kafka"],
			["rpc", "grpc", "grpc"],
			["http", "api.stripe.test", ""],
		] as const) {
			const parsed = parseWhereClause(dependencyDrillWhereClause(kind, target, system))
			expect(parsed.warnings).toEqual([])
			expect(parsed.clauses).toHaveLength(2)
		}
	})
})
