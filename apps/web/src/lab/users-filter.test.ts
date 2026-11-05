import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { filterUsers, scopeDetail, usersFacets, usersSummary } from "./users-filter"
import { USER_DETAIL, USER_ROWS, USERS_NOW } from "./users-fixture"

const NO_FILTERS = { search: "", hasErrors: false, hasReplay: false, namespaces: [], groups: [] }

describe("users namespace scope", () => {
	it("keeps only users seen in a picked namespace", () => {
		const rows = filterUsers(USER_ROWS, { ...NO_FILTERS, namespaces: ["payments"] }, null)
		expect(Arr.map(rows, (row) => row.userId)).toEqual(["usr_4b1x9q", "usr_7d0e55", "usr_bot_sync"])
	})

	it("lets the org pin override the rail's namespace picks", () => {
		const rows = filterUsers(USER_ROWS, { ...NO_FILTERS, namespaces: ["payments"] }, "data")
		expect(Arr.map(rows, (row) => row.userId)).toEqual([
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
		expect(Arr.map(scoped.issues, (issue) => issue.service)).toEqual(["billing"])
		expect(Arr.every(scoped.logs, (log) => log.service === "billing")).toBe(true)
		expect(scoped.sessions).toEqual([])
		expect(scoped.profile.issues).toBe(1)
	})

	it("leaves the user whole when no namespace is in effect", () => {
		expect(scopeDetail(USER_DETAIL, null)).toBe(USER_DETAIL)
	})
})

describe("users summary under a pin", () => {
	const orgWide = { identified: 1_284, activeToday: 312, withErrors: 41, anonymousVisitors: 9_870 }

	it("keeps the org-wide totals unpinned and counts the pinned namespace's users when pinned", () => {
		expect(usersSummary(USER_ROWS, null, orgWide, USERS_NOW)).toBe(orgWide)
		const pinned = usersSummary(USER_ROWS, "storefront", orgWide, USERS_NOW)
		const inNamespace = Arr.filter(USER_ROWS, (row) => row.namespaces.includes("storefront"))
		expect(pinned.identified).toBe(inNamespace.length)
		expect(pinned.withErrors).toBe(Arr.filter(inNamespace, (row) => row.errors > 0).length)
	})
})
