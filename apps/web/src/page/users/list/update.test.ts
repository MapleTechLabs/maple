import { OrgId } from "@maple/domain"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import type { PageContext, PageReturn } from "../../contract"
import { Message } from "./message"
import type { Model, Search } from "./model"
import { init, routeChanged, update } from "./update"

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
