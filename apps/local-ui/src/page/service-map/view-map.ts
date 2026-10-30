import { DB_NODE_PREFIX, parseDbNodeId } from "@maple/ui/components/service-map/service-map-utils"
import type * as ServiceMap from "@maple/web/service-map/map/service-map"
import { serviceMapLoading } from "@maple/web/service-map/map/loading"
import type * as CopyButton from "@maple/web/ui/copy-button"
import { Option } from "effect"
import type { Html } from "foldkit/html"
import { presenceOf } from "../../data/signal-presence"
import { rangeOf } from "../contract"
import { signalEmptyState } from "../kit/signal-empty-state"
import {
	GuideEndpointCopyBinding,
	GuideEnvCopyBinding,
	MapBinding,
	type ServiceMapPageViewBuilder,
} from "./composition"
import type { LocalServiceMapData } from "./data"
import { durationSecondsOf } from "./load"
import { Message } from "./message"
import type { Model } from "./model"
import type { ServiceMapViewInputs } from "./view-inputs"
import { databasePanel } from "./view-db-panel"
import { servicePanel } from "./view-service-panel"

// `ServiceMapFlowCanvas` with local mode's empty state and detail panels.

const GUIDE_ID = "service-map-empty"

/** `renderDetailPanel`: a database node gets its panel, anything else the service panel. */
const detailPanel =
	(
		h: ServiceMapPageViewBuilder,
		data: LocalServiceMapData,
		map: ServiceMap.Model,
		inputs: ServiceMapViewInputs,
	) =>
	(selectedId: string): Html => {
		const durationSeconds = durationSecondsOf(inputs.context)
		const range = rangeOf(inputs.context)
		if (selectedId.startsWith(DB_NODE_PREFIX))
			return databasePanel(h, {
				...parseDbNodeId(selectedId),
				data,
				durationSeconds,
				range,
				onClose: Message.ClickedCloseDetail(),
			})
		return servicePanel(h, {
			serviceName: selectedId,
			data,
			colorMode: map.colorMode,
			durationSeconds,
			range,
			actions: {
				onFocus: Message.ClickedFocusSelected(),
				onClose: Message.ClickedCloseDetail(),
			},
		})
	}

/** The connect guide's two copy buttons, by the id the guide gives each. */
const embedGuideCopy =
	(h: ServiceMapPageViewBuilder, model: Model) =>
	(copyId: string, viewInputs: CopyButton.CopyButtonViewInputs): Html =>
		copyId === `${GUIDE_ID}-endpoint`
			? h.block(
					GuideEndpointCopyBinding.embedView({
						slotId: copyId,
						model: model.guideEndpointCopy,
						viewInputs,
					}),
				)
			: h.block(
					GuideEnvCopyBinding.embedView({ slotId: copyId, model: model.guideEnvCopy, viewInputs }),
				)

export const mapCanvas = (
	h: ServiceMapPageViewBuilder,
	model: Model,
	data: LocalServiceMapData,
	inputs: ServiceMapViewInputs,
): Html =>
	Option.match(model.maybeMap, {
		onNone: () => serviceMapLoading(h),
		onSome: (map) =>
			h.block(
				MapBinding.embedView({
					slotId: "service-map",
					model: map,
					viewInputs: {
						emptyState: () =>
							signalEmptyState(h, {
								signal: "traces",
								noun: "services",
								range: rangeOf(inputs.context),
								onWidenRange: Message.ClickedWidenRange(),
								maybePresence: presenceOf(inputs.maybePresence, "traces"),
								nowMs: Option.match(inputs.maybePresence, {
									onNone: () => 0,
									onSome: (result) => result.nowMs,
								}),
								guide: {
									id: GUIDE_ID,
									endpoint: inputs.context.env.otlpEndpoint,
									embedCopy: embedGuideCopy(h, model),
								},
							}),
						detailPanel: detailPanel(h, data, map, inputs),
					},
				}),
			),
	})
