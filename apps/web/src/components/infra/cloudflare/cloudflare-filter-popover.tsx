import { Button } from "@maple/ui/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@maple/ui/components/ui/popover"
import type { CloudflareInfraZoneFacetsResponse } from "@maple/domain/http"

import type { Result } from "@/lib/effect-atom"
import { CloudflareFilterSidebarView } from "./cloudflare-filter-sidebar"
import type { CloudflareFilters } from "./filters"

/**
 * Every facet the old filter rail offered, behind one button. The breakdown table covers the
 * common case (click a path or host); this is for the dimensions it doesn't list.
 */
export function CloudflareFilterPopover({
	facetsResult,
	filters,
	onFilterChange,
	onClearFilters,
}: {
	facetsResult: Result.Result<CloudflareInfraZoneFacetsResponse, unknown>
	filters: CloudflareFilters
	onFilterChange: <K extends keyof CloudflareFilters>(key: K, value: CloudflareFilters[K]) => void
	onClearFilters: () => void
}) {
	return (
		<Popover>
			<PopoverTrigger
				render={
					<Button
						variant="outline"
						size="xs"
						className="h-6 border-dashed font-mono text-2xs font-normal"
					/>
				}
			>
				+ Filter
			</PopoverTrigger>
			<PopoverContent align="start" className="max-h-[70vh] w-72 overflow-y-auto p-0">
				<CloudflareFilterSidebarView
					facetsResult={facetsResult}
					filters={filters}
					onFilterChange={onFilterChange}
					onClearFilters={onClearFilters}
				/>
			</PopoverContent>
		</Popover>
	)
}
