import { Block } from "foldkit"
import { EffectsLayer } from "./command"
import { QueryComposition } from "./composition"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view } from "./view"

const prepare = () =>
	QueryComposition.prepareBlock({
		init,
		update,
		view,
		EffectsLayer,
		operations: {
			informLocationChanged: Message.InformedOfLocationChange,
		},
	})
export const QueryBlock: Block.FromAssemblyWithViewAndOutMessage<typeof Model, typeof prepare> = Block.assemble(prepare)
