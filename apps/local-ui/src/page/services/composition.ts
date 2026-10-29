import * as CopyButton from "@maple/web/ui/copy-button"
import * as FilterSections from "@maple/web/ui/filters/filter-sections"
import type { Block } from "foldkit"
import { ServicesDefinition } from "./definition"

/** The filter rail's open/closed sections, remembered across visits. */
export const FilterSectionsBinding = ServicesDefinition.makeBinding(FilterSections.FilterSectionsBlock, {
	field: "sections",
})

/** The empty state's connect guide: the OTLP endpoint field's copy button. */
export const EndpointCopyBinding = ServicesDefinition.makeBinding(CopyButton.CopyButtonBlock, { field: "endpointCopy" })

/** The empty state's connect guide: the exporter environment's copy button. */
export const EnvCopyBinding = ServicesDefinition.makeBinding(CopyButton.CopyButtonBlock, { field: "envCopy" })

export const ServicesComposition = ServicesDefinition.makeComposition({
	bindings: [FilterSectionsBinding, EndpointCopyBinding, EnvCopyBinding],
})
export type ServicesViewBuilder = Block.ViewBuilderFor<typeof ServicesComposition>
