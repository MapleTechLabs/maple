import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { serviceMapLoading } from "@maple/views/service-map/map/loading"
import { errorState } from "@maple/views/ui/error-state"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureWithoutData, isAwaitingFirstData } from "@maple/views/data/keyed"
import { rangeOf } from "../contract"
import type { PageViewInputs } from "../kit/inputs"
import { refreshButton, timeRangeSelect, toolbar, toolbarStat, toolbarStats } from "../kit/toolbar"
import { Message } from "./message"
import type { Model } from "./model"
import { mapCanvas } from "./view-map"
import { noEdgesNotice } from "./view-parts"

// The service map page.

const content = (h: HtmlBuilder<Message>, model: Model, inputs: PageViewInputs): Html | null => {
	if (isAwaitingFirstData(model.data)) return serviceMapLoading(h)
	const failure = failureWithoutData(model.data)
	if (Option.isSome(failure))
		return errorState(h, {
			failure: failure.value,
			title: "Couldn’t load the service map",
			onRetry: Message.ClickedRetry(),
		})
	return Option.match(AsyncData.getData(model.data.data), {
		onNone: () => null,
		onSome: (data) => mapCanvas(h, model, data, Option.getOrUndefined(model.maybeMap), inputs),
	})
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const maybeData = AsyncData.getData(model.data.data)
	const source = Option.map(model.maybeMap, (map) => map.source)
	const serviceCount = Option.match(source, { onNone: () => 0, onSome: (graph) => graph.services.length })
	const nodeCount = Option.match(source, { onNone: () => 0, onSome: (graph) => graph.rawNodes.length })
	const edgeCount = Option.match(maybeData, { onNone: () => 0, onSome: (data) => data.edges.length })
	const isEdgeless = Option.exists(
		maybeData,
		(data) => data.overviews.length > 0 && data.edges.length === 0,
	)
	const body = content(h, model, inputs)
	return h.div(
		[h.Class("flex h-full flex-col")],
		[
			toolbar(h, [
				toolbarStats(h, [
					toolbarStat(h, { value: serviceCount, label: "services" }),
					toolbarStat(h, { value: edgeCount, label: "connections" }),
					toolbarStat(h, { value: nodeCount - serviceCount, label: "databases" }),
				]),
				toolbarStats(h, [
					refreshButton(h, {
						isSpinning: model.isRefreshing,
						hasNewData: inputs.hasNewDataSince(model.dataUpdatedAtMs),
						onRefresh: Message.ClickedRefresh(),
					}),
					timeRangeSelect(h, rangeOf(inputs.context), (range) => Message.ChangedRange({ range })),
				]),
			]),
			...(isEdgeless ? [noEdgesNotice(h)] : []),
			h.div(
				[h.Class(cn("min-h-0 flex-1", refreshingClass(model.data.retained === true)))],
				body === null ? [] : [body],
			),
		],
	)
})
