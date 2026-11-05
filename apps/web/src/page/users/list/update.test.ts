import { OrgId } from "@maple/domain"
import { Array as Arr, Schema } from "effect"
import { describe, expect, it } from "vitest"
import type { PageContext, PageReturn } from "../../contract"
import { Message } from "./message"
import type { Model, Search } from "./model"
import { groupUsersHref, init, routeChanged, update } from "./update"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

const start = (search: Search): Model => init({ search }, context).model

/** The search params the page navigated to. */
const navigatedTo = (result: PageReturn<Model, Message>): URLSearchParams => {
	const out = result.outMessage
	if (out?._tag !== "RequestedNavigation") return new URLSearchParams("no-navigation=1")
	return new URL(out.url, "https://app.test").searchParams
}

describe("users directory search", () => {
	it("commits text typed within the debounce when a rail toggle navigates", () => {
		const typed = update(start({}), Message.ChangedQuery({ value: " ada " }), context).model
		const toggled = update(typed, Message.ToggledErrors(), context)
		const params = navigatedTo(toggled)
		expect(params.get("q")).toBe("ada")
		const search: Search = { q: "ada", hasErrors: true }
		expect(routeChanged(toggled.model, { search }, context).model.query).toBe(" ada ")
	})

	it("clears the search, the draft and the rail from the empty state", () => {
		const model = { ...start({ q: "zzz", hasErrors: true, groups: ["grp_acme"] }), query: "zzz" }
		const cleared = update(model, Message.ClickedClearSearchAndFilters(), context)
		const params = navigatedTo(cleared)
		expect(cleared.model.query).toBe("")
		expect(params.has("q")).toBe(false)
		expect(params.has("hasErrors")).toBe(false)
		expect(params.has("groups")).toBe(false)
		expect(params.has("no-navigation")).toBe(false)
	})

	it("keeps the search when only the rail is cleared", () => {
		const model = start({ q: "ada", hasReplay: true })
		const params = navigatedTo(update(model, Message.ClickedClearFilters(), context))
		expect(params.get("q")).toBe("ada")
		expect(params.has("hasReplay")).toBe(false)
	})
})

describe("users directory empty window", () => {
	it("widens a quiet window to the last month and drops a custom range", () => {
		const model = start({ startTime: "2026-06-24 04:00:00", endTime: "2026-06-25 04:00:00", q: "ada" })
		const params = navigatedTo(update(model, Message.ClickedWidenRange(), context))
		expect(params.get("timePreset")).toBe("1mo")
		expect(params.has("startTime")).toBe(false)
		expect(params.get("q")).toBe("ada")
	})
})

describe("users directory group view", () => {
	const window = { startTime: "2026-06-24 04:00:00", endTime: "2026-06-25 04:00:00" }
	const resolved = (search: Search) =>
		update(start(search), Message.CompletedResolveWindow({ window, nowMs: 0, mode: "Load" }), context)
	const commandNames = (result: PageReturn<Model, Message>) =>
		Arr.map(result.commands ?? [], (command) => command.name)

	it("reads the groups instead of the users while grouped, and the users otherwise", () => {
		const grouped = commandNames(resolved({ groupBy: "group" }))
		expect(grouped).toContain("FetchUserGroups")
		expect(grouped).not.toContain("FetchUsers")
		const listed = commandNames(resolved({}))
		expect(listed).toContain("FetchUsers")
		expect(listed).not.toContain("FetchUserGroups")
	})

	it("keeps the filters when switching between users and groups", () => {
		const model = start({ q: "ada", hasErrors: true })
		const grouped = navigatedTo(update(model, Message.ClickedGroupBy({ groupBy: "group" }), context))
		expect(grouped.get("groupBy")).toBe("group")
		expect(grouped.get("q")).toBe("ada")
		expect(grouped.get("hasErrors")).toBe("true")
		const back = update(start({ groupBy: "group" }), Message.ClickedGroupBy({ groupBy: null }), context)
		expect(navigatedTo(back).has("groupBy")).toBe(false)
	})

	it("links a group to the users in it, over the same filters", () => {
		const href = groupUsersHref({ groupBy: "group", hasErrors: true, timePreset: "1w" })("grp_acme")
		const params = new URL(href, "https://app.test").searchParams
		expect(params.has("groupBy")).toBe(false)
		expect(params.get("groups")).toContain("grp_acme")
		expect(params.get("hasErrors")).toBe("true")
		expect(params.get("timePreset")).toBe("1w")
	})
})
