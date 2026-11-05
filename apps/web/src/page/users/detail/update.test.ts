import { Array as Arr, Option, Schema } from "effect"
import { fromString } from "foldkit/url"
import { describe, expect, it } from "vitest"
import { OrgId } from "@maple/domain/http"
import { AppRoute, urlToAppRoute } from "../../../route"
import type { PageContext } from "../../contract"
import { detailInputs } from "./command"
import { activityHref } from "./data-map"
import { Message } from "./message"
import { init, routeChanged, tabOf, update, userDetailHref } from "./update"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_test"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const pinned: PageContext = { ...context, pinnedNamespace: "storefront" }

const parse = (path: string) => urlToAppRoute(Option.getOrThrow(fromString(`http://maple.test${path}`)))

const window = { startTime: "2026-11-01 00:00:00", endTime: "2026-11-02 00:00:00" }

/** Where a step navigates, or undefined when it stays put. */
const navigatedTo = (step: ReturnType<typeof update>): string | undefined =>
	step.outMessage?._tag === "RequestedNavigation" ? step.outMessage.url : undefined

const page = (search: Parameters<typeof AppRoute.UserDetail>[0]["search"], ctx = context) =>
	init({ userId: "user/42 ada", search }, ctx).model

describe("the user page URL", () => {
	it("round-trips an id that needs encoding, the tab and the namespace", () => {
		const href = userDetailHref("user/42 ada", { tab: "mcp", namespace: "storefront" })
		expect(href).toBe("/users/user%2F42%20ada?tab=mcp&namespace=storefront")
		expect(parse(href)).toEqual(
			AppRoute.UserDetail({ userId: "user/42 ada", search: { tab: "mcp", namespace: "storefront" } }),
		)
	})

	it("leaves the default Activity tab out of the URL", () => {
		expect(userDetailHref("u1", { tab: "activity" })).toBe("/users/u1")
		expect(tabOf({})).toBe("activity")
	})

	it("is not the directory's route", () => {
		expect(parse("/users")._tag).toBe("Users")
	})
})

describe("tabs and namespaces", () => {
	it("puts a clicked tab in the URL, keeping the window and namespace", () => {
		const model = page({ timePreset: "24h", namespace: "storefront" })
		expect(navigatedTo(update(model, Message.ClickedTab({ tab: "sessions" }), context))).toBe(
			"/users/user%2F42%20ada?tab=sessions&namespace=storefront&timePreset=24h",
		)
	})

	it("puts a picked namespace in the URL, and drops it to show every namespace", () => {
		const model = page({ tab: "events" })
		expect(navigatedTo(update(model, Message.ClickedNamespace({ namespace: "checkout" }), context))).toBe(
			"/users/user%2F42%20ada?tab=events&namespace=checkout",
		)
		const scoped = page({ namespace: "checkout" })
		expect(navigatedTo(update(scoped, Message.ClickedNamespace({ namespace: null }), context))).toBe(
			"/users/user%2F42%20ada",
		)
	})

	it("ignores a namespace pick while the org pin is on", () => {
		const model = page({}, pinned)
		expect(
			update(model, Message.ClickedNamespace({ namespace: "checkout" }), pinned).outMessage,
		).toBeUndefined()
	})

	it("scopes both reads to the org pin over the page's pick", () => {
		expect(detailInputs("u1", { namespace: "checkout" }, window, null).namespaces).toEqual(["checkout"])
		expect(detailInputs("u1", { namespace: "checkout" }, window, "storefront").namespaces).toEqual([
			"storefront",
		])
		expect(detailInputs("u1", {}, window, null).namespaces).toEqual([])
	})

	it("starts no read when only the tab changes", () => {
		const loaded = update(
			page({}),
			Message.CompletedResolveWindow({ window, nowMs: 0, mode: "Load" }),
			context,
		).model
		const step = routeChanged(loaded, { userId: "user/42 ada", search: { tab: "mcp" } }, context)
		expect(step.model.search.tab).toBe("mcp")
		expect(step.commands ?? []).toEqual([])
	})

	it("reads the user's requests only once the Traces tab opens, and logs only on Logs", () => {
		const loaded = update(
			page({}),
			Message.CompletedResolveWindow({ window, nowMs: 0, mode: "Load" }),
			context,
		)
		const names = (step: ReturnType<typeof update>) =>
			Arr.map(step.commands ?? [], (command) => command.name)
		expect(names(loaded)).not.toContain("FetchUserTraces")
		const traces = routeChanged(
			loaded.model,
			{ userId: "user/42 ada", search: { tab: "traces" } },
			context,
		)
		expect(names(traces)).toEqual(["FetchUserTraces"])
		const logs = routeChanged(traces.model, { userId: "user/42 ada", search: { tab: "logs" } }, context)
		expect(names(logs)).toEqual(["FetchUserLogs"])
		const back = routeChanged(logs.model, { userId: "user/42 ada", search: { tab: "traces" } }, context)
		expect(names(back)).toEqual([])
	})

	it("refetches when the namespace changes", () => {
		const loaded = update(
			page({}),
			Message.CompletedResolveWindow({ window, nowMs: 0, mode: "Load" }),
			context,
		).model
		const step = routeChanged(
			loaded,
			{ userId: "user/42 ada", search: { namespace: "checkout" } },
			context,
		)
		const names = Arr.map(step.commands ?? [], (command) => command.name)
		expect(names).toContain("FetchUserProfile")
		expect(names).toContain("FetchUserActivity")
	})
})

describe("activity links", () => {
	const item = {
		atMs: 0,
		service: "docs-mcp",
		title: "",
		detail: "",
		tone: "neutral" as const,
		traceId: null,
	}

	it("opens an MCP session on its own server's page over the user page's window", () => {
		expect(activityHref({ ...item, kind: "mcp", sessionId: "user:1:Q2w:dQ" }, { timePreset: "1w" })).toBe(
			"/mcp-servers/docs-mcp/sessions/user%3A1%3AQ2w%3AdQ?timePreset=1w",
		)
	})

	it("opens a replay session, and nothing for an event", () => {
		expect(activityHref({ ...item, kind: "session", sessionId: "s1" }, {})).toBe("/replays/s1")
		expect(activityHref({ ...item, kind: "event", sessionId: null }, {})).toBeNull()
	})

	it("opens the trace of a failed request or a log line", () => {
		expect(activityHref({ ...item, kind: "request", sessionId: null, traceId: "a1b2" }, {})).toBe(
			"/traces/a1b2",
		)
		expect(activityHref({ ...item, kind: "log", sessionId: null, traceId: "c3d4" }, {})).toBe(
			"/traces/c3d4",
		)
	})
})
