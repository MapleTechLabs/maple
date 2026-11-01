import { describe, expect, test } from "vitest"
import * as Select from "../ui/select"
import * as ToggleGroup from "../ui/toggle-group"
import { filteredOverview, filteredTool } from "./mcp-filter"
import { filtersOf, init, Message, update } from "./mcp-lab"

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
		const seriesCalls = overview.series.reduce((sum, point) => sum + point.calls, 0)
		expect([overview.totals.calls, overview.totals.errors, overview.tools.length, seriesCalls]).toEqual([
			15, 1, 4, 15,
		])
	})

	test("a client facet change narrows run_sql to that client's calls and failures", () => {
		const tool = filteredTool(filtersOf(pickClient("curl")))
		expect([tool.calls, tool.errors, tool.failed.map((call) => call.client)]).toEqual([
			67,
			2,
			["curl", "curl"],
		])
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
