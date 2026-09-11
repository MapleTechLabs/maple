// @vitest-environment jsdom
// TEST-SEAM: the router and the plot canvas have no instance-level injection
// seam, so they are replaced at the module boundary. What is under test is the
// pages' own wiring — which control writes which search param, which row links
// where, and what the tables say about the rows they are given.

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
	buildToolAnalyticsFixture,
	buildToolCells,
	buildToolDetailFixture,
	buildToolErrorDetailFixture,
	toolFixtureWindow,
} from "@/lab/agent-tools-fixture"
import type { ToolAnalyticsSearch } from "@/lib/agent-sessions/tool-search"

import { AgentToolsView } from "./agent-tools-view"
import { ToolDetailView } from "./tool-detail-view"
import { ToolErrorModal } from "./tool-error-modal"

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
const WINDOW = toolFixtureWindow(NOW)

function renderView(search: ToolAnalyticsSearch, onSearchChange = vi.fn()) {
	const data = buildToolAnalyticsFixture(search, NOW, cells)
	render(
		<AgentToolsView
			search={search}
			onSearchChange={onSearchChange}
			data={data}
			window={WINDOW}
			serviceOptions={[]}
			modelOptions={[]}
			envOptions={[]}
			windowLabel="7d"
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
				window={WINDOW}
				serviceOptions={[]}
				modelOptions={[]}
				envOptions={[]}
				windowLabel="7d"
			/>,
		)
		expect(screen.queryByText(/No tool calls/)).toBeNull()
		expect(screen.getByText(/Failed to load tools/)).toBeTruthy()
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

function renderDetail(search: ToolAnalyticsSearch, onSearchChange = vi.fn()) {
	const data = buildToolDetailFixture("run_tests", search, NOW, cells)
	render(
		<ToolDetailView
			tool="run_tests"
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

	it("names the tool in the scope band's denominator", () => {
		renderDetail({ model: "claude-opus-5" })
		expect(screen.getByText(/run_tests calls/)).toBeTruthy()
	})

	it("opens an error row by writing its type to the URL, clearing the last session", () => {
		// A `?session=` left over from a previous error would narrow the new
		// modal's occurrences to a session that error never happened in.
		const { onSearchChange } = renderDetail({ session: "sess_1" })
		fireEvent.click(screen.getByTitle("TimeoutError"))
		expect(onSearchChange).toHaveBeenCalledWith({
			error: "TimeoutError",
			session: undefined,
		})
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
		expect(screen.queryByText(/No failed run_tests calls/)).toBeNull()
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
		expect(screen.queryByText(/No failed run_tests calls/)).toBeNull()
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

	it("draws a failure that named no type as unknown, without routing on it", () => {
		renderDetail({})
		expect(screen.getByTitle("unknown")).toBeTruthy()
		expect(screen.getByText(/span failed without an error.type/)).toBeTruthy()
	})

	it("lists the sessions that ran the tool with their framework and extent", () => {
		const { data } = renderDetail({})
		expect(data.sessions.length).toBeGreaterThan(0)
		expect(screen.getByText(new RegExp(`Sessions running run_tests`))).toBeTruthy()
	})
})

describe("ToolErrorModal", () => {
	const errors = buildToolDetailFixture("run_tests", {}, NOW, cells).errors
	const row = errors.find((candidate) => candidate.errorType === "TimeoutError")!
	const detail = buildToolErrorDetailFixture("run_tests", "TimeoutError", errors, NOW)

	const renderModal = (session?: string, onSelectSession = vi.fn(), failure?: unknown) => {
		const onClose = vi.fn()
		render(
			<ToolErrorModal
				tool="run_tests"
				error={row}
				data={failure === undefined ? detail : { sessions: [], occurrences: [] }}
				failure={failure}
				toolFailures={errors.reduce((sum, candidate) => sum + candidate.calls, 0)}
				session={session}
				onSelectSession={onSelectSession}
				onClose={onClose}
			/>,
		)
		return { onSelectSession, onClose }
	}

	it("states the error's share of the tool's failures", () => {
		renderModal()
		expect(screen.getByRole("heading", { name: "TimeoutError" })).toBeTruthy()
		expect(screen.getByText(/% of run_tests failures/)).toBeTruthy()
	})

	it("narrows the occurrences to a session, and back out again", () => {
		const { onSelectSession } = renderModal()
		fireEvent.click(
			screen.getByRole("button", { name: `Show occurrences in ${detail.sessions[0]!.sessionId}` }),
		)
		expect(onSelectSession).toHaveBeenCalledWith(detail.sessions[0]!.sessionId)

		cleanup()
		const second = renderModal(detail.sessions[0]!.sessionId).onSelectSession
		fireEvent.click(screen.getByText("All sessions"))
		expect(second).toHaveBeenCalledWith(undefined)
	})

	it("names each session as the Sessions list does, and links to it on the trace view", () => {
		renderModal()
		const named = detail.sessions.find((candidate) => candidate.agentName === "planner")!
		const link = screen
			.getAllByText("planner")
			.map((element) => element.closest("a"))
			.find((anchor) => JSON.parse(anchor?.getAttribute("data-search") ?? "{}").span === undefined)
		expect(link?.getAttribute("data-to")).toBe("/agent-sessions/$sessionId")
		expect(JSON.parse(link?.getAttribute("data-params") ?? "{}")).toEqual({ sessionId: named.sessionId })
		// No window: the failures' extent is not the session's, and the detail page
		// would read it as the session's.
		expect(JSON.parse(link?.getAttribute("data-search") ?? "{}")).toEqual({
			tool: "run_tests",
			view: "trace",
		})
		// A session with no agent name is headed by its framework, not left blank
		// and never titled by its raw id.
		expect(screen.queryAllByText(/ session$/).length).toBeGreaterThan(0)
	})

	it("links an occurrence to its span inside the session", () => {
		renderModal()
		const first = detail.occurrences[0]!
		// The mocked `Link` renders no `href`, so its anchors carry no link role.
		const spans = Array.from(document.querySelectorAll("a"))
			.map((anchor) => JSON.parse(anchor.getAttribute("data-search") ?? "{}"))
			.filter((search) => search.span !== undefined)
		expect(spans[0]).toMatchObject({ span: first.spanId, tool: "run_tests", view: "trace" })
	})

	it("totals a session's occurrences by that session's hits, not the error's", () => {
		const selected = detail.sessions[0]!
		renderModal(selected.sessionId)
		expect(screen.getByText(`Showing ${detail.occurrences.length} of ${selected.hits}`)).toBeTruthy()
		expect(screen.queryByText(`Showing ${detail.occurrences.length} of ${row.calls}`)).toBeNull()
	})

	it("says the occurrences are loading rather than that there are none", () => {
		render(
			<ToolErrorModal
				tool="run_tests"
				error={row}
				data={{ sessions: [], occurrences: [] }}
				toolFailures={row.calls}
				session={undefined}
				onSelectSession={vi.fn()}
				onClose={vi.fn()}
				loading
			/>,
		)
		expect(screen.queryByText(/No occurrences/)).toBeNull()
	})

	it("opens with exactly the first occurrence expanded", () => {
		renderModal()
		// The rows arrive after the modal mounts, so the default open set is
		// derived from them rather than seeded once at mount.
		expect(screen.getAllByText("Arguments").length).toBe(1)
		expect(screen.getAllByText(/gen_ai.tool.call.result/).length).toBe(1)
	})

	it("leads to the sessions list on the list's own `tools` param", () => {
		renderModal()
		const link = screen.getByText("Open in Sessions").closest("a")
		expect(link?.getAttribute("data-to")).toBe("/agent-sessions")
		expect(JSON.parse(link?.getAttribute("data-search") ?? "{}")).toEqual({
			tools: ["run_tests"],
			hasErrors: true,
		})
	})

	it("closes to a URL with neither the error nor the session on it", () => {
		const { onClose } = renderModal("sess_1")
		fireEvent.click(screen.getByLabelText("Close"))
		expect(onClose).toHaveBeenCalled()
	})

	it("renders a failed occurrences read as a failure, not as an empty modal", () => {
		renderModal(undefined, vi.fn(), new Error("boom"))
		// The header still stands: it came from the row the reader clicked.
		expect(screen.getByRole("heading", { name: "TimeoutError" })).toBeTruthy()
		expect(screen.queryByText("All sessions")).toBeNull()
		expect(screen.getByText(/Failed to load TimeoutError occurrences/)).toBeTruthy()
	})
})
