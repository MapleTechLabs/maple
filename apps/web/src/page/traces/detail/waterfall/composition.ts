import type { Block } from "foldkit"
import { WaterfallDefinition } from "./definition"
import { VirtualizeWaterfall } from "./virtualize"

export const WaterfallComposition = WaterfallDefinition.makeComposition({ mounts: [VirtualizeWaterfall] })
export type WaterfallViewBuilder = Block.ViewBuilderFor<typeof WaterfallComposition>
