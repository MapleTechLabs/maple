import { describe, expect, it } from "@effect/vitest"
import { Array as Arr } from "effect"
import * as Policy from "../policy"
import { accessEntryOf, endpointsBehind, type EndpointAccessEntry, gatedEndpointsOf } from "./access-catalog"
import { decideEndpointAccess } from "./endpoint-access"
import { accessCatalog, mapleApis } from "./maple-access-catalog"

const catalog = accessCatalog()
const nameOf = (entry: EndpointAccessEntry): string => `${entry.api}.${entry.group}.${entry.endpoint}`

describe("the catalog over Maple's own APIs", () => {
	it("reads every API: the dashboard's, the public v2 and the AI app's", () => {
		expect(Arr.dedupe(Arr.map(catalog, (entry) => entry.api)).sort()).toEqual([
			"MapleAiApi",
			"MapleApi",
			"MapleApiV2",
			"MapleInternalApi",
		])
	})

	it("has no write left without a rule", () => {
		expect(
			Arr.map(
				Arr.filter(catalog, (entry) => entry.unmarked),
				nameOf,
			),
		).toEqual([])
	})

	// The lookup for the scoped read is written apart from the gate, so it is held to the gate here.
	it("lists under the scoped read every endpoint the gate opens to a role limited to namespaces", () => {
		const limited: Policy.Grants = [Policy.SCOPED_READ]
		const opened = Arr.filter(
			gatedEndpointsOf(mapleApis),
			(gated) =>
				decideEndpointAccess(limited, gated)._tag === "Allowed" &&
				decideEndpointAccess([], gated)._tag !== "Allowed",
		)
		expect(opened.length).toBeGreaterThan(0)
		expect(Arr.map(endpointsBehind(catalog, Policy.SCOPED_READ), nameOf).sort()).toEqual(
			Arr.map(opened, (gated) => nameOf(accessEntryOf(gated))).sort(),
		)
	})
})
