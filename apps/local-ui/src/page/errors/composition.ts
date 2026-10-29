import * as CopyButton from "@maple/web/ui/copy-button"
import * as FilterSections from "@maple/web/ui/filters/filter-sections"
import type { Block } from "foldkit"
import { ErrorsDefinition } from "./definition"

/** The filter rail's remembered open/closed sections and their searches. */
export const FilterSectionsBinding = ErrorsDefinition.makeBinding(FilterSections.FilterSectionsBlock, {
	field: "sections",
})

/** The empty state's connect guide: the endpoint field's copy button and the env block's. */
export const GuideEndpointCopyBinding = ErrorsDefinition.makeBinding(CopyButton.CopyButtonBlock, {
	field: "guideEndpointCopy",
})
export const GuideEnvCopyBinding = ErrorsDefinition.makeBinding(CopyButton.CopyButtonBlock, { field: "guideEnvCopy" })

export const ErrorsComposition = ErrorsDefinition.makeComposition({
	bindings: [FilterSectionsBinding, GuideEndpointCopyBinding, GuideEnvCopyBinding],
})
export type ErrorsViewBuilder = Block.ViewBuilderFor<typeof ErrorsComposition>
