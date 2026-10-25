import { getServiceColor } from "@maple/ui/lib/colors"
import { filterSection, singleCheckboxFilter } from "@maple/web/ui/filters/filter-section"
import type * as FilterSections from "@maple/web/ui/filters/filter-sections"
import { filterSidebarBody, filterSidebarFrame, filterSidebarHeader } from "@maple/web/ui/filters/filter-sidebar"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { SessionFilters } from "./fetch"
import { type FacetParam, Message } from "./message"
import type { FacetOption, Model, SessionFacets } from "./model"

// The filter rail of the sessions list.

const toSections = (message: FilterSections.Message) => Message.GotFilterSectionsMessage({ message })

/** `placeholderData: previous ?? EMPTY_FACETS`: a first load counts zero, a failure shows nothing. */
const EMPTY_FACETS: SessionFacets = { service: [], browser: [], device: [], errorCount: 0 }

/** `withSelected`: re-inject a selected value the server-side facet branch excluded. */
const withSelected = (options: ReadonlyArray<FacetOption>, selected?: string): ReadonlyArray<FacetOption> =>
	selected && !options.some((option) => option.name === selected) ? [{ name: selected, count: 0 }, ...options] : options

const facet = (
	h: HtmlBuilder<Message>,
	model: Model,
	title: string,
	param: FacetParam,
	options: ReadonlyArray<FacetOption>,
	selected: string | undefined,
	extra: Readonly<{ isSearchable?: boolean; colorOf?: (name: string) => string }> = {},
): Html | null =>
	filterSection(h, {
		title,
		options,
		selected: selected ? [selected] : [],
		isSearchable: extra.isSearchable ?? false,
		colorOf: extra.colorOf,
		sections: model.sections,
		toSectionsMessage: toSections,
		onToggle: (name) => Message.ToggledFacetOption({ param, name }),
	})

export const sidebar = (h: HtmlBuilder<Message>, model: Model, filters: SessionFilters, hasActiveFilters: boolean): Html => {
	const facets = AsyncData.isFailure(model.facets.data)
		? null
		: Option.getOrElse(AsyncData.getData(model.facets.data), () => EMPTY_FACETS)
	const isFetching = AsyncData.isLoading(model.facets.data) || AsyncData.isRefreshing(model.facets.data)
	const sections = [
		singleCheckboxFilter(h, {
			title: "Has errors",
			isChecked: filters.errorsOnly === true,
			onToggle: Message.ToggledErrorsOnly(),
			count: facets?.errorCount,
		}),
		facet(h, model, "Service", "service", facets ? withSelected(facets.service, filters.service) : [], filters.service, {
			isSearchable: true,
			colorOf: getServiceColor,
		}),
		facet(h, model, "Browser", "browser", facets ? withSelected(facets.browser, filters.browser) : [], filters.browser, {
			isSearchable: true,
		}),
		facet(h, model, "Device", "device", facets ? withSelected(facets.device, filters.device) : [], filters.device),
	]
	return filterSidebarFrame(h, { className: "w-56 shrink-0 px-4", isWaiting: isFetching }, [
		filterSidebarHeader(h, hasActiveFilters ? { onClear: Message.ClickedClearFilters() } : {}),
		...filterSidebarBody(
			h,
			"sessions-filters",
			sections.filter((section) => section !== null),
		),
	])
}
