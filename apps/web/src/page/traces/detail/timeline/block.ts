import { Layer } from "effect"
import { Block } from "foldkit"
import { FocusSearch, MeasureTimelineBody, MountAltToggle, ReadSidebarWidth, ScrollToRow } from "./command"
import { TimelineComposition } from "./composition"
import { Message } from "./message"
import { Model } from "./model"
import { init, update } from "./update"
import { view } from "./view"

const prepare = () =>
	TimelineComposition.prepareBlock({
		init,
		update,
		view,
		operations: {
			informSelectedSpanId: Message.InformedOfSelectedSpanId,
			informSpanEvents: Message.InformedOfSpanEvents,
			informColorBy: Message.InformedOfColorBy,
		},
		EffectsLayer: Layer.mergeAll(
			ReadSidebarWidth.layer,
			FocusSearch.layer,
			ScrollToRow.layer,
			MeasureTimelineBody.layer,
			MountAltToggle.layer,
		),
	})
export const TimelineBlock: Block.FromAssemblyWithViewAndOutMessage<typeof Model, typeof prepare> =
	Block.assemble(prepare)
