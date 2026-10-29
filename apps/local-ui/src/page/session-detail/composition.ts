import * as CopyButton from "@maple/web/ui/copy-button"
import type { Block } from "foldkit"
import { SessionDetailDefinition } from "./definition"

/** The hero's session id copy button. */
export const CopyBinding = SessionDetailDefinition.makeBinding(CopyButton.CopyButtonBlock, { field: "copy" })

export const SessionDetailComposition = SessionDetailDefinition.makeComposition({ bindings: [CopyBinding] })
export type SessionDetailViewBuilder = Block.ViewBuilderFor<typeof SessionDetailComposition>
