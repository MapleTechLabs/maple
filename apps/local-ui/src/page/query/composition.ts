import type { Block } from "foldkit"
import { QueryDefinition } from "./definition"

/** The console has no child Blocks. */
export const QueryComposition = QueryDefinition.makeComposition()
export type QueryViewBuilder = Block.ViewBuilderFor<typeof QueryComposition>
