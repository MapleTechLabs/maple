import type { AnomalyIncidentDocument } from "@maple/domain/http"
import { getServiceColor } from "@maple/ui/lib/colors"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as FilterSections from "../../../ui/filters/filter-sections"
import { type FilterOption, filterSection } from "../../../ui/filters/filter-section"
import {
	filterSidebarBody,
	filterSidebarEmpty,
	filterSidebarFrame,
	filterSidebarHeader,
	filterSidebarLoading,
} from "../../../ui/filters/filter-sidebar"
import { facetsOf, filtersOf, hasAnomalyFilters } from "./derive"
import { type Facet, Message } from "./message"
import type { Model } from "./model"

// `AnomaliesFilterSidebar`: the list's filter rail.

type H = HtmlBuilder<Message>

const toSections = (message: FilterSections.Message) => Message.GotFilterSectionsMessage({ message })

const options = (entries: ReadonlyArray<readonly [string, number]>): ReadonlyArray<FilterOption> =>
	entries.map(([name, count]) => ({ name, count }))

export const filtersRail = (
	h: H,
	model: Model,
	incidents: ReadonlyArray<AnomalyIncidentDocument>,
	isLoading: boolean,
): Html => {
	const filters = filtersOf(model.search)
	const hasFilters = hasAnomalyFilters(filters)
	if (isLoading) return filterSidebarLoading(h, 4)
	if (incidents.length === 0 && !hasFilters) return filterSidebarEmpty(h)
	const facets = facetsOf(incidents)
	const section = (
		title: string,
		facet: Facet,
		entries: ReadonlyArray<readonly [string, number]>,
		extra: Partial<Parameters<typeof filterSection<Message>>[1]> = {},
	) =>
		filterSection(h, {
			title,
			options: options(entries),
			selected: model.search[facet] ?? [],
			excluded:
				(facet === "severity"
					? model.search.excludedSeverity
					: facet === "signals"
						? model.search.excludedSignals
						: facet === "services"
							? model.search.excludedServices
							: model.search.excludedEnvs) ?? [],
			sections: model.filterSections,
			toSectionsMessage: toSections,
			onToggle: (name) => Message.ToggledFacetOption({ facet, name }),
			onOnly: (name) => Message.ClickedOnlyFacetOption({ facet, name }),
			onExclude: (name) => Message.ClickedExcludeFacetOption({ facet, name }),
			...extra,
		})
	return filterSidebarFrame(h, { isWaiting: false }, [
		filterSidebarHeader(h, hasFilters ? { onClear: Message.ClickedClearFilters() } : {}),
		...filterSidebarBody(
			h,
			"anomalies-filters",
			[
				section("Severity", "severity", facets.severity, { getOptionLabel: facets.severityLabel }),
				section("Signal", "signals", facets.signals, { getOptionLabel: facets.signalLabel }),
				section("Service", "services", facets.services, { colorOf: (name) => getServiceColor(name) }),
				section("Environment", "envs", facets.envs),
			].filter((node): node is Html => node !== null),
		),
	])
}
