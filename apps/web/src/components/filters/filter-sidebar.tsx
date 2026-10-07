// Frame/header/body/loading are promoted to @maple/ui (shared with the local-mode UI).
// FilterSidebarError stays here: it binds the app's ErrorState.
import { Separator } from "@maple/ui/components/ui/separator"
import { FilterSidebarFrame, FilterSidebarHeader } from "@maple/ui/components/filters/filter-sidebar"
import { ErrorState } from "@/components/common/error-state"

export {
	FilterSidebarFrame,
	FilterSidebarHeader,
	FilterSidebarBody,
	FilterSidebarLoading,
	FilterSidebarEmpty,
} from "@maple/ui/components/filters/filter-sidebar"

interface FilterSidebarErrorProps {
	error: unknown
	onRetry?: () => void
}

export function FilterSidebarError({ error, onRetry }: FilterSidebarErrorProps) {
	return (
		<FilterSidebarFrame>
			<FilterSidebarHeader />
			<Separator className="my-2" />
			<ErrorState error={error} onRetry={onRetry} variant="inline" />
		</FilterSidebarFrame>
	)
}

/**
 * True when every list among a facets response's values is empty, i.e. there is nothing to offer
 * as a filter. Takes `Object.values(facets)` so non-list fields (counts, stats) are simply skipped.
 */
export function hasNoFacetOptions(values: ReadonlyArray<unknown>): boolean {
	return values.every((value) => !Array.isArray(value) || value.length === 0)
}
