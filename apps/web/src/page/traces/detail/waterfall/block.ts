import { Block } from "foldkit"
import { WaterfallComposition } from "./composition"
import { Message, Model } from "./model"
import { init, update } from "./update"
import { view } from "./view"
import { VirtualizeWaterfall } from "./virtualize"

const prepare = () =>
	WaterfallComposition.prepareBlock({
		init,
		update,
		view,
		operations: { informSelectedSpan: Message.InformedOfSelectedSpan },
		EffectsLayer: VirtualizeWaterfall.layer,
	})
export const WaterfallBlock: Block.FromAssemblyWithViewAndOutMessage<typeof Model, typeof prepare> =
	Block.assemble(prepare)
