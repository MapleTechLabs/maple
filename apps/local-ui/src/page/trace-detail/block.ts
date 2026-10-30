import { AttachFlowCanvas } from "@maple/web/service-map/xyflow/attach"
import { Layer } from "effect"
import { Block } from "foldkit"
import { CommandsLayer } from "./command"
import { TraceDetailComposition } from "./composition"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view } from "./view"

/** The page's own handlers and the flow canvas's Mount; its child Blocks bring theirs through their Bindings. */
const EffectsLayer = Layer.mergeAll(CommandsLayer, AttachFlowCanvas.layer)

const prepare = () =>
	TraceDetailComposition.prepareBlock({
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
export const TraceDetailBlock: Block.FromAssemblyWithViewAndOutMessage<typeof Model, typeof prepare> =
	Block.assemble(prepare)
