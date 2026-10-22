import { isReleaseHealth, RELEASE_HEALTH_ORDER } from "../../../components/releases/release-model"
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
import { statusDot } from "../../../ui/status-dot"
import { RELEASE_HEALTH_DESCRIPTION, RELEASE_HEALTH_DOT_CLASS, RELEASE_HEALTH_LABEL } from "../kit"
import { facetsOf, hasFilters } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

// The releases filter sidebar: every facet
// derives from the releases read the table uses.

type H = HtmlBuilder<Message>

const toSections = (message: FilterSections.Message) => Message.GotFilterSectionsMessage({ message })

export const filtersRail = (h: H, model: Model): Html =>
	AsyncData.match(model.releases.data, {
		onIdle: () => filterSidebarLoading(h, 3),
		onLoading: () => filterSidebarLoading(h, 3),
		onFailure: (failure) => filterSidebarError(h, failure, Message.ClickedRetry()),
		onStale: ({ error }) => filterSidebarError(h, error, Message.ClickedRetry()),
		onSuccess: (data) => rail(h, model, data, false),
		onRefreshing: (data) => rail(h, model, data, true),
	})

const rail = (h: H, model: Model, data: Parameters<typeof facetsOf>[0], isWaiting: boolean): Html => {
	const { search } = model
	const facets = facetsOf(data)
	const isFiltered = hasFilters(search)
	if (!isFiltered && facets.services.length === 0 && facets.environments.length === 0)
		return filterSidebarEmpty(h)
	return filterSidebarFrame(h, { isWaiting }, [
		filterSidebarHeader(h, isFiltered ? { onClear: Message.ClickedClearFilters() } : {}),
		...filterSidebarBody(
			h,
			"releases-filters",
			[
				filterSection(h, {
					title: "Health",
					options: RELEASE_HEALTH_ORDER.map((band) => ({ name: band, count: facets.health[band] })),
					selected: search.impact === undefined ? [] : [search.impact],
					sections: model.filterSections,
					toSectionsMessage: toSections,
					onToggle: (name) => Message.ToggledHealthOption({ name }),
					getOptionLabel: (name) => (isReleaseHealth(name) ? RELEASE_HEALTH_LABEL[name] : name),
					getOptionDescription: (name) =>
						isReleaseHealth(name) ? RELEASE_HEALTH_DESCRIPTION[name] : undefined,
					renderOptionIcon: (name) =>
						isReleaseHealth(name)
							? statusDot(h, {
									tone: "custom",
									size: "lg",
									className: RELEASE_HEALTH_DOT_CLASS[name],
								})
							: undefined,
				}),
				filterSection(h, {
					title: "Environment",
					options: facets.environments,
					selected: search.environments ?? [],
					excluded: search.excludedEnvironments ?? [],
					sections: model.filterSections,
					toSectionsMessage: toSections,
					onToggle: (name) => Message.ToggledEnvironment({ name }),
					onOnly: (name) => Message.ClickedOnlyEnvironment({ name }),
					onExclude: (name) => Message.ClickedExcludeEnvironment({ name }),
				}),
				filterSection(h, {
					title: "Service",
					options: facets.services,
					selected: search.services ?? [],
					isSearchable: true,
					sections: model.filterSections,
					toSectionsMessage: toSections,
					onToggle: (name) => Message.ToggledService({ name }),
				}),
			].filter((node): node is Html => node !== null),
		),
	])
}
