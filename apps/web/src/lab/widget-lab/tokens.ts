import { pieChartTokens } from "@maple/views/charts/pie-chart"
import { WIDGET_CHART_TOKENS } from "../../page/dashboards/kit/chart-tokens"
import { ALL_CELLS } from "./catalog"
import { Array as Arr } from "effect"

/** Every custom property the lab's charts read, resolved once by `ResolveThemeColors`. */
export const THEME_TOKENS: ReadonlyArray<string> = [
	...new Set([
		...WIDGET_CHART_TOKENS,
		...Arr.flatMap(ALL_CELLS, (cell) =>
			cell.state._tag === "Ready" && cell.state.data !== null && cell.state.data._tag === "Rows"
				? pieChartTokens(cell.state.data.rows)
				: [],
		),
	]),
]
