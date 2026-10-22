import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { filterSection } from "../../../../ui/filters/filter-section"
import * as FilterSections from "../../../../ui/filters/filter-sections"
import {
	filterSidebarBody,
	filterSidebarEmpty,
	filterSidebarError,
	filterSidebarFrame,
	filterSidebarHeader,
	filterSidebarLoading,
} from "../../../../ui/filters/filter-sidebar"
import { EXCLUDED_OF, filtersOf } from "./update"
import { type Facet, Message } from "./message"
import type { ContainerFacets, Model } from "./model"

// `ContainersFilterSidebarView`.

type H = HtmlBuilder<Message>

const toSections = (message: FilterSections.Message) => Message.GotFilterSectionsMessage({ message })

const SECTIONS: ReadonlyArray<
	Readonly<{
		title: string
		facet: Facet
		options: keyof ContainerFacets
		isSearchable: boolean
		defaultOpen: boolean
	}>
> = [
	{
		title: "Container",
		facet: "containerNames",
		options: "containers",
		isSearchable: true,
		defaultOpen: true,
	},
	{ title: "Image", facet: "images", options: "images", isSearchable: true, defaultOpen: false },
	{ title: "Host", facet: "hostNames", options: "hosts", isSearchable: true, defaultOpen: false },
	{
		title: "Compose project",
		facet: "composeProjects",
		options: "composeProjects",
		isSearchable: false,
		defaultOpen: false,
	},
	{
		title: "Compose service",
		facet: "composeServices",
		options: "composeServices",
		isSearchable: false,
		defaultOpen: false,
	},
	{
		title: "Environment",
		facet: "environments",
		options: "environments",
		isSearchable: false,
		defaultOpen: false,
	},
]

const loadedRail = (h: H, model: Model, facets: ContainerFacets): Html => {
	const hasFilters = Object.values(filtersOf(model.search)).some((values) => (values?.length ?? 0) > 0)
	if (!hasFilters && Object.values(facets).every((options) => options.length === 0))
		return filterSidebarEmpty(h)
	return filterSidebarFrame(h, { isWaiting: AsyncData.isRefreshing(model.facets.data) }, [
		filterSidebarHeader(h, hasFilters ? { onClear: Message.ClickedClearFilters() } : {}),
		...filterSidebarBody(
			h,
			"containers-filters",
			SECTIONS.map((section) =>
				filterSection(h, {
					title: section.title,
					options: facets[section.options],
					selected: model.search[section.facet] ?? [],
					excluded: model.search[EXCLUDED_OF[section.facet]] ?? [],
					isSearchable: section.isSearchable,
					defaultOpen: section.defaultOpen,
					sections: model.filterSections,
					toSectionsMessage: toSections,
					onToggle: (name) => Message.ToggledFacetOption({ facet: section.facet, name }),
					onOnly: (name) => Message.ClickedOnlyFacetOption({ facet: section.facet, name }),
					onExclude: (name) => Message.ClickedExcludeFacetOption({ facet: section.facet, name }),
				}),
			),
		),
	])
}

export const filtersRail = (h: H, model: Model): Html =>
	AsyncData.matchData(model.facets.data, {
		onEmpty: () => filterSidebarLoading(h, 6),
		onFailure: (failure) => filterSidebarError(h, failure),
		onData: (facets) => loadedRail(h, model, facets),
	})
