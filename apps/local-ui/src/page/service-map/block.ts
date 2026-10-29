import { Block } from "foldkit"
import { EffectsLayer } from "./command"
import { ServiceMapPageComposition } from "./composition"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view } from "./view"

const prepare = () =>
	ServiceMapPageComposition.prepareBlock({
		init,
		update,
		view,
		EffectsLayer,
		operations: {
			/** The root's refresh (`invalidateQueries(["local"])`) runs the page's own Refresh. */
			requestRefresh: Message.ClickedRefresh,
			informLocationChanged: Message.InformedOfLocationChange,
		},
	})
export const ServiceMapPageBlock: Block.FromAssemblyWithViewAndOutMessage<typeof Model, typeof prepare> =
	Block.assemble(prepare)
