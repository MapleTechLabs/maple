import { colorByFromId } from "@maple/ui/components/traces/color-by"
import type { Block } from "foldkit"
import { SelectBlock } from "../../../../ui/select-view"
import { MeasureTimelineBody, MountAltToggle } from "./command"
import { TimelineDefinition } from "./definition"
import { OutMessage } from "./message"

/** `ColorByPicker`'s Select; `init` builds it with the trace, the page owns the scheme. */
export const ColorBySelectBinding = TimelineDefinition.makeBinding(SelectBlock, {
	field: "colorBySelect",
	init: false,
}).withOutMessagePolicy({
	fold: TimelineDefinition.makeOutMessageFold(SelectBlock, {
		ChangedValue: ({ value }) =>
			TimelineDefinition.makeStep((model) =>
				value === model.colorBy || colorByFromId(value) === undefined
					? { model }
					: { model, outMessage: OutMessage.ChangedColorBy({ colorBy: value }) },
			),
	}),
})

export const TimelineComposition = TimelineDefinition.makeComposition({
	bindings: [ColorBySelectBinding],
	mounts: [MeasureTimelineBody, MountAltToggle],
})
export type TimelineViewBuilder = Block.ViewBuilderFor<typeof TimelineComposition>
