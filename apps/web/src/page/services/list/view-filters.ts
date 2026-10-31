import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as FilterSections from "../../../ui/filters/filter-sections"
import { filterSection } from "../../../ui/filters/filter-section"
import {
	filterSidebarBody,
	filterSidebarEmpty,
	filterSidebarError,
	filterSidebarFrame,
	filterSidebarHeader,
	filterSidebarLoading,
} from "../../../ui/filters/filter-sidebar"
import { pinnedNamespaceNotice } from "../../kit/pinned-namespace-notice"
import { HEALTH_LEVELS, hasActiveServiceFilters, type HealthSummary } from "./derive"
import { type Facet, Message } from "./message"
import type { Model, ServicesFacets } from "./model"

const toSections = (message: FilterSections.Message) => Message.GotFilterSectionsMessage({ message })

const facetSection = (
	h: HtmlBuilder<Message>,
	model: Model,
	title: string,
	facet: Facet,
	options: ServicesFacets[Facet],
	excluded: ReadonlyArray<string> | undefined,
	isSearchable = false,
) =>
	filterSection(h, {
		title,
		options,
		selected: model.search[facet] ?? [],
		excluded: excluded ?? [],
		isSearchable,
		sections: model.filterSections,
		toSectionsMessage: toSections,
		onToggle: (name) => Message.ToggledFacetOption({ facet, name }),
		onOnly: (name) => Message.ClickedOnlyFacetOption({ facet, name }),
		onExclude: (name) => Message.ClickedExcludeFacetOption({ facet, name }),
	})

const loadedRail = (
	h: HtmlBuilder<Message>,
	model: Model,
	facets: ServicesFacets,
	summary: HealthSummary | undefined,
	pinnedNamespace: string | null,
): Html => {
	const { search } = model
	const hasFilters = hasActiveServiceFilters(search)
	if (
		!hasFilters &&
		summary === undefined &&
		facets.environments.length === 0 &&
		facets.namespaces.length === 0 &&
		facets.commitShas.length === 0
	) {
		return filterSidebarEmpty(h)
	}
	return filterSidebarFrame(h, { isWaiting: AsyncData.isRefreshing(model.facets.data) }, [
		filterSidebarHeader(h, hasFilters ? { onClear: Message.ClickedClearAllFilters() } : {}),
		...filterSidebarBody(h, "services-filters", [
			...(summary === undefined
				? []
				: [
						filterSection(h, {
							title: "Health",
							options: HEALTH_LEVELS.map((level) => ({
								name: level,
								count: summary.counts[level],
							})),
							selected: search.health === undefined ? [] : [search.health],
							sections: model.filterSections,
							toSectionsMessage: toSections,
							onToggle: (name) => Message.ToggledHealthOption({ name }),
						}),
					]),
			facetSection(
				h,
				model,
				"Environment",
				"environments",
				facets.environments,
				search.excludedEnvironments,
			),
			pinnedNamespace !== null
				? pinnedNamespaceNotice(h, pinnedNamespace, Message.ClickedClearNamespacePin())
				: facets.namespaces.length > 0
					? facetSection(
							h,
							model,
							"Namespace",
							"namespaces",
							facets.namespaces,
							search.excludedNamespaces,
							true,
						)
					: null,
			facetSection(h, model, "Commit SHA", "commitShas", facets.commitShas, search.excludedCommitShas),
		]),
	])
}

export const filtersRail = (
	h: HtmlBuilder<Message>,
	model: Model,
	summary: HealthSummary | undefined,
	pinnedNamespace: string | null,
): Html =>
	AsyncData.matchData(model.facets.data, {
		onEmpty: () => filterSidebarLoading(h, 3),
		onFailure: (failure) =>
			filterSidebarError(
				h,
				failure,
				Message.ClickedRetryFacets(),
				Option.getOrUndefined(AsyncData.getError(model.overview.data)),
			),
		onData: (facets) => loadedRail(h, model, facets, summary, pinnedNamespace),
	})
