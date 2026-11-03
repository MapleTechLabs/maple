import { errorState } from "@maple/views/ui/error-state"
import { WIDEST_RANGE } from "../../lib/time"
import { ResolveThemeColors } from "@maple/views/charts/theme-colors"
import { button } from "@maple/views/ui/button"
import { vstack } from "@maple/views/ui/stack"
import { Option } from "effect"
import { Submodel } from "foldkit"
import { scrollRegion } from "@maple/views/ui/scroll-region"
import type { Html } from "foldkit/html"
import { failureWithoutData, isAwaitingFirstData } from "@maple/views/data/keyed"
import { rangeOf } from "../contract"
import type { PageViewInputs } from "../kit/inputs"
import { emptyNotice } from "../kit/placeholders"
import { SERIES_CHART_TOKENS } from "../kit/series-chart"
import { boundsOf, entryOf } from "./load"
import { Message } from "./message"
import type { Model } from "./model"
import { detailBody } from "./view-body"
import { detailHeader } from "./view-header"
import { loadingFill } from "../kit/page-body"

// The metric detail page: one metric's chart and its per-service breakdown.

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const { context } = inputs
	const range = rangeOf(context)
	const entry = entryOf(model)
	const content = (): Html => {
		if (isAwaitingFirstData(model.entry)) return loadingFill(h)
		const failure = failureWithoutData(model.entry)
		if (Option.isSome(failure))
			return errorState(h, {
				failure: failure.value,
				title: "Couldn’t load metric",
				onRetry: Message.ClickedRefresh(),
			})
		const maybeBounds = boundsOf(model, context)
		if (entry === null || Option.isNone(maybeBounds))
			return vstack(h, { gap: "3", align: "center", justify: "center", className: "h-full" }, [
				emptyNotice(h, {
					title: "Metric not found",
					hint: "Nothing reported this metric in the selected time range.",
				}),
				...(range !== WIDEST_RANGE
					? [
							button(
								h,
								{
									variant: "outline",
									size: "sm",
									attributes: [h.OnClick(Message.ClickedWidenRange())],
								},
								["Widen to 30 days"],
							),
						]
					: []),
			])
		return detailBody(h, model, entry, maybeBounds.value, inputs.clockMs)
	}
	return vstack(
		h,
		{ className: "h-full", attributes: [h.OnMount(ResolveThemeColors({ tokens: SERIES_CHART_TOKENS }))] },
		[
			detailHeader(h, model, {
				entry,
				backLabel: context.canGoBack ? "Back" : "Metrics",
				range,
				hasNewData: inputs.hasNewDataSince(model.entryUpdatedAtMs),
			}),
			scrollRegion(h, { className: "overflow-auto" }, [content()]),
		],
	)
})
