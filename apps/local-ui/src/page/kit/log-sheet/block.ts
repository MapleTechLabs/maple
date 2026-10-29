import { Block } from "foldkit"
import { EffectsLayer } from "../copies"
import { LogSheetComposition } from "./composition"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view } from "./view"

const prepare = () =>
	LogSheetComposition.prepareBlock({
		init,
		update,
		view,
		operations: { requestShowLog: Message.RequestedShowLog },
		EffectsLayer,
	})
export const LogSheetBlock: Block.FromAssemblyWithView<typeof Model, typeof prepare> = Block.assemble(prepare)
