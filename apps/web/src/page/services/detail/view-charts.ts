import { mergeExactThroughput } from "@maple/web-data/warehouse/custom-charts"
import { Option, Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { MountLinkedZoom } from "@maple/views/charts/linked-cursor"
import { type GridState, metricsGridOf } from "../../kit/service-metrics/grid"
import type { MarkerCard } from "../../kit/service-metrics/marker-card"
import { commitMarkers } from "../../kit/service-metrics/markers"
import type { DetailPoint } from "../../kit/service-metrics/points"
import { Message } from "./message"
import type { Model } from "./model"

// The Overview tab's `MetricsGrid`: the page's series, markers and chart Messages.

/** The overview series with the exact pre-sampling volume merged by bucket (`mergeExactThroughput`). */
export const mergedPoints = (model: Model): ReadonlyArray<DetailPoint> => {
	const base = AsyncData.getOrElse(
		AsyncData.map(model.overview.data, (data) => data.points),
		() => [],
	)
	const exact = AsyncData.getOrElse(model.refinement.data, () => [])
	return mergeExactThroughput(base, new Map(Arr.map(exact, (point) => [point.bucket, point.throughput])))
}

/** The page's marker hover card, over the commits the Overview resolved. */
export const markerCardOf = (model: Model, timeZone: string): MarkerCard<Message> => ({
	model: model.markerCard,
	toParent: (message) => Message.GotMarkerCardMessage({ message }),
	commits: model.commits,
	clock: { nowMs: model.nowMs ?? 0, timeZone },
})

export const metricsGrid = (
	h: HtmlBuilder<Message>,
	model: Model,
	state: GridState,
	timeZone: string,
): Html => {
	const points = mergedPoints(model)
	const overview = AsyncData.getData(model.overview.data)
	const markers = Option.match(overview, {
		onNone: () => [],
		onSome: (data) =>
			commitMarkers(
				data.releases,
				Arr.map(points, (point) => point.bucket),
				model.commits,
			),
	})
	return metricsGridOf(
		h,
		{
			charts: model.charts,
			rows: Arr.map(points, (point) => ({ ...point })),
			markers,
			markerCard: markerCardOf(model, timeZone),
			toChartMessage: (chartId, message) => Message.GotChartMessage({ chartId, message }),
			linkedCursorMount: MountLinkedZoom({ timeZone }),
		},
		state,
	)
}
