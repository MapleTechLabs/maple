// @vitest-environment jsdom
// TEST-SEAM: the router has no instance-level injection seam, so `Link` is
// replaced at the module boundary. What is under test is the page's own wiring
// — which control writes which search param, which row links where, and what
// the sections say about the data they are given.

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { buildOverviewFixture } from "@/lab/agent-overview-fixture"
import { buildAgentOverviewData } from "@/lib/agent-sessions/overview-analytics"
import {
	compareEnabled,
	type AgentOverviewSearch,
} from "@/lib/agent-sessions/overview-search"

import { AgentOverviewView } from "./agent-overview-view"

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		children,
		to,
		params,
		search,
		...props
	}: React.PropsWithChildren<Record<string, unknown>>) => (
		<a
			data-to={typeof to === "string" ? to : undefined}
			data-params={params === undefined ? undefined : JSON.stringify(params)}
			data-search={search === undefined ? undefined : JSON.stringify(search)}
			{...(props as Record<string, string>)}
		>
			{children}
		</a>
	),
}))

const NOW = Date.UTC(2026, 8, 10, 12, 0, 0)

function renderView(search: AgentOverviewSearch = {}, scenario: "healthy7d" | "regression24h" = "regression24h") {
	const fixture = buildOverviewFixture(scenario, NOW)
	const data = buildAgentOverviewData({ ...fixture.input, compare: compareEnabled(search) })
	const onSearchChange = vi.fn()
	render(
		<AgentOverviewView
			search={search}
			onSearchChange={onSearchChange}
			data={data}
			facets={fixture.facets}
			topSessions={fixture.topSessions}
			windowLabel={fixture.windowLabel}
		/>,
	)
	return { onSearchChange, data, fixture }
}

/** The section a heading owns — the page repeats labels across sections. */
const sectionOf = (heading: string) =>
	screen.getByRole("heading", { name: heading }).closest("section")!

afterEach(cleanup)

describe("AgentOverviewView", () => {
	it("renders the seven KPI tiles and the nine small multiples", () => {
		const { data } = renderView()
		for (const tile of data.tiles) {
			expect(screen.getAllByText(tile.label).length).toBeGreaterThan(0)
		}
		expect(document.querySelectorAll("[data-chart]")).toHaveLength(9)
	})

	it("draws the previous-period ghost only while the comparison is on", () => {
		renderView({})
		expect(screen.getAllByText(/ghost/).length).toBeGreaterThan(0)
		cleanup()
		renderView({ compare: false })
		expect(screen.queryByText(/ghost/)).toBeNull()
	})

	it("turns the comparison off through the URL rather than through local state", () => {
		const { onSearchChange } = renderView({})
		fireEvent.click(screen.getByRole("button", { name: /compare prev/ }))
		expect(onSearchChange).toHaveBeenCalledWith({ compare: false })
	})

	it("writes the failing-only toggle to the URL", () => {
		const { onSearchChange } = renderView({})
		fireEvent.click(screen.getByRole("button", { name: "Failing only" }))
		expect(onSearchChange).toHaveBeenCalledWith({ hasErrors: true })
	})

	it("shows one chip per active filter and clears them all at once", () => {
		const { onSearchChange } = renderView({ model: "claude-opus-5", environment: "production" })
		expect(screen.getAllByText("claude-opus-5").length).toBeGreaterThan(0)
		fireEvent.click(screen.getByRole("button", { name: "Clear all" }))
		expect(onSearchChange).toHaveBeenCalledWith({
			model: undefined,
			agent: undefined,
			service: undefined,
			framework: undefined,
			environment: undefined,
			tool: undefined,
		})
	})

	it("removes one chip without touching the others", () => {
		const { onSearchChange } = renderView({ model: "claude-opus-5" })
		fireEvent.click(screen.getByRole("button", { name: /Remove model filter/ }))
		expect(onSearchChange).toHaveBeenCalledWith({ model: undefined })
	})

	it("filters the whole page from a breakdown row", () => {
		const { onSearchChange, data } = renderView({})
		const row = data.breakdowns.find((b) => b.dimension === "model")?.rows[0]
		expect(row).toBeDefined()
		fireEvent.click(within(sectionOf("Breakdowns")).getAllByText(row!.label)[0])
		expect(onSearchChange).toHaveBeenCalledWith({ model: row!.key })
	})

	it("switches the breakdown table without touching the URL", () => {
		const { onSearchChange } = renderView({})
		fireEvent.click(
			within(sectionOf("Breakdowns")).getByRole("button", { name: /^tool/ }),
		)
		expect(screen.getByText("Share of calls")).toBeTruthy()
		expect(onSearchChange).not.toHaveBeenCalled()
	})

	it("filters the page from a mover line", () => {
		const { onSearchChange, data } = renderView({})
		const mover = data.movers.find((candidate) => candidate.key !== "")
		expect(mover).toBeDefined()
		const rail = screen.getByRole("heading", { name: "What changed" }).closest("aside")!
		fireEvent.click(within(rail).getAllByText(mover!.label)[0])
		expect(onSearchChange).toHaveBeenCalledWith({ [mover!.dimension]: mover!.key })
	})

	it("links each top session to its own detail page, with the session's bounds", () => {
		const { fixture } = renderView({})
		const first = fixture.topSessions.cost[0]
		const link = screen.getByText(first.sessionId).closest("a")
		expect(link?.getAttribute("data-to")).toBe("/agent-sessions/$sessionId")
		expect(link?.getAttribute("data-params")).toBe(JSON.stringify({ sessionId: first.sessionId }))
		expect(link?.getAttribute("data-search")).toContain("\"t\"")
	})

	it("carries the board's filters into the Sessions list", () => {
		renderView({ model: "claude-opus-5", hasErrors: true })
		const link = screen.getByText(/Open in Sessions/).closest("a")
		expect(JSON.parse(link?.getAttribute("data-search") ?? "{}")).toMatchObject({
			models: ["claude-opus-5"],
			hasErrors: true,
		})
	})

	it("switches the top-sessions tab without touching the URL", () => {
		const { onSearchChange } = renderView({})
		fireEvent.click(screen.getByRole("button", { name: /longest/ }))
		expect(onSearchChange).not.toHaveBeenCalled()
	})

	it("keeps the chips up and shows the empty block when the scope matches nothing", () => {
		const fixture = buildOverviewFixture("healthy7d", NOW)
		const data = buildAgentOverviewData({
			...fixture.input,
			current: { ...fixture.input.current, sessions: 0 },
			series: [],
			compare: true,
		})
		render(
			<AgentOverviewView
				search={{ model: "claude-opus-5" }}
				onSearchChange={vi.fn()}
				data={data}
				facets={fixture.facets}
				topSessions={fixture.topSessions}
				windowLabel="7d"
			/>,
		)
		expect(screen.getByText("No agent sessions in this range")).toBeTruthy()
		expect(screen.getAllByText("claude-opus-5").length).toBeGreaterThan(0)
		expect(screen.queryByText("Top sessions")).toBeNull()
	})

	it("names the two tabs the page can be read under", () => {
		renderView({})
		const nav = screen.getByRole("navigation", { name: "Agent sessions views" })
		expect(within(nav).getByText("Overview")).toBeTruthy()
		expect(within(nav).getByText("Sessions")).toBeTruthy()
	})
})
