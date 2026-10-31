import { legend, releaseImpact } from "../worst-case-fixture"
import { verdict } from "../worst-case-docs"
import type { Html } from "foldkit/html"
import { verdictCard } from "../../page/investigations/detail/view-verdict"
import { queryBuilderLegend } from "../../page/kit/query-builder-legend"
import { releaseComparison } from "../../page/releases/detail/view-comparison"
import { Message, type Model } from "./model"
import * as TraceBox from "./trace-box"
import * as TraceBoxView from "./trace-box-view"
import { type H, narrow, wcSection } from "./view-parts"

// `TraceSection`, `LegendSection` and `VerdictSection`.

const traceBox = (
	h: H,
	id: string,
	box: TraceBox.Model | null,
	toMessage: (message: TraceBox.Message) => Message,
): ReadonlyArray<Html> =>
	box === null
		? []
		: [
				h.submodel({
					slotId: id,
					model: box,
					view: TraceBoxView.view,
					viewInputs: { id },
					toParentMessage: toMessage,
				}),
			]

/** Selecting the deepest span expands its whole ancestor chain: the "expand all" of a chain. */
export const traceSection = (h: H, model: Model): Html =>
	wcSection(h, "wc-trace", "Trace: 60-deep chain, deepest span selected", [
		// Slots keyed by mode, so a mode change remounts the boxes.
		...traceBox(h, `wc-trace-w-${model.mode}`, model.waterfallBox, (message) =>
			Message.GotWaterfallBoxMessage({ message }),
		),
		...traceBox(h, `wc-trace-t-${model.mode}`, model.timelineBox, (message) =>
			Message.GotTimelineBoxMessage({ message }),
		),
	])

export const legendSection = (h: H, model: Model): Html => {
	const { series, stats } = legend(model.mode)
	const base = {
		series,
		stats,
		hidden: model.hiddenSeries,
		onToggle: (key: string) => Message.ToggledLegendSeries({ key }),
	}
	return wcSection(h, "wc-legend", "QueryBuilderLegend: stats and compact", [
		h.div([h.Class("max-w-2xl rounded-md border p-2")], [queryBuilderLegend(h, { ...base, unit: "ms" })]),
		h.div(
			[h.Class("max-w-2xl rounded-md border p-2")],
			[queryBuilderLegend(h, { ...base, variant: "compact" })],
		),
		narrow(h, [queryBuilderLegend(h, { ...base, unit: "ms" })]),
	])
}

export const verdictSection = (h: H, model: Model): Html =>
	wcSection(h, "wc-verdict", "Investigation VerdictCard", [
		h.div([h.Class("max-w-3xl")], [verdictCard(h, verdict(model.mode), model.nowMs)]),
	])

export const releaseNarrow = (h: H, model: Model): Html =>
	narrow(
		h,
		[
			releaseComparison(h, releaseImpact(model.mode), {
				model: model.releaseOverlays,
				toParent: (message) => Message.GotReleaseOverlaysMessage({ message }),
				clock: { nowMs: model.nowMs, timeZone: model.timeZone },
			}),
		],
		420,
	)
