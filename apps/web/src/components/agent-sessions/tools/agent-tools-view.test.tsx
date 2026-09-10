// @vitest-environment jsdom
// TEST-SEAM: the router, the model-detection atom and the plot canvas have no
// instance-level injection seam, so they are replaced at the module boundary.
// What is under test is the page's own wiring — which control writes which
// search param, and which table ignores which half of the scope.

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { buildToolAnalyticsFixture, buildToolCells } from "@/lab/agent-tools-fixture"
import type { ToolAnalyticsSearch } from "@/lib/agent-sessions/tool-search"

import { AgentToolsView } from "./agent-tools-view"

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
		<a {...(props as Record<string, string>)}>{children}</a>
	),
}))

vi.mock("@/hooks/use-detected-models", () => ({
	useDetectedModels: () => (model: string) => ({
		model,
		displayName: model,
		vendorSlug: null,
		vendorName: null,
		family: null,
	}),
}))

// The chart renders to canvas, which jsdom does not have. Its own behaviour is
// covered by `tool-analytics.test.ts` (fold, colours, title).
vi.mock("./tool-series-chart", () => ({
	ToolSeriesChart: ({ metric }: { metric: string }) => <div data-testid="chart">{metric}</div>,
}))

const NOW = Date.UTC(2026, 8, 10, 12, 0, 0)
const cells = buildToolCells(NOW)

function renderView(search: ToolAnalyticsSearch, onSearchChange = vi.fn()) {
	const data = buildToolAnalyticsFixture(search, NOW, cells)
	render(
		<AgentToolsView
			search={search}
			onSearchChange={onSearchChange}
			data={data}
			serviceOptions={[]}
			envOptions={[]}
			windowLabel="7d"
		/>,
	)
	return { onSearchChange, data }
}

afterEach(cleanup)

describe("AgentToolsView", () => {
	it("renders four metric tiles, and the duration tile's three percentiles once it is picked", () => {
		renderView({})
		expect(screen.getByText("Tool calls")).toBeTruthy()
		expect(screen.getByText("Duration")).toBeTruthy()
		expect(screen.queryByText("p50")).toBeNull()

		cleanup()
		renderView({ metric: "duration" })
		for (const percentile of ["p50", "p90", "p95"]) {
			expect(screen.getByText(percentile)).toBeTruthy()
		}
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

	it("takes the chart when the duration tile is picked, then re-keys on a percentile column", () => {
		const { onSearchChange } = renderView({})
		fireEvent.click(screen.getByText("Duration"))
		expect(onSearchChange).toHaveBeenCalledWith({ metric: "duration" })

		cleanup()
		const second = renderView({ metric: "duration" }).onSearchChange
		fireEvent.click(screen.getByText("p95"))
		expect(second).toHaveBeenCalledWith({ percentile: "p95" })
	})

	it("names the selected percentile in both breakdown columns", () => {
		renderView({ percentile: "p95" })
		expect(screen.getAllByText("P95").length).toBe(2)
	})

	it("sets the tool from a Tools row and clears it when the same row is picked again", () => {
		const { onSearchChange } = renderView({})
		fireEvent.click(screen.getByTitle("read_file"))
		expect(onSearchChange).toHaveBeenCalledWith({ tool: "read_file" })

		cleanup()
		const second = renderView({ tool: "read_file" }).onSearchChange
		fireEvent.click(screen.getByTitle("read_file"))
		expect(second).toHaveBeenCalledWith({ tool: undefined })
	})

	it("shows both scope chips in one row and removes the one that was clicked", () => {
		const { onSearchChange } = renderView({
			tool: "bash",
			model: "claude-opus-5",
		})
		expect(screen.getByText("tool")).toBeTruthy()
		expect(screen.getByText("model")).toBeTruthy()

		fireEvent.click(screen.getByTitle("Remove model claude-opus-5"))
		expect(onSearchChange).toHaveBeenCalledWith({ model: undefined })
	})

	it("reports how much of the window the selection accounts for", () => {
		renderView({ tool: "grep" })
		expect(screen.getByText(/calls match ·/)).toBeTruthy()
	})
})

describe("the breakdown tables under a scope", () => {
	it("keeps every tool in the Tools table while one is selected", () => {
		const scoped = buildToolAnalyticsFixture({ tool: "bash" }, NOW, cells)
		const unscoped = buildToolAnalyticsFixture({}, NOW, cells)
		expect(scoped.tools.length).toBe(unscoped.tools.length)
	})

	it("narrows the Models panel to the models that run the selected tool", () => {
		const scoped = buildToolAnalyticsFixture({ tool: "grep" }, NOW, cells)
		expect(scoped.models.map((row) => row.key)).toEqual(["claude-sonnet-5"])
	})

	it("keeps every model in the Models panel while one is selected", () => {
		const scoped = buildToolAnalyticsFixture({ model: "gemini-3-pro" }, NOW, cells)
		expect(scoped.models.length).toBeGreaterThan(1)
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
