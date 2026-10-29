import * as CopyButton from "@maple/web/ui/copy-button"
import * as FilterSections from "@maple/web/ui/filters/filter-sections"
import { Tuple } from "effect"
import type { Block } from "foldkit"
import { SessionsDefinition } from "./definition"

/** The empty state's connect guide: its copy buttons are `${GUIDE_ID}-endpoint` and `${GUIDE_ID}-env`. */
export const GUIDE_ID = "sessions-empty"

const GUIDE_COPY_IDS = [`${GUIDE_ID}-endpoint`, `${GUIDE_ID}-env`]

/** The filter rail's open, search and "show more" state. */
export const FilterSectionsBinding = SessionsDefinition.makeBinding(FilterSections.FilterSectionsBlock, {
	field: "sections",
})

/** The connect guide's copy buttons, one per id. */
export const CopiesBinding = SessionsDefinition.makeBinding(CopyButton.CopyButtonBlock, {
	field: "copies",
	key: "id",
	childField: "copy",
	init: {
		instances: () => GUIDE_COPY_IDS.map((key) => ({ key, args: Tuple.make() })),
		toItem: ({ key }, copy) => ({ id: key, copy }),
	},
})

export const SessionsComposition = SessionsDefinition.makeComposition({
	bindings: [FilterSectionsBinding, CopiesBinding],
})
export type SessionsViewBuilder = Block.ViewBuilderFor<typeof SessionsComposition>
