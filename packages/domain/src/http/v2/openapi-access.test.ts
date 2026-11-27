import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, Predicate, String as Str } from "effect"
import { OpenApi } from "effect/http-api"
import { accessCatalogOf } from "../access-catalog"
import { MapleApiV2 } from "./api"
import { accessSentences } from "./openapi-access"

const document = OpenApi.fromApi(MapleApiV2)

const operation = (method: string, path: string): Record<string, unknown> => {
	const found: unknown = document.paths[path]?.[method]
	return Predicate.isObject(found) ? found : {}
}

describe("role permissions in the OpenAPI document", () => {
	it("names what the gate asks and what the handler may ask, on the operation and in its description", () => {
		const create = operation("post", "/v2/dashboards")
		expect(create["x-required-permissions"]).toEqual(["dashboards:edit", "telemetry:read"])
		expect(create["x-conditional-permissions"]).toEqual(["query:sql"])
		expect(create["description"]).toContain(
			"The caller's role needs Build dashboards (`dashboards:edit`) and Read telemetry (`telemetry:read`). Depending on the request, it also needs Run raw SQL (`query:sql`).",
		)
	})

	it("keeps the description the endpoint wrote, and adds to it", () => {
		const list = operation("get", "/v2/uptime_monitors")
		expect(list["description"]).toMatch(/^Returns your organization's uptime monitors/)
		expect(list["x-required-permissions"]).toEqual(["telemetry:read"])
	})

	it("matches an operation with path parameters", () => {
		expect(operation("delete", "/v2/dashboards/{id}")["x-required-permissions"]).toEqual([
			"dashboards:edit",
			"telemetry:read",
		])
	})

	// A catalog path the document spells differently would silently lose its permissions.
	it("reaches every gated endpoint that asks for something", () => {
		const missed = Arr.filter(
			accessCatalogOf([MapleApiV2]),
			(entry) =>
				accessSentences(entry) !== "" &&
				!Str.includes(accessSentences(entry))(
					String(
						operation(
							Str.toLowerCase(entry.method),
							Str.replaceAll(/:([A-Za-z0-9_]+)/g, "{$1}")(entry.path),
						)["description"],
					),
				),
		)
		expect(Arr.map(missed, (entry) => `${entry.method} ${entry.path}`)).toEqual([])
	})

	it("says nothing for an endpoint open to every member", () => {
		expect(accessSentences({ requires: [], handler: [] })).toBe("")
	})
})
