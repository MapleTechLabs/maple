// @vitest-environment jsdom
// TEST-SEAM: This focused test replaces the router with a recorder — the sidebar only navigates.

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Result } from "@/lib/effect-atom"
import type { AgentSessionsSearchState } from "./agent-sessions-filter-inputs"

const navigate = vi.fn()
let search: AgentSessionsSearchState = {}

vi.mock("@tanstack/react-router", () => ({
	getRouteApi: () => ({ useNavigate: () => navigate, useSearch: () => search }),
}))

import { AgentSessionsFilterSidebar } from "./agent-sessions-filter-sidebar"

const facets = Result.success({
	vendors: [
		{ name: "eve", count: 12 },
		{ name: "vercel_ai_sdk", count: 3 },
		{ name: "claude_agent_sdk", count: 2 },
	],
	services: [{ name: "agent-runner", count: 15 }],
	environments: [{ name: "production", count: 15 }],
	models: [{ name: "openrouter/anthropic/claude-sonnet-5", count: 9 }],
	agents: [],
	tools: [{ name: "search_traces", count: 4 }],
})

const distributions = Result.success({
	durationMs: {
		buckets: [
			{ floor: 1000, count: 3 },
			{ floor: 22627.41699796952, count: 2 },
		],
		p50: 30_000,
		p95: 30_000,
	},
	cost: {
		buckets: [
			{ floor: 2 ** -5.5, count: 1 },
			{ floor: 1, count: 1 },
		],
		p50: 0.03,
		p95: 1.234,
	},
	totalTokens: {
		buckets: [
			{ floor: 8, count: 1 },
			{ floor: 128, count: 1 },
		],
		p50: 15,
		p95: 150,
	},
	llmCalls: {
		buckets: [
			{ floor: 1, count: 2 },
			{ floor: 4, count: 1 },
		],
		p50: 1,
		p95: 4,
	},
	toolCalls: {
		buckets: [
			{ floor: 1, count: 1 },
			{ floor: 8, count: 1 },
		],
		p50: 1,
		p95: 8,
	},
})

const Sidebar = (props: {
	distributionsResult?: Parameters<typeof AgentSessionsFilterSidebar>[0]["distributionsResult"]
}) => (
	<AgentSessionsFilterSidebar
		facetsResult={facets}
		distributionsResult={props.distributionsResult ?? distributions}
	/>
)

/** What the recorded navigate call would write, given the search it started from. */
const nextSearch = (): Record<string, unknown> => {
	const call = navigate.mock.calls.at(-1)?.[0] as {
		search: (prev: AgentSessionsSearchState) => Record<string, unknown>
	}
	return call.search(search)
}

describe("AgentSessionsFilterSidebar", () => {
	beforeEach(() => {
		navigate.mockReset()
		search = {}
	})
	afterEach(cleanup)

	it("renders a section per counted dimension, hiding the ones with nothing to offer", () => {
		render(<Sidebar />)

		for (const title of ["Framework", "Service", "Environment", "Model", "Tool"]) {
			expect(screen.getByText(title)).toBeTruthy()
		}
		expect(screen.queryByText("Agent")).toBeNull()
		// Framework ids read as labels, models as their last path segment, both
		// with the session count beside them.
		expect(screen.getByText("Vercel AI SDK")).toBeTruthy()
		expect(screen.getByText("claude-sonnet-5")).toBeTruthy()
		for (const title of ["Session length", "Cost", "Tokens", "LLM calls", "Tool calls"]) {
			expect(screen.getByText(title)).toBeTruthy()
		}
		expect(screen.getByText("Hide single-trace sessions")).toBeTruthy()
	})

	it("paints services and frameworks in their colors, and explains the sections named for a concept", () => {
		search = { services: ["billing-worker"] }
		render(<AgentSessionsFilterSidebar facetsResult={facets} />)

		const swatchBeside = (label: string) =>
			screen.getByText(label).parentElement?.querySelector<HTMLElement>("span[style]")
		expect(swatchBeside("Claude Agent SDK")?.style.backgroundColor).toBe("rgb(217, 119, 87)")
		expect(swatchBeside("agent-runner")).toBeTruthy()
		// A selected service the window no longer offers keeps its swatch.
		expect(swatchBeside("billing-worker")).toBeTruthy()

		for (const title of ["Framework", "Model", "Tool", "Hide single-trace sessions"]) {
			expect(screen.getByLabelText(`About ${title}`)).toBeTruthy()
		}
		expect(screen.queryByLabelText("About Service")).toBeNull()
	})

	it("accumulates a second framework rather than replacing the first", () => {
		search = { vendors: ["eve"] }
		render(<Sidebar />)

		fireEvent.click(screen.getByText("Vercel AI SDK"))
		expect(nextSearch().vendors).toEqual(["eve", "vercel_ai_sdk"])
	})

	it("keeps a selected value that the window no longer offers", () => {
		search = { tools: ["send_email"] }
		render(<Sidebar />)

		expect(screen.getByText("send_email")).toBeTruthy()
	})

	it("writes a percentile preset as the range it names, and clears it on a second click", () => {
		render(<Sidebar />)

		// p95 of $1.234, rounded to two significant figures.
		fireEvent.click(screen.getByRole("button", { name: /^> p95\s?\$1\.20$/ }))
		expect(nextSearch()).toMatchObject({ costMin: 1.2, costMax: undefined })

		search = { costMin: 1.2 }
		cleanup()
		render(<Sidebar />)
		fireEvent.click(screen.getByRole("button", { name: /^> p95\s?\$1\.20$/ }))
		expect(nextSearch()).toMatchObject({
			costMin: undefined,
			costMax: undefined,
		})
	})

	it("draws a histogram per range once the distributions land, and only the intents before", () => {
		render(<Sidebar distributionsResult={Result.initial()} />)
		expect(screen.queryByRole("img")).toBeNull()
		expect(screen.getByRole("button", { name: /^No tools\s?0$/ })).toBeTruthy()
		expect(screen.queryByRole("button", { name: /p50/ })).toBeNull()

		cleanup()
		render(<Sidebar />)
		// Durations arrive in ms and are drawn in the URL's seconds.
		expect(screen.getByRole("img", { name: /^Session length distribution .* from 1s to / })).toBeTruthy()
		expect(screen.getByRole("button", { name: /^> p50\s?30s$/ })).toBeTruthy()
		for (const title of ["Cost", "Tokens", "LLM calls", "Tool calls"]) {
			expect(screen.getByRole("img", { name: new RegExp(`^${title} distribution`) })).toBeTruthy()
		}
	})

	it("selects whole counts off a count histogram, its top bucket's last member inclusive", () => {
		// jsdom lays nothing out and has no pointer capture; give the bars a width.
		const rect = vi
			.spyOn(HTMLElement.prototype, "getBoundingClientRect")
			.mockReturnValue({ left: 0, width: 100 } as DOMRect)
		HTMLElement.prototype.setPointerCapture = vi.fn()
		render(<Sidebar />)

		// Buckets [1,2) [2,4) [4,8) [8,16): a drag from the first bar to the third.
		const bars = screen.getByRole("img", {
			name: /^Tool calls distribution across 4 buckets, from 1 to 15$/,
		})
		fireEvent.pointerDown(bars, { clientX: 10, pointerId: 1 })
		fireEvent.pointerUp(bars, { clientX: 60, pointerId: 1 })
		expect(nextSearch()).toMatchObject({ toolCallsMin: 1, toolCallsMax: 7 })
		rect.mockRestore()
	})

	it("clears every filter but leaves the window and the sort alone", () => {
		search = {
			vendors: ["eve"],
			q: "wrun",
			hasErrors: true,
			grouped: true,
			tokensMin: 100,
			sortBy: "cost",
			sortDir: "desc",
		}
		render(<Sidebar />)

		fireEvent.click(screen.getByRole("button", { name: /clear all/i }))
		const next = nextSearch()
		expect(next).toMatchObject({
			vendors: undefined,
			q: undefined,
			hasErrors: undefined,
			grouped: undefined,
			tokensMin: undefined,
			sortBy: "cost",
			sortDir: "desc",
		})
	})

	it("toggles the single-trace filter on and writes nothing when it is off", () => {
		render(<Sidebar />)

		fireEvent.click(screen.getByLabelText("Hide single-trace sessions"))
		expect(nextSearch().grouped).toBe(true)
	})
})
