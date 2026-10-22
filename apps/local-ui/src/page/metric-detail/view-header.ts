import { humanizeUnit } from "../../lib/units"
import { metricTypeBadge } from "@maple/web/page/metrics/shared"
import { button } from "@maple/web/ui/button"
import { badge } from "@maple/web/ui/display"
import { icon } from "@maple/web/ui/icon"
import { truncatedText } from "@maple/web/ui/truncated-text"
import type { Html, HtmlBuilder } from "foldkit/html"
import { refreshButton, timeRangeSelect } from "../kit/toolbar"
import type { MetricEntry } from "../metrics/catalog"
import { Message } from "./message"
import type { Model } from "./model"

// The metric detail page's header row.

export const detailHeader = (
	h: HtmlBuilder<Message>,
	model: Model,
	options: Readonly<{ entry: MetricEntry | null; backLabel: string; range: string; hasNewData: boolean }>,
): Html => {
	const { entry } = options
	const unitLabel = entry === null ? "" : humanizeUnit(entry.metricUnit, entry.metricName)
	return h.div(
		[h.Class("flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2")],
		[
			button(
				h,
				{
					variant: "ghost",
					size: "sm",
					className: "gap-1.5",
					attributes: [h.OnClick(Message.ClickedBack())],
				},
				[icon(h, "ArrowLeftIcon"), options.backLabel],
			),
			truncatedText(h, { text: model.metricName, mono: true, className: "text-xs" }),
			...(entry === null ? [] : [metricTypeBadge(h, entry.metricType)]),
			...(unitLabel
				? [
						badge(
							h,
							{
								variant: "outline",
								size: "xs",
								mono: true,
								attributes: entry === null ? [] : [h.Title(entry.metricUnit)],
							},
							[unitLabel],
						),
					]
				: []),
			h.div(
				[h.Class("ml-auto flex items-center gap-2")],
				[
					refreshButton(h, {
						isSpinning: model.isRefreshing,
						hasNewData: options.hasNewData,
						onRefresh: Message.ClickedRefresh(),
					}),
					timeRangeSelect(h, options.range, (range) => Message.ChangedRange({ range })),
				],
			),
		],
	)
}
