import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"
import type { Html, HtmlBuilder } from "foldkit/html"
import { BAR_CHART_TOKENS } from "@maple/views/charts/bar-chart"
import { emptyMessage } from "@maple/views/ui/empty"
import { panel, panelBody, panelHeader } from "@maple/views/ui/panel"

// `AnalyticsPanel` and `ChartFrame`, shared with the CI tab.

export const analyticsPanel = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ title: string; control?: Html; footer?: Html }>,
	children: ReadonlyArray<Html>,
): Html =>
	panel(h, {}, [
		panelHeader(h, { title: options.title, action: options.control }),
		panelBody(h, children, "px-4 py-4"),
		...(options.footer === undefined
			? []
			: [h.footer([h.Class("border-t px-4 py-4")], [options.footer])]),
	])

export const chartFrame = <M>(h: HtmlBuilder<M>, isEmpty: boolean, chart: () => Html): Html =>
	isEmpty
		? emptyMessage(h, { dashed: true, className: "flex h-56 items-center justify-center" }, [
				"Nothing in this window",
			])
		: h.div([h.Class("h-56 w-full")], [chart()])

/** The colour tokens the series names resolve to, plus the bar chart's own. */
export const seriesTokens = (names: ReadonlyArray<string>): ReadonlyArray<string> => [
	...new Set([...BAR_CHART_TOKENS, ...resolveSeriesColors(names).values()]),
]
