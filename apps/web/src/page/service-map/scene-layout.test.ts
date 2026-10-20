import { decorateRoutes, factoryRoutes } from "../../components/service-map/three/factory-routing"
import type { Edge3D, Node3D, Topology3D } from "../../components/service-map/three/types"
import { describe, expect, test } from "vitest"
import { machineBadge } from "./badge"
import { layoutTopologyOf, linkLabels, spatialLayoutOf, topologyKeyOf } from "./scene-layout"

const node = (id: string, namespace: string, kind: Node3D["kind"] = "service"): Node3D => ({
	id,
	label: id,
	kind,
	namespace,
	platform: "unknown",
	throughput: 1,
	errorRate: 0,
})

const edge = (source: string, target: string, callsPerSecond: number, errorRate = 0): Edge3D => ({
	source,
	target,
	callsPerSecond,
	errorRate,
	avgLatencyMs: 5,
})

const TOPOLOGY: Topology3D = {
	nodes: [
		node("web", "edge", "edge"),
		node("api", "shop"),
		node("orders", "shop"),
		node("kafka", "queues", "queue"),
		node("pg", "databases", "database"),
	],
	edges: [
		edge("web", "api", 40),
		edge("api", "orders", 2),
		edge("orders", "kafka", 0.5),
		edge("orders", "pg", 1, 0.2),
		edge("api", "pg", 0.1),
	],
}

describe("3D labels match the scene's belts", () => {
	test.each(["atlas", "cascade"] as const)("%s: ids, order and prominence equal decorateRoutes", (view) => {
		const layout = spatialLayoutOf(TOPOLOGY, view)
		const routes = factoryRoutes(layoutTopologyOf(topologyKeyOf(TOPOLOGY)), layout)
		const legacy = decorateRoutes(routes, TOPOLOGY.edges).map(({ id, edge, prominent }) => ({
			id,
			edge,
			prominent,
		}))
		expect(linkLabels(TOPOLOGY, layout)).toEqual(legacy)
	})

	test("the busiest call, queue belts and failing calls are prominent; quiet calls are not", () => {
		const prominent = linkLabels(TOPOLOGY, spatialLayoutOf(TOPOLOGY, "atlas"))
			.filter((link) => link.prominent)
			.map((link) => link.id)
		expect(prominent).toEqual(['link:["orders","kafka"]', 'link:["orders","pg"]', 'link:["web","api"]'])
	})

	test("metrics do not move the layout key; a new node does", () => {
		const busier = { ...TOPOLOGY, edges: TOPOLOGY.edges.map((e) => ({ ...e, callsPerSecond: 9 })) }
		expect(topologyKeyOf(busier)).toBe(topologyKeyOf(TOPOLOGY))
		const grown = { ...TOPOLOGY, nodes: [...TOPOLOGY.nodes, node("cart", "shop")] }
		expect(topologyKeyOf(grown)).not.toBe(topologyKeyOf(TOPOLOGY))
	})
})

describe("machine badges", () => {
	test("a database's system wins over the runtime; unknown runtimes get none", () => {
		expect(machineBadge({ kind: "database", system: "postgresql", runtime: "nodejs" })).toEqual({
			label: "PostgreSQL",
			mark: "postgres",
		})
		expect(machineBadge({ kind: "queue", system: "Kafka" })).toEqual({ label: "Kafka", mark: "kafka" })
		expect(machineBadge({ kind: "service", runtime: "node" })).toEqual({
			label: "Node.js",
			mark: "nodejs",
		})
		expect(machineBadge({ kind: "service", runtime: "go" })).toEqual({ label: "Go", wordmark: "Go" })
		expect(machineBadge({ kind: "service", runtime: "fastly" })).toEqual({
			label: "Fastly Compute",
			wordmark: "fastly",
		})
		expect(machineBadge({ kind: "service", runtime: "cobol" })).toBeNull()
	})
})
