import { Layer } from "effect"
import { Block } from "foldkit"
import { EffectsLayer as CopiesEffectsLayer } from "../kit/copies"
import { CommandsLayer } from "./command"
import { LogsComposition } from "./composition"
import { Message } from "./message"
import type { Model } from "./model"
import { PlaceLocalChipCard } from "./mount"
import { init } from "./update"
import { WaitChipDelay } from "./update-chips"
import { update } from "./update-main"
import { view } from "./view"
import { ObserveLogsViewport } from "./virtualize"

/** The page's own handlers; its child Blocks bring theirs through their Bindings. */
const EffectsLayer = Layer.mergeAll(
	CommandsLayer,
	WaitChipDelay.layer,
	ObserveLogsViewport.layer,
	PlaceLocalChipCard.layer,
	CopiesEffectsLayer,
)

const prepare = () =>
	LogsComposition.prepareBlock({
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
export const LogsBlock: Block.FromAssemblyWithViewAndOutMessage<typeof Model, typeof prepare> = Block.assemble(prepare)
