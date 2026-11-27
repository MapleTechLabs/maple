import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, Option } from "effect"
import { accessEntryOf, endpointsBehind, type EndpointAccessEntry, gatedEndpointsOf } from "./access-catalog"
import { decideEndpointAccess } from "./endpoint-access"
import { accessCatalog, mapleApis } from "./maple-access-catalog"

const catalog = accessCatalog()

const entry = (group: string, endpoint: string): EndpointAccessEntry =>
	Option.getOrThrow(Arr.findFirst(catalog, (one) => one.group === group && one.endpoint === endpoint))

const nameOf = (one: EndpointAccessEntry): string => `${one.group}.${one.endpoint}`

describe("the access catalog", () => {
	// The catalog is only worth showing if the gate does what it says.
	it("names exactly what the gate asks: holding it gets in, lacking any one of it does not", () => {
		const wrong = Arr.filter(gatedEndpointsOf(mapleApis), (gated) => {
			const { requires, unmarked } = accessEntryOf(gated)
			if (unmarked) return false
			const letsIn = decideEndpointAccess(requires, gated)._tag === "Allowed"
			const needsEach = Arr.every(
				requires,
				(permission) =>
					decideEndpointAccess(
						Arr.filter(requires, (held) => held !== permission),
						gated,
					)._tag === "Denied",
			)
			return !letsIn || !needsEach
		})
		expect(Arr.map(wrong, (gated) => nameOf(accessEntryOf(gated)))).toEqual([])
	})

	it("has no write left without a rule", () => {
		expect(
			Arr.map(
				Arr.filter(catalog, (one) => one.unmarked),
				nameOf,
			),
		).toEqual([])
	})

	it("tells what the gate asks apart from what the handler asks for some requests", () => {
		expect(entry("alertRules", "create")).toMatchObject({
			method: "POST",
			path: "/v2/alerts/rules",
			requires: [],
			handler: expect.arrayContaining(["alerts:manage", "query:sql"]),
		})
		expect(entry("dashboards", "upsertShare").requires).toEqual(
			expect.arrayContaining(["telemetry:read", "dashboards:share"]),
		)
	})

	it("carries a handler's own permission beside the gate's rule on one endpoint", () => {
		// Creating a board needs Build dashboards; one that holds raw SQL also needs Run raw SQL.
		expect(entry("dashboards", "create")).toMatchObject({
			requires: expect.arrayContaining(["dashboards:edit", "telemetry:read"]),
			handler: ["query:sql"],
		})
		// Open to every member, and the handler asks billing of one who cannot read telemetry.
		expect(entry("billing", "getDailySpend")).toMatchObject({ requires: [], handler: ["billing:manage"] })
	})

	it("reads nothing into a group's handler mark for its reads, which need Read telemetry", () => {
		expect(entry("alertRules", "list")).toMatchObject({ requires: ["telemetry:read"], handler: [] })
	})

	it("lists what a permission opens, with whether the gate or the handler asks for it", () => {
		const share = endpointsBehind(catalog, "dashboards:share")
		expect(Arr.map(share, (one) => [nameOf(one), one.use])).toContainEqual([
			"dashboards.upsertShare",
			"requires",
		])
		const alerts = endpointsBehind(catalog, "alerts:manage")
		expect(Arr.map(alerts, (one) => [nameOf(one), one.use])).toContainEqual([
			"alertRules.create",
			"handler",
		])
	})
})
