import { describe, expect, test } from "vitest"
import * as Select from "@maple/views/ui/select"
import * as ToggleGroup from "@maple/views/ui/toggle-group"
import { filteredOverview, filteredTool } from "./mcp-filter"
import { filtersOf, init, Message, update } from "./mcp-lab"
import { Array as Arr } from "effect"

const opened = () => init({ view: "server" }).model

const pickClient = (client: string) =>
	update(
		opened(),
		Message.GotSelectMessage({
			facet: "client",
			message: Select.Message.SelectedItem({ index: 1, value: client }),
		}),
	).model

const pressPercentile = (value: string, index: number) =>
	Message.GotPercentileMessage({ message: ToggleGroup.Message.ClickedItem({ value, index }) })

describe("mcp lab", () => {
	test("a client facet change narrows the totals, tools and series to that client's calls", () => {
		const overview = filteredOverview(filtersOf(pickClient("Claude Code")))
		const seriesCalls = Arr.reduce(overview.series, 0, (sum, point) => sum + point.calls)
		expect([overview.totals.calls, overview.totals.errors, overview.tools.length, seriesCalls]).toEqual([
			15, 1, 4, 15,
		])
	})

	test("a client facet change narrows run_sql to that client's calls and failures", () => {
		const tool = filteredTool(filtersOf(pickClient("curl")))
		expect([tool.calls, tool.errors, Arr.map(tool.failed, (call) => call.client)]).toEqual([
			67,
			2,
			["curl", "curl"],
		])
	})

	test("a tool search and failing only narrow the chart with the totals", () => {
		const base = filtersOf(opened())
		const searched = filteredOverview({ ...base, search: "run_sql" })
		const failing = filteredOverview({ ...base, isFailingOnly: true })
		for (const overview of [searched, failing]) {
			expect(Arr.reduce(overview.series, 0, (total, point) => total + point.calls)).toBe(
				overview.totals.calls,
			)
			expect(Arr.reduce(overview.series, 0, (total, point) => total + point.errors)).toBe(
				overview.totals.errors,
			)
		}
		expect(searched.totals.calls).toBe(115)
		expect(searched.clients).toHaveLength(5)
		expect(Arr.reduce(searched.clients, 0, (total, client) => total + client.calls)).toBe(115)
	})

	test("kind and failing only narrow the chart's failures with the totals", () => {
		const overview = filteredOverview({ ...filtersOf(opened()), kind: "agent", isFailingOnly: true })
		expect(overview.totals.errors).toBe(1)
		expect(Arr.reduce(overview.series, 0, (total, point) => total + point.errors)).toBe(
			overview.totals.errors,
		)
	})

	test("a new percentile switches the chart to duration; re-pressing the pressed one keeps it", () => {
		expect(update(opened(), pressPercentile("p95", 2)).model.metric).toBe("duration")
		expect(update(opened(), pressPercentile("p90", 1)).model.metric).toBe("calls")
		const arrowed = update(
			opened(),
			Message.GotPercentileMessage({ message: ToggleGroup.Message.PressedArrowKey({ index: 2 }) }),
		)
		expect(arrowed.model.metric).toBe("calls")
	})
})
