// Cloudflare zone filter sidebar. Same shape as the Kubernetes sidebars —
// server-computed facets, ranked by traffic rather than entity count, each
// facet listing all of its own values so picking one host doesn't hide the rest.

import type { Result } from "@/lib/effect-atom"
import { ResultView } from "@/components/common/result-view"

import { FilterSection, SearchableFilterSection } from "@/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarEmpty,
	FilterSidebarError,
	FilterSidebarFrame,
	FilterSidebarHeader,
	FilterSidebarLoading,
	hasNoFacetOptions,
} from "@/components/filters/filter-sidebar"
import type { CloudflareInfraZoneFacetsResponse } from "@maple/domain/http"
import { CACHE_STATUS_COLORS, STATUS_CLASS_COLORS } from "./constants"
import { hasActiveFilters, type CloudflareFilters } from "./filters"

interface CloudflareFilterSidebarProps {
	facetsResult: Result.Result<CloudflareInfraZoneFacetsResponse, unknown>
	filters: CloudflareFilters
	onFilterChange: <K extends keyof CloudflareFilters>(key: K, value: CloudflareFilters[K]) => void
	onClearFilters: () => void
}

export function CloudflareFilterSidebarView({
	facetsResult,
	filters,
	onFilterChange,
	onClearFilters,
}: CloudflareFilterSidebarProps) {
	return (
		<ResultView
			result={facetsResult}
			loading={<FilterSidebarLoading sectionCount={6} />}
			error={(error) => <FilterSidebarError error={error} />}
		>
			{(response, { waiting }) => {
				const f = response.data
				if (!hasActiveFilters(filters) && hasNoFacetOptions(Object.values(f))) {
					return <FilterSidebarEmpty />
				}

				return (
					<FilterSidebarFrame waiting={waiting}>
						<FilterSidebarHeader canClear={hasActiveFilters(filters)} onClear={onClearFilters} />
						<FilterSidebarBody>
							<SearchableFilterSection
								title="Path"
								options={f.paths}
								selected={filters.paths ?? []}
								onChange={(val) => onFilterChange("paths", val)}
								defaultOpen
							/>
							<SearchableFilterSection
								title="Host"
								options={f.hosts}
								selected={filters.hosts ?? []}
								onChange={(val) => onFilterChange("hosts", val)}
								defaultOpen
							/>
							<FilterSection
								title="Status class"
								options={f.statusClasses}
								selected={filters.statusClasses ?? []}
								onChange={(val) => onFilterChange("statusClasses", val)}
								colorMap={STATUS_CLASS_COLORS}
							/>
							<FilterSection
								title="Cache status"
								options={f.cacheStatuses}
								selected={filters.cacheStatuses ?? []}
								onChange={(val) => onFilterChange("cacheStatuses", val)}
								colorMap={CACHE_STATUS_COLORS}
							/>
							<SearchableFilterSection
								title="Country"
								options={f.countries}
								selected={filters.countries ?? []}
								onChange={(val) => onFilterChange("countries", val)}
								defaultOpen={false}
							/>
							<FilterSection
								title="Method"
								options={f.methods}
								selected={filters.methods ?? []}
								onChange={(val) => onFilterChange("methods", val)}
								defaultOpen={false}
							/>
							<FilterSection
								title="Protocol"
								options={f.protocols}
								selected={filters.protocols ?? []}
								onChange={(val) => onFilterChange("protocols", val)}
								defaultOpen={false}
								getOptionLabel={(name) => (name === "unknown" ? name : `HTTP/${name}`)}
							/>
							<FilterSection
								title="Device"
								options={f.deviceTypes}
								selected={filters.deviceTypes ?? []}
								onChange={(val) => onFilterChange("deviceTypes", val)}
								defaultOpen={false}
							/>
						</FilterSidebarBody>
					</FilterSidebarFrame>
				)
			}}
		</ResultView>
	)
}
