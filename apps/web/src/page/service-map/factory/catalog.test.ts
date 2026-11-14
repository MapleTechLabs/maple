import { describe, expect, test } from "vitest"
import { BUILDING_TYPES, BUILDINGS, type BuildingNode, buildingsFor, defaultBuilding } from "./catalog"

const node = (id: string, kind: BuildingNode["kind"], platform: BuildingNode["platform"] = "unknown") => ({
	id,
	kind,
	platform,
})

describe("defaultBuilding", () => {
	test.each([
		["a database is a tank", node("pg", "database"), "tank"],
		["a queue is a loading bay", node("kafka", "queue"), "loader"],
		["a service named *worker is a loading bay", node("email-worker", "service"), "loader"],
		["a worker-named database stays a tank", node("db-worker", "database"), "tank"],
		["an external dependency is a shed", node("stripe", "external"), "shed"],
		["an edge node is a gateway", node("web", "edge"), "gateway"],
		["a Cloudflare service is a gateway", node("api", "service", "cloudflare"), "gateway"],
		["a plain service is a processor", node("orders", "service"), "processor"],
		[
			"a node without a platform is still classified",
			{ id: "orders", kind: "service" as const },
			"processor",
		],
	])("%s", (_, input, expected) => {
		expect(defaultBuilding(input)).toBe(expected)
	})
})

describe("buildingsFor", () => {
	test("lists every building, the ones that suit the kind first", () => {
		const types = buildingsFor("database")
		expect([...types].sort()).toEqual([...BUILDING_TYPES].sort())
		expect(types[0]).toBe("tank")
	})

	test("each node kind's default building is among its suited ones", () => {
		const kinds = ["edge", "service", "database", "queue", "external"] as const
		for (const kind of kinds) {
			const fallback = defaultBuilding({ id: "n", kind })
			expect(BUILDINGS[fallback].suits).toContain(kind)
		}
	})
})
