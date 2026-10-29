import { Block } from "foldkit"
import { Layer } from "effect"
import { MountNetworkAutoRetry } from "../../../../ui/error-state"
import { PanelStateEffectsLayer } from "./command"
import { SpanPanelComposition } from "./composition"
import type { Model } from "./model"
import { init, update } from "./update"
import { view } from "./view"

const EffectsLayer = Layer.merge(PanelStateEffectsLayer, MountNetworkAutoRetry.layer)

const prepare = () => SpanPanelComposition.prepareBlock({ init, update, view, EffectsLayer })
export const SpanPanelBlock: Block.FromAssemblyWithViewAndOutMessage<typeof Model, typeof prepare> =
	Block.assemble(prepare)
