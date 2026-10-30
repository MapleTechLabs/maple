import * as FilterSections from "@maple/web/ui/filters/filter-sections"
import type { Block } from "foldkit"
import { TracesDefinition } from "./definition"

/** The filter rail's open/closed sections, remembered across visits. */
export const FilterSectionsBinding = TracesDefinition.makeBinding(FilterSections.FilterSectionsBlock, {
	field: "sections",
})

export const TracesComposition = TracesDefinition.makeComposition({
	bindings: [FilterSectionsBinding],
})
export type TracesViewBuilder = Block.ViewBuilderFor<typeof TracesComposition>
