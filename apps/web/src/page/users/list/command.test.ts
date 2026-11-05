import { Array as Arr, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { facetsInputs, listInputs } from "./command"

const window = { startTime: "2026-06-24 04:00:00", endTime: "2026-06-25 04:00:00" }

describe("listInputs", () => {
	it("reads the rail's namespace picks when nothing is pinned", () => {
		expect(listInputs({ namespaces: ["checkout", "platform"] }, window, null).namespaces).toEqual([
			"checkout",
			"platform",
		])
	})

	it("lets the org pin override the rail's picks", () => {
		expect(listInputs({ namespaces: ["checkout"] }, window, "storefront").namespaces).toEqual([
			"storefront",
		])
	})

	it("sends a blank search as no search", () => {
		expect(listInputs({ q: "   " }, window, null).search).toBeUndefined()
		expect(listInputs({ q: " ada " }, window, null).search).toBe("ada")
	})

	it("cuts a shared URL's namespace and group picks to the 50 the API accepts", () => {
		const picks = Arr.map(Arr.range(1, 60), (n) => `pick_${n}`)
		const inputs = listInputs({ namespaces: picks, groups: picks }, window, null)
		expect(inputs.namespaces).toHaveLength(50)
		expect(inputs.groups).toHaveLength(50)
	})

	it("drops a group pick the API would refuse instead of failing the read", () => {
		const inputs = listInputs({ groups: ["grp_acme", Str.repeat(501)("g"), ""] }, window, null)
		expect(inputs.groups).toEqual(["grp_acme"])
	})

	it("cuts a pasted search to the length the API accepts", () => {
		expect(listInputs({ q: Str.repeat(450)("a") }, window, null).search).toHaveLength(200)
	})

	it("keeps the rail's picks out of the facets, and only the pin in", () => {
		expect(facetsInputs(window, null).namespaces).toEqual([])
		expect(facetsInputs(window, "storefront").namespaces).toEqual(["storefront"])
	})
})
