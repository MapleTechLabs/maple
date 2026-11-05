import { describe, expect, it } from "vitest"
import { filterUsers, scopeDetail, usersFacets } from "./users-filter"
import { USER_DETAIL, USER_ROWS } from "./users-fixture"

const NO_FILTERS = { search: "", hasErrors: false, hasReplay: false, namespaces: [], groups: [] }

describe("users namespace scope", () => {
	it("keeps only users seen in a picked namespace", () => {
		const rows = filterUsers(USER_ROWS, { ...NO_FILTERS, namespaces: ["payments"] }, null)
		expect(rows.map((row) => row.userId)).toEqual(["usr_4b1x9q", "usr_7d0e55", "usr_bot_sync"])
	})

	it("lets the org pin override the rail's namespace picks", () => {
		const rows = filterUsers(USER_ROWS, { ...NO_FILTERS, namespaces: ["payments"] }, "data")
		expect(rows.map((row) => row.userId)).toEqual([
			"usr_4b1x9q",
			"usr_31ab90",
			"usr_c09d77",
			"usr_a71c02",
			"usr_bot_sync",
		])
	})

	it("counts the facets over the pinned namespace's users, with no namespace facet", () => {
		const facets = usersFacets(USER_ROWS, "data")
		expect(facets.namespaces).toEqual([])
		expect(facets.groups[0]).toEqual({ name: "grp_northwind", count: 2 })
		expect(facets.withErrors).toBe(4)
		expect(facets.withReplay).toBe(3)
	})

	it("counts every namespace when nothing is pinned", () => {
		expect(usersFacets(USER_ROWS, null).namespaces[0]).toEqual({ name: "storefront", count: 6 })
	})

	it("drops a user's rows from services outside the namespace and recounts the tabs", () => {
		const scoped = scopeDetail(USER_DETAIL, "payments")
		expect(scoped.issues.map((issue) => issue.service)).toEqual(["billing"])
		expect(scoped.logs.every((log) => log.service === "billing")).toBe(true)
		expect(scoped.sessions).toEqual([])
		expect(scoped.profile.issues).toBe(1)
	})

	it("leaves the user whole when no namespace is in effect", () => {
		expect(scopeDetail(USER_DETAIL, null)).toBe(USER_DETAIL)
	})
})
