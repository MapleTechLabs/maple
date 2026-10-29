import { WIDEST_RANGE } from "../../lib/time"
import { ResolveThemeColors } from "@maple/web/charts/theme-colors"
import { button } from "@maple/web/ui/button"
import { spinner } from "@maple/web/ui/spinner"
import { Option } from "effect"
import type { Html } from "foldkit/html"
import { failureWithoutData, isPending } from "../../data/slot"
import { type PageContext, rangeOf } from "../contract"
import { SERIES_CHART_TOKENS } from "../kit/series-chart"
import { emptyState, errorState } from "../kit/view-states"
import { MetricDetailComposition } from "./composition"
import { boundsOf, entryOf } from "./load"
import { Message } from "./message"
import { detailBody } from "./view-body"
import { detailHeader } from "./view-header"

// The metric detail page: one metric's chart and its per-service breakdown.

/** What the view reads from the root: data only, as Block view inputs carry no callbacks. */
export type MetricDetailViewInputs = Readonly<{
	context: PageContext
	/** The root's latest clock read (each server probe): legacy's per-render `Date.now()` for relative times. */
	clockMs: number
	/** The server's last ingest, for `useNewDataSince`'s "New data" pill. */
	lastIngestAtMs: Option.Option<number>
}>

/** `useNewDataSince(sinceMs)`: telemetry arrived after the entry loaded. */
const hasNewDataSince = (inputs: MetricDetailViewInputs, sinceMs: number): boolean =>
	sinceMs > 0 && Option.exists(inputs.lastIngestAtMs, (last) => last > sinceMs)

export const view = MetricDetailComposition.makeView.withInputs<MetricDetailViewInputs>((model, inputs, h) => {
	const { context } = inputs
	const range = rangeOf(context)
	const entry = entryOf(model)
	const content = (): Html => {
		if (isPending(model.entry)) return h.div([h.Class("flex h-full items-center justify-center")], [spinner(h)])
		const failure = failureWithoutData(model.entry)
		if (Option.isSome(failure))
			return errorState(h, { label: "metric", failure: failure.value, onRetry: Message.ClickedRefresh() })
		const maybeBounds = boundsOf(model, context)
		if (entry === null || Option.isNone(maybeBounds))
			return h.div(
				[h.Class("flex h-full flex-col items-center justify-center gap-3")],
				[
					emptyState(h, {
						title: "Metric not found",
						hint: ["Nothing reported this metric in the selected time range."],
					}),
					...(range !== WIDEST_RANGE
						? [
								button(
									h,
									{ variant: "outline", size: "sm", attributes: [h.OnClick(Message.ClickedWidenRange())] },
									["Widen to 30 days"],
								),
							]
						: []),
				],
			)
		return detailBody(h, model, entry, maybeBounds.value, inputs.clockMs)
	}
	return h.div(
		[h.Class("flex h-full flex-col"), h.OnMount(ResolveThemeColors({ tokens: SERIES_CHART_TOKENS }))],
		[
			detailHeader(h, model, {
				entry,
				backLabel: context.canGoBack ? "Back" : "Metrics",
				range,
				hasNewData: hasNewDataSince(inputs, model.entryUpdatedAtMs),
			}),
			h.div([h.Class("min-h-0 flex-1 overflow-auto")], [content()]),
		],
	)
})
