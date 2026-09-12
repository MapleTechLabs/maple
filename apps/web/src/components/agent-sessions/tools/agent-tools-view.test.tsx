// @vitest-environment jsdom
// TEST-SEAM: the router and the plot canvas have no instance-level injection
// seam, so they are replaced at the module boundary. What is under test is the
// pages' own wiring — which control writes which search param, which row links
// where, and what the tables say about the rows they are given.

import type { ComponentProps } from "react"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
	buildToolAnalyticsFixture,
	buildToolCells,
	buildToolDetailFixture,
	buildToolErrorDetailFixture,
} from "@/lab/agent-tools-fixture"
import { sessionRowId } from "@/lib/agent-sessions/session-window"
import type { ToolErrorRow } from "@/lib/agent-sessions/tool-analytics"
import type { ToolAnalyticsSearch } from "@/lib/agent-sessions/tool-search"

import { AgentToolsView, type AgentToolsViewProps } from "./agent-tools-view"
import { ToolDetailView } from "./tool-detail-view"
import { ToolErrorModal } from "./tool-error-modal"
import { prepareToolErrors } from "./tool-errors-table"

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

// The charts render to canvas, which jsdom does not have. Their own behaviour
// is covered by `tool-analytics.test.ts` (fold, colours, title).
vi.mock("./tool-series-chart", () => ({
	ToolSeriesChart: ({ metric }: { metric: string }) => <div data-testid="chart">{metric}</div>,
}))
vi.mock("./tool-detail-charts", () => ({
	ToolDetailCharts: () => <div data-testid="detail-charts" />,
}))

const NOW = Date.UTC(2026, 8, 10, 12, 0, 0)
const cells = buildToolCells(NOW)

function renderView(
	search: ToolAnalyticsSearch,
	onSearchChange = vi.fn(),
	props: Partial<AgentToolsViewProps> = {},
) {
	const data = buildToolAnalyticsFixture(search, NOW, cells)
	render(
		<AgentToolsView
			search={search}
			onSearchChange={onSearchChange}
			data={data}
			serviceOptions={[]}
			modelOptions={[]}
			envOptions={[]}
			windowLabel="7d"
			{...props}
		/>,
	)
	return { onSearchChange, data }
}

afterEach(cleanup)

describe("AgentToolsView", () => {
	it("renders four metric tiles, the duration tile with its percentile picker always shown", () => {
		renderView({})
		expect(screen.getByText("Tool calls")).toBeTruthy()
		expect(screen.getByText("Duration")).toBeTruthy()
		for (const percentile of ["p50", "p90", "p95"]) {
			expect(screen.getByText(percentile)).toBeTruthy()
		}
		expect(screen.getByText("p90").getAttribute("aria-pressed")).toBe("true")
	})

	it("keeps the default metric out of the URL and writes the others", () => {
		const { onSearchChange } = renderView({ metric: "error_rate" })
		fireEvent.click(screen.getByText("Tool calls"))
		expect(onSearchChange).toHaveBeenCalledWith({ metric: undefined })

		cleanup()
		const second = renderView({}).onSearchChange
		// The Tools table names its error column the same way; the tile comes first.
		fireEvent.click(screen.getAllByText("Error rate")[0]!)
		expect(second).toHaveBeenCalledWith({ metric: "error_rate" })
	})

	it("takes the chart when the duration tile is picked, and re-keys on a percentile chip without it", () => {
		const { onSearchChange } = renderView({})
		fireEvent.click(screen.getByLabelText("P90 duration"))
		expect(onSearchChange).toHaveBeenCalledWith({ metric: "duration" })

		fireEvent.click(screen.getByText("p95"))
		expect(onSearchChange).toHaveBeenCalledWith({ percentile: "p95" })
	})

	it("states the Sessions tile as a share of every session in the window", () => {
		const { data } = renderView({})
		expect(data.allSessions).toBeGreaterThan(data.totals.sessions)
		expect(screen.getByText(/of all .* sessions/)).toBeTruthy()
	})

	it("carries all three percentiles in the table, whichever one the page is keyed on", () => {
		renderView({ percentile: "p95" })
		for (const column of ["P50", "P90", "P95"]) {
			expect(screen.getByText(column)).toBeTruthy()
		}
	})

	it("routes a tool row to its own page, carrying the ambient scope and nothing else", () => {
		renderView({ env: "production", q: "read", tool: "bash" })
		const row = screen.getByTitle("read_file").closest("a")
		expect(row?.getAttribute("data-to")).toBe("/agent-sessions/tools/$toolName")
		expect(row?.getAttribute("data-params")).toBe(JSON.stringify({ toolName: "read_file" }))

		const search = JSON.parse(row?.getAttribute("data-search") ?? "{}")
		expect(search.env).toBe("production")
		// `q` is a tool-NAME search: on a page that is one tool it would filter
		// that tool's own name out. `tool` is the route param there.
		expect(search.q).toBeUndefined()
		expect(search.tool).toBeUndefined()
	})

	it("reports how much of the window the selection accounts for", () => {
		renderView({ tool: "grep" })
		expect(screen.getByText(/calls match ·/)).toBeTruthy()
	})

	it("shows both scope chips in one row and removes the one that was clicked", () => {
		const { onSearchChange } = renderView({ tool: "bash", model: "claude-opus-5" })
		expect(screen.getByText("tool")).toBeTruthy()
		// `model` is also the toolbar's select label — the chip is the second.
		expect(screen.getAllByText("model").length).toBeGreaterThan(1)

		fireEvent.click(screen.getByTitle("Remove model claude-opus-5"))
		expect(onSearchChange).toHaveBeenCalledWith({ model: undefined })
	})

	it("closes the table with the window's own totals", () => {
		const { data } = renderView({})
		expect(screen.getByText(`Showing all ${data.tools.length} tools`)).toBeTruthy()
	})

	it("renders a failed Tools read as a failure, not as an empty table", () => {
		const data = buildToolAnalyticsFixture({}, NOW, cells)
		render(
			<AgentToolsView
				search={{}}
				onSearchChange={vi.fn()}
				data={{ ...data, tools: [], toolsFailure: new Error("boom") }}
				serviceOptions={[]}
				modelOptions={[]}
				envOptions={[]}
				windowLabel="7d"
			/>,
		)
		expect(screen.queryByText(/No tool calls/)).toBeNull()
		expect(screen.getByText(/Failed to load tools/)).toBeTruthy()
	})

	it("has no page title, and ends the toolbar row with the window controls", () => {
		renderView({}, vi.fn(), { actions: <button type="button">Reload</button> })
		expect(screen.queryByRole("heading", { name: "Tools" })).toBeNull()

		// After every filter and in the same row, before the scope band — where the
		// Sessions list's toolbar ends in its own Reload.
		const reload = screen.getByRole("button", { name: "Reload" })
		const search = screen.getByPlaceholderText("Tool name…")
		const failing = screen.getByRole("button", { name: /Failing only/ })
		const follows = (a: Node, b: Node) =>
			(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
		expect(follows(search, failing)).toBe(true)
		expect(follows(failing, reload)).toBe(true)
		expect(follows(reload, screen.getByText("Tool calls"))).toBe(true)
		expect(reload.closest(".ml-auto")?.parentElement?.contains(search)).toBe(true)
	})

	it("counts the tabs from what it is given, not the filtered table, and never shows an unknown count", () => {
		// A name search narrows the table; the tabs must read the same on both pages.
		renderView({ q: "read" }, vi.fn(), { tabCounts: { sessions: 812 } })
		expect(document.querySelector('[data-to="/agent-sessions"]')?.textContent).toBe("Sessions812")
		// The tools count has not landed: no number, rather than a 0.
		expect(document.querySelector('[data-to="/agent-sessions/tools"]')?.textContent).toBe("Tools")
	})
})

describe("the Tools table under a scope", () => {
	it("keeps every tool in the table while one is selected", () => {
		const scoped = buildToolAnalyticsFixture({ tool: "bash" }, NOW, cells)
		const unscoped = buildToolAnalyticsFixture({}, NOW, cells)
		expect(scoped.tools.length).toBe(unscoped.tools.length)
	})

	it("splits the series by tool, then by model, then not at all", () => {
		const keys = (search: ToolAnalyticsSearch) =>
			new Set(buildToolAnalyticsFixture(search, NOW, cells).series.map((point) => point.seriesKey))
		expect(keys({}).size).toBeGreaterThan(1)
		expect(keys({ tool: "bash" })).toEqual(
			new Set(["claude-sonnet-5", "claude-opus-5", "openai/gpt-5.6"]),
		)
		// Both picked is one series, and the tool is what names it — the same rule
		// `aiToolsSeriesKind` applies server-side.
		expect(keys({ tool: "bash", model: "claude-opus-5" })).toEqual(new Set(["bash"]))
	})
})

function renderDetail(search: ToolAnalyticsSearch, tool = "run_tests", onSearchChange = vi.fn()) {
	const data = buildToolDetailFixture(tool, search, NOW, cells)
	render(
		<ToolDetailView
			tool={tool}
			search={search}
			onSearchChange={onSearchChange}
			data={data}
			serviceOptions={[]}
			modelOptions={[]}
			envOptions={[]}
		/>,
	)
	return { onSearchChange, data }
}

describe("ToolDetailView", () => {
	it("names the tool and counts its calls and sessions", () => {
		const { data } = renderDetail({})
		expect(screen.getByRole("heading", { name: "run_tests" })).toBeTruthy()
		expect(
			screen.getAllByText(new RegExp(`${data.totals.sessions} sessions`)).length,
		).toBeGreaterThan(0)
	})

	it("describes the tool beside its name on one muted, truncated line, and says nothing without one", () => {
		const data = buildToolDetailFixture("run_tests", {}, NOW, cells)
		const view = (description: string | undefined) => (
			<ToolDetailView
				tool="run_tests"
				search={{}}
				onSearchChange={vi.fn()}
				data={{ ...data, description }}
				serviceOptions={[]}
				modelOptions={[]}
				envOptions={[]}
			/>
		)
		const text = data.description!
		const { rerender } = render(view(text))
		const line = screen.getByText(text)
		expect(line.className).toContain("truncate")
		expect(line.className).toContain("text-muted-foreground")

		rerender(view(undefined))
		expect(screen.queryByText(text)).toBeNull()
	})

	it("has no tool-name search — the page is one tool", () => {
		renderDetail({})
		expect(screen.queryByPlaceholderText("Tool name…")).toBeNull()
	})

	it("names the tool in the scope band's denominator", () => {
		renderDetail({ model: "claude-opus-5" })
		expect(screen.getByText(/of [\d,]+ run_tests calls match/)).toBeTruthy()
	})

	it("opens an error group by writing its fingerprint to the URL, clearing the last narrowing", () => {
		// A `?session=` or `?variant=` left over from a previous group would narrow
		// the new modal's samples to calls that group never made.
		const { onSearchChange, data } = renderDetail({ session: "sess_1", variant: "x" }, "submit_candidate")
		const group = data.errors.find((row) => row.message.includes("Expected array"))!
		fireEvent.click(screen.getByTitle(/^Expected array\s+at \["evidence"\]$/))
		expect(onSearchChange).toHaveBeenCalledWith({
			error: group.fingerprint,
			session: undefined,
			variant: undefined,
		})
	})

	it("hoists what every group shares into the column head, and titles rows by what differs", () => {
		renderDetail({}, "submit_candidate")
		expect(screen.getByText("all start “Invalid tool input:” · error.type tool_error")).toBeTruthy()
		// The index a group folded is a placeholder, and the row says how many texts it holds.
		expect(screen.getAllByText("[*]").length).toBeGreaterThan(0)
		expect(screen.getByText("3 variants")).toBeTruthy()
		// 281 successes since the last of 545 failures: stopped, and said so.
		expect(screen.getByText(/^No failures since/)).toBeTruthy()
		expect(screen.getByText("· 281 calls since")).toBeTruthy()
	})

	it("folds a long tail behind one line, and names a failure recorded before grouping", () => {
		const { data } = renderDetail({}, "query_data")
		expect(data.errors.length).toBe(17)
		const more = screen.getByRole("button", { name: /Show 7 more errors/ })
		expect(within(more).getByText("7 failed calls, 1 each")).toBeTruthy()
		expect(screen.queryByText("Failures recorded before error grouping")).toBeNull()
		fireEvent.click(more)
		expect(screen.getByText("Failures recorded before error grouping")).toBeTruthy()
		// Still failing, at a rate the header states.
		expect(screen.getByText(/^Last failure/)).toBeTruthy()
	})

	it("states a window with no failures as the finding it is", () => {
		renderDetail({}, "grep")
		expect(screen.getByText(/^No failed calls between/)).toBeTruthy()
		expect(screen.getByText(/^All [\d,]+ grep calls in this range succeeded\.$/)).toBeTruthy()
	})

	it("says a read is still running rather than that the tool never failed", () => {
		const data = buildToolDetailFixture("run_tests", {}, NOW, cells)
		render(
			<ToolDetailView
				tool="run_tests"
				search={{}}
				onSearchChange={vi.fn()}
				data={{ ...data, errors: [], errorsLoading: true }}
				serviceOptions={[]}
				modelOptions={[]}
				envOptions={[]}
			/>,
		)
		expect(screen.queryByText(/No failed calls/)).toBeNull()
	})

	it("renders a failed Errors read as a failure, not as an empty table", () => {
		const data = buildToolDetailFixture("run_tests", {}, NOW, cells)
		render(
			<ToolDetailView
				tool="run_tests"
				search={{}}
				onSearchChange={vi.fn()}
				data={{ ...data, errors: [], errorsFailure: new Error("boom") }}
				serviceOptions={[]}
				modelOptions={[]}
				envOptions={[]}
			/>,
		)
		expect(screen.queryByText(/No failed calls/)).toBeNull()
		expect(screen.getByText(/Failed to load run_tests errors/)).toBeTruthy()
	})

	it("sends the sessions panel's escape hatch to the list's own `tools` param", () => {
		renderDetail({})
		const link = screen.getAllByText("Open in Sessions")[0]!.closest("a")
		expect(link?.getAttribute("data-to")).toBe("/agent-sessions")
		expect(JSON.parse(link?.getAttribute("data-search") ?? "{}")).toEqual({
			tools: ["run_tests"],
		})
	})

	it("lists the sessions that ran the tool with their framework and extent", () => {
		const { data } = renderDetail({})
		expect(data.sessions.length).toBeGreaterThan(0)
		expect(screen.getByText(new RegExp(`Sessions running run_tests`))).toBeTruthy()
	})
})

describe("ToolErrorModal", () => {
	// j/k scroll the opened sample into view; jsdom lays nothing out and has no
	// `scrollIntoView` to call.
	Element.prototype.scrollIntoView = vi.fn()

	const openGroup = (tool: string, match: (row: ToolErrorRow) => boolean) => {
		const data = buildToolDetailFixture(tool, {}, NOW, cells)
		const prepared = prepareToolErrors(data.errors, data.range)
		const index = prepared.rows.findIndex(match)
		return { data, prepared, index, group: prepared.rows[index]! }
	}

	const renderModal = (
		{
			tool = "submit_candidate",
			match = (row: ToolErrorRow) => row.message.includes("traceIds"),
			...props
		}: Partial<ComponentProps<typeof ToolErrorModal>> & {
			match?: (row: ToolErrorRow) => boolean
		} = {},
	) => {
		const { data, prepared, index, group } = openGroup(tool, match)
		const built = buildToolErrorDetailFixture(tool, group, {
			session: props.session,
			variant: props.variant,
			pages: 1,
		})
		const handlers = {
			onSelectSession: vi.fn(),
			onSelectVariant: vi.fn(),
			onStep: vi.fn(),
			onClose: vi.fn(),
		}
		render(
			<ToolErrorModal
				tool={tool}
				group={group}
				position={{ index, total: prepared.rows.length }}
				detail={built.detail}
				samples={{ occurrences: built.occurrences, loading: false, paging: "end", onLoadMore: vi.fn() }}
				toolFailures={data.errors.reduce((sum, row) => sum + row.calls, 0)}
				toolCalls={data.totals.calls}
				range={data.range}
				session={undefined}
				variant={undefined}
				{...handlers}
				{...props}
			/>,
		)
		return { ...handlers, built, group, index }
	}

	it("heads the modal with the group's message, its path, and its share of the tool's failures", () => {
		renderModal()
		const heading = screen.getByRole("heading")
		expect(heading.textContent).toContain("Invalid tool input: Missing key")
		expect(heading.textContent).toContain('["evidence"][*]["traceIds"]')
		expect(screen.getByText(/^\d+% of failures$/)).toBeTruthy()
		expect(screen.getByText("error.type tool_error")).toBeTruthy()
	})

	it("lists the variants a group folded, and filters the samples by one", () => {
		const { onSelectVariant, built } = renderModal()
		expect(screen.getByText("Variants")).toBeTruthy()
		const second = built.detail.variants[1]!
		fireEvent.click(screen.getByRole("button", { name: /\[1\]/ }))
		expect(onSelectVariant).toHaveBeenCalledWith(second.message)

		cleanup()
		// One raw text: nothing to pick between, so no list.
		renderModal({ match: (row) => row.message.includes("Expected array") && row.message.includes('\\"evidence\\"]') })
		expect(screen.queryByText("Variants")).toBeNull()
	})

	it("narrows the samples to a session, and back out again", () => {
		const { onSelectSession, built } = renderModal()
		const first = built.detail.sessions[0]!
		fireEvent.click(screen.getByRole("button", { name: `Show samples in ${sessionRowId(first.sessionId)}` }))
		expect(onSelectSession).toHaveBeenCalledWith(first.sessionId)

		cleanup()
		const second = renderModal({ session: first.sessionId })
		fireEvent.click(screen.getByText("All sessions"))
		expect(second.onSelectSession).toHaveBeenCalledWith(undefined)
		// Narrowed to a session, the samples are counted against its hits.
		expect(screen.getByText(`Showing ${second.built.occurrences.length} of ${first.hits}`)).toBeTruthy()
	})

	it("links a session to its trace view without a window, and a sample to its span", () => {
		const { built } = renderModal()
		const searches = Array.from(document.querySelectorAll("a"))
			.filter((anchor) => anchor.getAttribute("data-to") === "/agent-sessions/$sessionId")
			.map((anchor) => JSON.parse(anchor.getAttribute("data-search") ?? "{}"))
		// No window: the failures' extent is not the session's, and the detail page
		// would read it as the session's.
		expect(searches).toContainEqual({ tool: "submit_candidate", view: "trace" })
		expect(searches).toContainEqual({ tool: "submit_candidate", view: "trace", span: built.occurrences[0]!.spanId })
	})

	it("opens the first sample, with the error path explained where the arguments confirm it", () => {
		renderModal()
		expect(screen.getAllByText("Arguments").length).toBe(1)
		expect(screen.getByText("What's wrong")).toBeTruthy()
		expect(screen.getByText(/has no traceIds key/)).toBeTruthy()
		expect(screen.getByText(/missing, required/)).toBeTruthy()
		expect(screen.getByText("Error message read from result.result")).toBeTruthy()
	})

	it("steps between groups with ↑/↓ and between samples with j/k", () => {
		const { onStep } = renderModal()
		fireEvent.keyDown(window, { key: "ArrowDown" })
		expect(onStep).toHaveBeenCalledWith(1)
		fireEvent.keyDown(window, { key: "ArrowUp" })
		expect(onStep).toHaveBeenCalledWith(-1)

		const samples = () => screen.getAllByRole("button", { name: /^Sample at / })
		expect(samples()[0]!.getAttribute("aria-expanded")).toBe("true")
		fireEvent.keyDown(window, { key: "j" })
		expect(samples()[0]!.getAttribute("aria-expanded")).toBe("false")
		expect(samples()[1]!.getAttribute("aria-expanded")).toBe("true")
		fireEvent.keyDown(window, { key: "k" })
		expect(samples()[0]!.getAttribute("aria-expanded")).toBe("true")
	})

	it("offers the next page of samples, and says the first is loading rather than empty", () => {
		const onLoadMore = vi.fn()
		const { built } = renderModal({ match: (row) => row.message.includes("Expected array") && row.calls > 100 })
		cleanup()
		renderModal({
			match: (row) => row.message.includes("Expected array") && row.calls > 100,
			samples: { occurrences: built.occurrences, loading: false, paging: "more", onLoadMore },
		})
		fireEvent.click(screen.getByRole("button", { name: "Load 25 more" }))
		expect(onLoadMore).toHaveBeenCalled()

		cleanup()
		renderModal({ samples: { occurrences: [], loading: true, paging: "end", onLoadMore } })
		expect(screen.queryByText(/No samples/)).toBeNull()
	})

	it("names a group recorded before error grouping for what it is", () => {
		renderModal({ tool: "query_data", match: (row) => row.fingerprint === "0" })
		expect(screen.getByRole("heading", { name: "Failures recorded before error grouping" })).toBeTruthy()
	})

	it("says plainly when a call recorded no detail", () => {
		renderModal({ tool: "sandbox_exec", match: () => true })
		expect(screen.getByText("The tool reported no error detail")).toBeTruthy()
		expect(screen.getAllByText("Not recorded").length).toBe(2)
		expect(screen.queryByText("What's wrong")).toBeNull()
	})

	it("leads to the sessions list on the list's own `tools` param", () => {
		renderModal()
		const link = screen.getByText("Open in Sessions").closest("a")
		expect(link?.getAttribute("data-to")).toBe("/agent-sessions")
		expect(JSON.parse(link?.getAttribute("data-search") ?? "{}")).toEqual({
			tools: ["submit_candidate"],
			hasErrors: true,
		})
	})

	it("closes", () => {
		const { onClose } = renderModal({ session: "sess_1" })
		fireEvent.click(screen.getByLabelText("Close"))
		expect(onClose).toHaveBeenCalled()
	})

	it("renders a failed facts read as a failure, keeping the header it came with", () => {
		renderModal({ detailFailure: new Error("boom") })
		expect(screen.getByRole("heading").textContent).toContain("Missing key")
		expect(screen.queryByText("All sessions")).toBeNull()
		expect(screen.getByText(/Failed to load this error's details/)).toBeTruthy()
	})
})
