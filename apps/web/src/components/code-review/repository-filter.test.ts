import { describe, expect, it } from "vitest"
import { visibleRepositories } from "./repository-filter"

const repo = (fullName: string, prReviewEnabled = false) => ({ id: fullName, fullName, prReviewEnabled })
const names = (rows: ReadonlyArray<{ fullName: string }>) => rows.map((row) => row.fullName)

const MANY = [
	repo("acme/web", true),
	repo("acme/api"),
	repo("acme/worker-proxy"),
	repo("acme/Worker-Proxy-Go", true),
	repo("acme/docs"),
	repo("acme/infra"),
	repo("acme/sdk-js"),
	repo("acme/sdk-go"),
	repo("acme/billing"),
]
const NONE = new Set<string>()

describe("visibleRepositories", () => {
	it("matches the search anywhere in the name, ignoring case and surrounding space", () => {
		const rows = visibleRepositories(MANY, { search: "  PROXY ", filter: "all", pinned: NONE })
		expect(names(rows)).toEqual(["acme/worker-proxy", "acme/Worker-Proxy-Go"])
	})

	it("narrows to reviewed or not reviewed repositories", () => {
		expect(names(visibleRepositories(MANY, { search: "", filter: "reviewed", pinned: NONE }))).toEqual([
			"acme/web",
			"acme/Worker-Proxy-Go",
		])
		expect(visibleRepositories(MANY, { search: "", filter: "off", pinned: NONE })).toHaveLength(7)
	})

	it("puts pinned repositories first, each group by name", () => {
		const rows = visibleRepositories(MANY, { search: "", filter: "all", pinned: new Set(["acme/web"]) })
		expect(names(rows).slice(0, 3)).toEqual(["acme/web", "acme/api", "acme/billing"])
	})

	it("orders by the pinned set, not the live review state, so toggling never moves a row", () => {
		const toggledOn = MANY.map((r) => (r.fullName === "acme/api" ? { ...r, prReviewEnabled: true } : r))
		const rows = visibleRepositories(toggledOn, { search: "", filter: "all", pinned: NONE })
		expect(names(rows)[0]).toBe("acme/api")
		expect(names(rows)[1]).toBe("acme/billing")
	})

	it("orders numbered names by number, not character by character", () => {
		const numbered = [10, 2, 1, 11, 3].map((n) => repo(`acme/pipeline-${n}`))
		const rows = visibleRepositories([...numbered, ...MANY], {
			search: "pipeline",
			filter: "all",
			pinned: NONE,
		})
		expect(names(rows)).toEqual([1, 2, 3, 10, 11].map((n) => `acme/pipeline-${n}`))
	})

	it("ignores a stale search and filter once the list is short enough to hide the toolbar", () => {
		const few = MANY.slice(0, 8)
		const rows = visibleRepositories(few, { search: "proxy", filter: "reviewed", pinned: NONE })
		expect(rows).toHaveLength(8)
	})
})
