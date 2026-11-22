import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"
import type { Html, HtmlBuilder } from "foldkit/html"
import { BAR_CHART_TOKENS } from "@maple/views/charts/bar-chart"
import { emptyMessage } from "@maple/views/ui/empty"
import { panel, panelBody, panelHeader } from "@maple/views/ui/panel"

export const analyticsPanel = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ title: string; control?: Html; footer?: Html }>,
	children: ReadonlyArray<Html>,
): Html =>
	panel(h, {}, [
		panelHeader(h, { title: options.title, action: options.control }),
		// With a footer, the footer takes a stretched card's spare height, so side-by-side cards keep
		// their charts and their lists on the same lines.
		panelBody(h, children, options.footer === undefined ? "px-4 py-4" : "flex-none px-4 py-4"),
		...(options.footer === undefined
			? []
			: [h.footer([h.Class("flex-1 border-t px-4 py-4")], [options.footer])]),
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
