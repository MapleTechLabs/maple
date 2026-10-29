import { Block } from "foldkit"
import { EffectsLayer } from "./command"
import { MetricDetailComposition } from "./composition"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view } from "./view"

const prepare = () =>
	MetricDetailComposition.prepareBlock({
		init,
		update,
		view,
		EffectsLayer,
		operations: {
			/** The root's refresh (`invalidateQueries(["local"])`) runs the page's own Refresh. */
			requestRefresh: Message.ClickedRefresh,
			/** A search change (range) keeps the instance and re-resolves the window's keys. */
			informLocationChanged: Message.InformedOfLocationChange,
		},
	})
export const MetricDetailBlock: Block.FromAssemblyWithViewAndOutMessage<typeof Model, typeof prepare> =
	Block.assemble(prepare)
