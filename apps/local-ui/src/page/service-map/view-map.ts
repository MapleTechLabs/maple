import { DB_NODE_PREFIX, parseDbNodeId } from "@maple/ui/components/service-map/service-map-utils"
import * as ServiceMap from "@maple/web/service-map/map/service-map"
import { view as mapView } from "@maple/web/service-map/map/view"
import { serviceMapLoading } from "@maple/web/service-map/map/loading"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { PageViewInputs } from "../kit/inputs"
import { signalEmptyState } from "../kit/signal-empty-state"
import { rangeOf } from "../contract"
import type { LocalServiceMapData } from "./data"
import { durationSecondsOf } from "./load"
import { Message } from "./message"
import type { Model } from "./model"
import { databasePanel } from "./view-db-panel"
import { servicePanel } from "./view-service-panel"

// `ServiceMapFlowCanvas` with local mode's empty state and detail panels.

const toMap = (message: ServiceMap.Message) => Message.GotMapMessage({ message })

/** `renderDetailPanel`: a database node gets its panel, anything else the service panel. */
const detailPanel =
	(h: HtmlBuilder<Message>, data: LocalServiceMapData, map: ServiceMap.Model, inputs: PageViewInputs) =>
	(selectedId: string): Html => {
		const durationSeconds = durationSecondsOf(inputs.context)
		const range = rangeOf(inputs.context)
		if (selectedId.startsWith(DB_NODE_PREFIX))
			return databasePanel(h, {
				...parseDbNodeId(selectedId),
				data,
				durationSeconds,
				range,
				onClose: toMap(ServiceMap.Message.ClickedCloseDetail()),
			})
		return servicePanel(h, {
			serviceName: selectedId,
			data,
			colorMode: map.colorMode,
			durationSeconds,
			range,
			actions: {
				onFocus: toMap(ServiceMap.Message.ClickedFocusSelected()),
				onClose: toMap(ServiceMap.Message.ClickedCloseDetail()),
			},
		})
	}

export const mapCanvas = (
	h: HtmlBuilder<Message>,
	model: Model,
	data: LocalServiceMapData,
	map: ServiceMap.Model | undefined,
	inputs: PageViewInputs,
): Html => {
	if (map === undefined) return serviceMapLoading(h)
	const range = rangeOf(inputs.context)
	return mapView(h, map, toMap, {
		emptyState: signalEmptyState(h, {
			signal: "traces",
			noun: "services",
			range,
			onWidenRange: Message.ClickedWidenRange(),
			maybePresence: inputs.presenceOf("traces"),
			nowMs: inputs.presenceNowMs,
			guide: {
				id: "service-map-empty",
				endpoint: inputs.context.env.otlpEndpoint,
				copies: model.copies,
				toCopyMessage: (id, message) => Message.GotCopyMessage({ id, message }),
			},
		}),
		detailPanel: detailPanel(h, data, map, inputs),
	})
}
