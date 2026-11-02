import { OrgId } from "@maple/domain"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { AppRoute } from "../../../route"
import type { PageContext } from "../../contract"
import { Message } from "./message"
import { hrefOfView, init, routeChanged, tabSearch, update, viewOfRoute, widerPreset } from "./update"
import { bucketLabel } from "./view"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_test"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

const window = (days: number) => ({
	startTime: "2026-08-01 00:00:00",
	endTime: new Date(Date.UTC(2026, 7, 1) + days * 86_400_000).toISOString().replace("T", " ").slice(0, 19),
})

/** Where a step navigates, or undefined when it stays put. */
const navigatedTo = (step: ReturnType<typeof update>): string | undefined =>
	step.outMessage?._tag === "RequestedNavigation" ? step.outMessage.url : undefined

const serverPage = (search: Parameters<typeof AppRoute.McpServer>[0]["search"]) =>
	init(AppRoute.McpServer({ serviceName: "maple-ai", search }), context).model

describe("widerPreset", () => {
	it("offers the first preset longer than the window shown", () => {
		expect(widerPreset(window(1))).toBe("1w")
		expect(widerPreset(window(7))).toBe("1mo")
		expect(widerPreset(window(30))).toBe("3mo")
	})

	it("never narrows a long custom range, and stops at three months", () => {
		expect(widerPreset(window(90))).toBeUndefined()
		expect(widerPreset(window(120))).toBeUndefined()
	})
})

describe("the server page keeps its filters in the URL", () => {
	it("toggles failing-only in the URL and back out", () => {
		const on = navigatedTo(update(serverPage({ client: "curl" }), Message.ToggledFailingOnly(), context))
		expect(on).toBe("/mcp-servers/maple-ai?client=curl&failing=true")
		const off = navigatedTo(update(serverPage({ failing: true }), Message.ToggledFailingOnly(), context))
		expect(off).toBe("/mcp-servers/maple-ai")
	})

	it("opens a tool with the client filter and time range, dropping the tool search", () => {
		const model = serverPage({ client: "Claude Code", q: "sql", timePreset: "1w", metric: "duration" })
		expect(navigatedTo(update(model, Message.ClickedOpenTool({ tool: "run_sql" }), context))).toBe(
			"/mcp-servers/maple-ai/tools/run_sql?timePreset=1w&client=Claude+Code",
		)
	})

	it("opens a server from the list with only the time range", () => {
		const list = init(AppRoute.McpServers({ search: { timePreset: "6h" } }), context).model
		expect(navigatedTo(update(list, Message.ClickedOpenServer({ service: "docs-mcp" }), context))).toBe(
			"/mcp-servers/docs-mcp?timePreset=6h",
		)
	})

	it("ignores a search debounce that lands after leaving the server page", () => {
		const typed = update(serverPage({}), Message.ChangedSearchInput({ value: "sql" }), context).model
		const onTool = { ...typed, view: { _tag: "Tool" as const, service: "maple-ai", tool: "run_sql" } }
		expect(
			navigatedTo(
				update(onTool, Message.ElapsedSearchDebounce({ version: typed.searchVersion }), context),
			),
		).toBeUndefined()
	})
})

describe("the sessions views", () => {
	const sessionsPage = (search: Parameters<typeof AppRoute.McpServerSessions>[0]["search"]) =>
		init(AppRoute.McpServerSessions({ serviceName: "docs-mcp", search }), context).model

	it("round-trips a session id that needs encoding", () => {
		const route = AppRoute.McpServerSession({ serviceName: "docs-mcp", sessionId: "a/b c", search: {} })
		const href = hrefOfView(viewOfRoute(route), {})
		expect(href).toBe("/mcp-servers/docs-mcp/sessions/a%2Fb%20c")
	})

	it("opens a session with only the time range", () => {
		const model = sessionsPage({ client: "Cursor", q: "7f3c", failing: true, timePreset: "1w" })
		expect(
			navigatedTo(update(model, Message.ClickedOpenSession({ sessionId: "7f3c9a2e" }), context)),
		).toBe("/mcp-servers/docs-mcp/sessions/7f3c9a2e?timePreset=1w")
	})

	it("debounces the session-id search into the URL", () => {
		const typed = update(sessionsPage({}), Message.ChangedSearchInput({ value: " 7f3c " }), context).model
		expect(
			navigatedTo(
				update(typed, Message.ElapsedSearchDebounce({ version: typed.searchVersion }), context),
			),
		).toBe("/mcp-servers/docs-mcp/sessions?q=7f3c")
	})

	it("opens the Agent Session that made a request", () => {
		const session = init(
			AppRoute.McpServerSession({ serviceName: "docs-mcp", sessionId: "7f3c", search: {} }),
			context,
		).model
		expect(
			navigatedTo(
				update(session, Message.ClickedOpenAgentSession({ sessionId: "trace:abc" }), context),
			),
		).toBe("/agent-sessions/trace%3Aabc")
	})

	it("drops a tool search still being typed when the Sessions tab opens", () => {
		const typed = update(serverPage({}), Message.ChangedSearchInput({ value: "run" }), context).model
		const onSessions = routeChanged(
			typed,
			AppRoute.McpServerSessions({ serviceName: "maple-ai", search: {} }),
			context,
		).model
		expect(onSessions.searchInput).toBe("")
		expect(
			navigatedTo(
				update(onSessions, Message.ElapsedSearchDebounce({ version: typed.searchVersion }), context),
			),
		).toBeUndefined()
	})

	it("carries the window and client selection between a server's tabs, not the search box", () => {
		const search = { timePreset: "1w", client: "Cursor", q: "run", metric: "duration" as const }
		expect(hrefOfView({ _tag: "Sessions", service: "docs-mcp" }, tabSearch(search))).toBe(
			"/mcp-servers/docs-mcp/sessions?timePreset=1w&client=Cursor",
		)
	})
})

describe("bucketLabel", () => {
	it("names the bucket widths the charts actually use", () => {
		expect(bucketLabel(900)).toBe("15m")
		expect(bucketLabel(3_600)).toBe("1h")
		expect(bucketLabel(6_300)).toBe("1h 45m")
		expect(bucketLabel(86_400)).toBe("1d")
	})
})
