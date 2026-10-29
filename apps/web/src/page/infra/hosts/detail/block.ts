import { Block } from "foldkit"
import { EffectsLayer } from "./command"
import { HostDetailComposition } from "./composition"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view } from "./view"

const prepare = () =>
	HostDetailComposition.prepareBlock({
		init,
		update,
		view,
		EffectsLayer,
		operations: {
			/** Same instance, new route: the search params changed (the window). */
			informOfRouteChange: Message.InformedOfRouteChange,
			/** The namespace pin or time zone changed (an org change builds a new instance). */
			informOfContextChange: Message.InformedOfContextChange,
		},
	})
export const HostDetailBlock: Block.FromAssemblyWithViewAndOutMessage<typeof Model, typeof prepare> =
	Block.assemble(prepare)
