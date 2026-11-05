import { describe, expect, it } from "vitest"
import { facetsInputs, listInputs } from "./command"
import { userHref } from "./update"

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

	it("keeps the rail's picks out of the facets, and only the pin in", () => {
		expect(facetsInputs(window, null).namespaces).toEqual([])
		expect(facetsInputs(window, "storefront").namespaces).toEqual(["storefront"])
	})
})

describe("userHref", () => {
	it("links a row to the user page over the directory's window", () => {
		expect(userHref({ timePreset: "24h", q: "ada" })("user/42")).toBe("/users/user%2F42?timePreset=24h")
	})
})
