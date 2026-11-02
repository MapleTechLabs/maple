import { errorState } from "@maple/views/ui/error-state"
import { toKitFailure } from "../../data/local-query"
import { WIDEST_RANGE } from "../../lib/time"
import { ResolveThemeColors } from "@maple/views/charts/theme-colors"
import { button } from "@maple/views/ui/button"
import { spinner } from "@maple/views/ui/spinner"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html } from "foldkit/html"
import { failureWithoutData, isPending } from "../../data/slot"
import { rangeOf } from "../contract"
import type { PageViewInputs } from "../kit/inputs"
import { emptyNotice } from "../kit/placeholders"
import { SERIES_CHART_TOKENS } from "../kit/series-chart"
import { boundsOf, entryOf } from "./load"
import { Message } from "./message"
import type { Model } from "./model"
import { detailBody } from "./view-body"
import { detailHeader } from "./view-header"

// The metric detail page: one metric's chart and its per-service breakdown.

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const { context } = inputs
	const range = rangeOf(context)
	const entry = entryOf(model)
	const content = (): Html => {
		if (isPending(model.entry)) return h.div([h.Class("flex h-full items-center justify-center")], [spinner(h)])
		const failure = failureWithoutData(model.entry)
		if (Option.isSome(failure))
			return errorState(h, {
				failure: toKitFailure(failure.value, "metric"),
				onRetry: Message.ClickedRefresh(),
			})
		const maybeBounds = boundsOf(model, context)
		if (entry === null || Option.isNone(maybeBounds))
			return h.div(
				[h.Class("flex h-full flex-col items-center justify-center gap-3")],
				[
					emptyNotice(h, {
						title: "Metric not found",
						hint: "Nothing reported this metric in the selected time range.",
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
				hasNewData: inputs.hasNewDataSince(model.entryUpdatedAtMs),
			}),
			h.div([h.Class("min-h-0 flex-1 overflow-auto")], [content()]),
		],
	)
})
