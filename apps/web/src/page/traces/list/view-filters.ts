import { getServiceColor } from "@maple/ui/lib/colors"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { filterSection, singleCheckboxFilter } from "../../../ui/filters/filter-section"
import * as FilterSections from "../../../ui/filters/filter-sections"
import {
	filterSidebarBody,
	filterSidebarEmpty,
	filterSidebarError,
	filterSidebarFrame,
	filterSidebarHeader,
	filterSidebarLoading,
} from "../../../ui/filters/filter-sidebar"
import { formatValue } from "../../../ui/filters/range-format"
import { type RangePreset, rangeFilterSection } from "../../../ui/filters/range-filter-section"
import { pinnedNamespaceNotice } from "../../kit/pinned-namespace-notice"
import { excludedOf, hasSidebarFilters } from "./derive"
import { type Facet, Message } from "./message"
import type { Model, TracesFacets } from "./model"

const toSections = (message: FilterSections.Message) => Message.GotFilterSectionsMessage({ message })

const facetSection = (
	h: HtmlBuilder<Message>,
	model: Model,
	title: string,
	facet: Facet,
	options: TracesFacets[Facet],
	extra: Readonly<{ isSearchable?: boolean; colorOf?: (name: string) => string }> = {},
) =>
	filterSection(h, {
		title,
		options,
		selected: model.search[facet] ?? [],
		excluded: model.search[excludedOf(facet)] ?? [],
		isSearchable: extra.isSearchable ?? false,
		colorOf: extra.colorOf,
		sections: model.filterSections,
		toSectionsMessage: toSections,
		onToggle: (name) => Message.ToggledFacetOption({ facet, name }),
		onOnly: (name) => Message.ClickedOnlyFacetOption({ facet, name }),
		onExclude: (name) => Message.ClickedExcludeFacetOption({ facet, name }),
	})

/** `DurationRangeFilter`: p50 and p95 presets from the facet stats, then "> 1s". */
const durationPresets = (stats: TracesFacets["durationStats"]): ReadonlyArray<RangePreset> => {
	const p50 = Math.round(stats.p50DurationMs)
	const p95 = Math.round(stats.p95DurationMs)
	return [
		...(stats.p50DurationMs > 0
			? [{ key: "p50", label: "> p50", value: formatValue(p50, "ms"), min: p50 }]
			: []),
		...(stats.p95DurationMs > 0
			? [{ key: "p95", label: "> p95", value: formatValue(p95, "ms"), min: p95 }]
			: []),
		{ key: "1s", label: "> 1s", min: 1000 },
	]
}

const loadedRail = (
	h: HtmlBuilder<Message>,
	model: Model,
	facets: TracesFacets,
	pinnedNamespace: string | null,
): Html => {
	const { search } = model
	const hasFilters = hasSidebarFilters(search)
	if (!hasFilters && facets.services.length === 0) return filterSidebarEmpty(h)
	const isRootOnly = search.rootOnly ?? true
	return filterSidebarFrame(h, { isWaiting: AsyncData.isRefreshing(model.facets.data) }, [
		filterSidebarHeader(h, hasFilters ? { onClear: Message.ClickedClearSidebarFilters() } : {}),
		...filterSidebarBody(h, "traces-filters", [
			singleCheckboxFilter(h, {
				title: "Has error",
				isChecked: search.hasError ?? false,
				onToggle: Message.ToggledHasError(),
				count: facets.errorCount,
			}),
			singleCheckboxFilter(h, {
				title: "Root traces only",
				isChecked: isRootOnly,
				onToggle: Message.ToggledRootOnly(),
			}),
			isRootOnly
				? singleCheckboxFilter(h, {
						title: "Hide Single-Span Noise",
						isChecked: search.hideNoise ?? true,
						onToggle: Message.ToggledHideNoise(),
					})
				: null,
			facetSection(h, model, "Environment", "deploymentEnvs", facets.deploymentEnvs),
			pinnedNamespace !== null
				? pinnedNamespaceNotice(h, pinnedNamespace, Message.ClickedClearNamespacePin())
				: facetSection(h, model, "Namespace", "namespaces", facets.namespaces, {
						isSearchable: true,
					}),
			facetSection(h, model, "Service", "services", facets.services, {
				isSearchable: true,
				colorOf: getServiceColor,
			}),
			facetSection(h, model, "Root span", "spanNames", facets.spanNames, { isSearchable: true }),
			rangeFilterSection(h, {
				title: "Duration",
				unit: "ms",
				minValue: search.minDurationMs,
				maxValue: search.maxDurationMs,
				draft: model.durationDraft,
				presets: durationPresets(facets.durationStats),
				ids: {
					panel: "traces-duration-panel",
					min: "traces-duration-min",
					max: "traces-duration-max",
				},
				sections: model.filterSections,
				toSectionsMessage: toSections,
				onDraftChange: (min, max) => Message.ChangedDurationDraft({ min, max }),
				onCommitDraft: Message.CommittedDurationDraft(),
				onApply: (min, max) => Message.AppliedDurationRange({ min, max }),
			}),
			facetSection(h, model, "HTTP method", "httpMethods", facets.httpMethods),
			facetSection(h, model, "Status code", "httpStatusCodes", facets.httpStatusCodes),
		]),
	])
}

export const filtersRail = (h: HtmlBuilder<Message>, model: Model, pinnedNamespace: string | null): Html =>
	AsyncData.matchData(model.facets.data, {
		onEmpty: () => filterSidebarLoading(h, 5),
		onFailure: (failure) =>
			filterSidebarError(h, failure, undefined, Option.getOrUndefined(AsyncData.getError(model.firstPage.data))),
		onData: (facets) => loadedRail(h, model, facets, pinnedNamespace),
	})
