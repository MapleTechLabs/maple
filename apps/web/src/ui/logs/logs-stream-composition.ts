import type { Block } from "foldkit"
import { AttributesPanelBlock } from "../attributes/attributes-panel-block"
import { PlaceChipCard } from "./chip-card"
import {
	LogsStreamDefinition,
	makeOutMessageFold,
	makeOutMessageStep,
	OutMessage,
} from "./logs-stream-definition"
import { VirtualizeLogStream } from "./virtualize"

/** Each expanded row's attribute panel, keyed by row index; its filter choice leaves the stream as ours. */
export const PanelsBinding = LogsStreamDefinition.makeMapBinding(AttributesPanelBlock, {
	field: "panels",
}).withOutMessagePolicy({
	fold: (_index, outMessage) =>
		makeOutMessageFold(AttributesPanelBlock, {
			ChoseAttributeFilter: ({ source, key, value, negated }) =>
				makeOutMessageStep(() => OutMessage.ChoseAttributeFilter({ source, key, value, negated })),
		})(outMessage),
})

export const LogsStreamComposition = LogsStreamDefinition.makeComposition({
	bindings: [PanelsBinding],
	mounts: [VirtualizeLogStream, PlaceChipCard],
})
export type LogsStreamViewBuilder = Block.ViewBuilderFor<typeof LogsStreamComposition>
