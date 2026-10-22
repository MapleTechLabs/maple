import { getServiceColor } from "@maple/ui/lib/colors"
import { filterSection, singleCheckboxFilter } from "@maple/web/ui/filters/filter-section"
import type * as FilterSections from "@maple/web/ui/filters/filter-sections"
import { filterSidebarBody, filterSidebarFrame, filterSidebarHeader } from "@maple/web/ui/filters/filter-sidebar"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { ErrorsFilters } from "./fetch"
import { Message } from "./message"
import type { Model } from "./model"

// The Errors page's filter rail.

const toSections = (message: FilterSections.Message) => Message.GotFilterSectionsMessage({ message })

export const sidebar = (h: HtmlBuilder<Message>, model: Model, filters: ErrorsFilters, activeFilterCount: number): Html => {
	const facets = Option.getOrNull(AsyncData.getData(model.facets.data))
	const isFetching = AsyncData.isLoading(model.facets.data) || AsyncData.isRefreshing(model.facets.data)
	const sections = [
		singleCheckboxFilter(h, {
			title: "Root spans only",
			isChecked: filters.rootOnly === true,
			onToggle: Message.ToggledRootOnly(),
		}),
		filterSection(h, {
			title: "Service",
			options: facets?.services ?? [],
			selected: filters.service ? [filters.service] : [],
			isSearchable: true,
			sections: model.sections,
			toSectionsMessage: toSections,
			onToggle: (name) => Message.ToggledFacetOption({ param: "service", name }),
			colorOf: getServiceColor,
		}),
		filterSection(h, {
			title: "Environment",
			options: facets?.environments ?? [],
			selected: filters.env ? [filters.env] : [],
			isSearchable: true,
			sections: model.sections,
			toSectionsMessage: toSections,
			onToggle: (name) => Message.ToggledFacetOption({ param: "env", name }),
		}),
	]
	return filterSidebarFrame(h, { className: "w-56 shrink-0 px-4", isWaiting: isFetching }, [
		filterSidebarHeader(h, activeFilterCount > 0 ? { onClear: Message.ClickedClearFilters() } : {}),
		...filterSidebarBody(
			h,
			"errors-filters",
			sections.filter((section) => section !== null),
		),
	])
}
