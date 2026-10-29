import { Block } from "foldkit"
import { EffectsLayer } from "./command"
import { SessionsComposition } from "./composition"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view } from "./view"

const prepare = () =>
	SessionsComposition.prepareBlock({
		init,
		update,
		view,
		EffectsLayer,
		operations: {
			informLocationChanged: Message.InformedOfLocationChange,
			requestRefresh: Message.ClickedRefresh,
		},
	})
export const SessionsBlock: Block.FromAssemblyWithViewAndOutMessage<typeof Model, typeof prepare> = Block.assemble(prepare)
