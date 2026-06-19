import { Result } from "@/lib/effect-atom"
import { useNavigate } from "@tanstack/react-router"

import {
	FilterSection,
	SearchableFilterSection,
	SingleCheckboxFilter,
	type FilterOption,
} from "@/components/filters/filter-section"
import { Route } from "@/routes/replays"
import { Separator } from "@maple/ui/components/ui/separator"
import {
	FilterSidebarBody,
	FilterSidebarError,
	FilterSidebarFrame,
	FilterSidebarHeader,
	FilterSidebarLoading,
} from "@/components/filters/filter-sidebar"
import { formatBackendError } from "@/lib/error-messages"

interface ReplaysFacetItem {
	readonly name: string
	readonly count: number
}

interface ReplaysFacets {
	readonly services: ReadonlyArray<ReplaysFacetItem>
	readonly browsers: ReadonlyArray<ReplaysFacetItem>
	readonly countries: ReadonlyArray<ReplaysFacetItem>
	readonly devices: ReadonlyArray<ReplaysFacetItem>
	readonly errorCount: number
}

// The facet branches exclude their own dimension server-side, so a selected
// value can vanish from its own option list. Re-inject it (count 0) so it stays
// checkable/uncheckable rather than silently disappearing.
function withSelected(options: ReadonlyArray<ReplaysFacetItem>, selected?: string): FilterOption[] {
	const list = options.map((o) => ({ name: o.name, count: o.count }))
	if (selected && !list.some((o) => o.name === selected)) {
		list.unshift({ name: selected, count: 0 })
	}
	return list
}

interface ReplaysFilterSidebarProps {
	facetsResult: Result.Result<ReplaysFacets, unknown>
}

export function ReplaysFilterSidebar({ facetsResult }: ReplaysFilterSidebarProps) {
	const navigate = useNavigate({ from: Route.fullPath })
	const search = Route.useSearch()

	// Single-value params: take the last toggled option (switching dimensions
	// replaces the prior value; unchecking the only one clears it).
	const setSingle = (key: "service" | "browser" | "country" | "deviceType", values: string[]) => {
		navigate({
			search: (prev) => ({ ...prev, [key]: values.at(-1) ?? undefined }),
		})
	}

	const toggleHasErrors = (checked: boolean) => {
		navigate({
			search: (prev) => ({ ...prev, hasErrors: checked || undefined }),
		})
	}

	const clearAllFilters = () => {
		navigate({
			search: {
				startTime: search.startTime,
				endTime: search.endTime,
				timePreset: search.timePreset,
				q: search.q,
			},
		})
	}

	const hasActiveFilters =
		!!search.service ||
		!!search.browser ||
		!!search.country ||
		!!search.deviceType ||
		search.hasErrors === true

	return Result.builder(facetsResult)
		.onInitial(() => <FilterSidebarLoading sectionCount={5} />)
		.onError((error) => <FilterSidebarError message={formatBackendError(error).description} />)
		.onSuccess((facets, result) => {
			const services = withSelected(facets.services, search.service)
			const browsers = withSelected(facets.browsers, search.browser)
			const countries = withSelected(facets.countries, search.country)
			const devices = withSelected(facets.devices, search.deviceType)

			const hasFacets =
				services.length > 0 ||
				browsers.length > 0 ||
				countries.length > 0 ||
				devices.length > 0 ||
				facets.errorCount > 0

			return (
				<FilterSidebarFrame waiting={result.waiting}>
					<FilterSidebarHeader canClear={hasActiveFilters} onClear={clearAllFilters} />
					<FilterSidebarBody>
						<SingleCheckboxFilter
							title="Has errors"
							checked={search.hasErrors === true}
							onChange={toggleHasErrors}
							count={facets.errorCount}
						/>

						{services.length > 0 && (
							<>
								<Separator className="my-2" />
								<SearchableFilterSection
									title="Service"
									options={services}
									selected={search.service ? [search.service] : []}
									onChange={(vals) => setSingle("service", vals)}
								/>
							</>
						)}

						{browsers.length > 0 && (
							<>
								<Separator className="my-2" />
								<SearchableFilterSection
									title="Browser"
									options={browsers}
									selected={search.browser ? [search.browser] : []}
									onChange={(vals) => setSingle("browser", vals)}
								/>
							</>
						)}

						{devices.length > 0 && (
							<>
								<Separator className="my-2" />
								<FilterSection
									title="Device"
									options={devices}
									selected={search.deviceType ? [search.deviceType] : []}
									onChange={(vals) => setSingle("deviceType", vals)}
								/>
							</>
						)}

						{countries.length > 0 && (
							<>
								<Separator className="my-2" />
								<SearchableFilterSection
									title="Country"
									options={countries}
									selected={search.country ? [search.country] : []}
									onChange={(vals) => setSingle("country", vals)}
								/>
							</>
						)}

						{!hasFacets && (
							<p className="py-4 text-sm text-muted-foreground">
								No sessions in the selected time range
							</p>
						)}
					</FilterSidebarBody>
				</FilterSidebarFrame>
			)
		})
		.render()
}
