import { getServiceColor } from "@maple/ui/lib/colors"
import { SEVERITY_COLORS } from "@maple/ui/lib/severity"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { isSameFailure, type LoadFailure } from "../../../data/load-failure"
import { kbd } from "../../../ui/display"
import { errorState } from "../../../ui/error-state"
import { eyebrow } from "../../../ui/eyebrow"
import * as FilterSections from "../../../ui/filters/filter-sections"
import { type FilterOption, filterSection } from "../../../ui/filters/filter-section"
import {
	filterSidebarBody,
	filterSidebarEmpty,
	filterSidebarFrame,
	filterSidebarHeader,
	filterSidebarLoading,
} from "../../../ui/filters/filter-sidebar"
import type * as Popover from "../../../ui/popover"
import { MountFilterRail } from "./command"
import { searchHelp } from "./view-search-help"
import { pinnedNamespaceNotice } from "../../kit/pinned-namespace-notice"
import type { Search } from "./derive"
import { type Facet, Message } from "./message"
import type { LogsFacets, Model } from "./model"
import { searchInput } from "../../../ui/search-input"

const toSections = (message: FilterSections.Message) => Message.GotFilterSectionsMessage({ message })

const EXCLUDED_OF = {
	severities: "excludedSeverities",
	deploymentEnvs: "excludedDeploymentEnvs",
	namespaces: "excludedNamespaces",
	services: "excludedServices",
} as const satisfies Record<Facet, string>

const facetSection = (
	h: HtmlBuilder<Message>,
	model: Model,
	title: string,
	facet: Facet,
	options: ReadonlyArray<FilterOption>,
	extra: Readonly<{ isSearchable?: boolean; colorOf?: (name: string) => string | undefined }> = {},
) =>
	filterSection(h, {
		title,
		options,
		selected: model.search[facet] ?? [],
		excluded: model.search[EXCLUDED_OF[facet]] ?? [],
		sections: model.filterSections,
		toSectionsMessage: toSections,
		onToggle: (name) => Message.ToggledFacetOption({ facet, name }),
		onOnly: (name) => Message.ClickedOnlyFacetOption({ facet, name }),
		onExclude: (name) => Message.ClickedExcludeFacetOption({ facet, name }),
		...extra,
	})

/** Any filter narrowing the stream, the search and trace scope included. */
export const hasActiveFilters = (search: Search): boolean =>
	[
		search.services,
		search.severities,
		search.deploymentEnvs,
		search.namespaces,
		search.excludedServices,
		search.excludedSeverities,
		search.excludedDeploymentEnvs,
		search.excludedNamespaces,
		search.attrs,
	].some((values) => (values?.length ?? 0) > 0) ||
	!!search.search ||
	!!search.traceId

/** `LogSearchInput`: one box for text and trace ids (`parseLogSearch`), `/` focuses it. */
const logSearchInput = (h: HtmlBuilder<Message>, value: string, help: Popover.Model): Html =>
	h.div(
		[h.Class("pb-3")],
		[
			h.div(
				[h.Class("flex items-center gap-1")],
				[eyebrow(h, { variant: "label" }, ["Search"]), searchHelp(h, help)],
			),
			searchInput(h, {
				id: "logs-search-input",
				size: "sm",
				className: "mt-2",
				placeholder: "Text or trace id",
				value,
				onInput: (text) => Message.ChangedSearchText({ text }),
				onClear: Message.ChangedSearchText({ text: "" }),
				trailing: value === "" ? [kbd(h, undefined, ["/"])] : [],
				attributes: [h.DataAttribute("shortcut-focus", "search")],
			}),
		],
	)

/**
 * The facets failed: the search stays, so the page keeps its shape and a query can still be typed.
 * The main panel explains a shared failure, so the rail only notes it.
 */
const failedRail = (h: HtmlBuilder<Message>, model: Model, failure: LoadFailure): Html => {
	const main = Option.getOrUndefined(AsyncData.getError(model.firstPage.data))
	const isEchoed = main !== undefined && isSameFailure(main, failure)
	return filterSidebarFrame(h, {}, [
		filterSidebarHeader(h),
		...filterSidebarBody(h, "logs-filters", [
			logSearchInput(h, model.searchText, model.searchHelp),
			isEchoed
				? errorState(h, {
						failure,
						onRetry: Message.ClickedRetryFacets(),
						variant: "quiet",
						title: "Filters unavailable",
						hidesRetryButton: true,
					})
				: errorState(h, { failure, onRetry: Message.ClickedRetryFacets(), variant: "inline" }),
		]),
	])
}

const loadedRail = (
	h: HtmlBuilder<Message>,
	model: Model,
	facets: LogsFacets,
	pinnedNamespace: string | null,
) => {
	const isFiltered = hasActiveFilters(model.search)
	const hasFacets =
		facets.services.length > 0 ||
		facets.severities.length > 0 ||
		facets.deploymentEnvs.length > 0 ||
		facets.namespaces.length > 0
	if (!hasFacets && !isFiltered) return filterSidebarEmpty(h)
	return filterSidebarFrame(h, { isWaiting: AsyncData.isRefreshing(model.facets.data) }, [
		filterSidebarHeader(h, isFiltered ? { onClear: Message.ClickedClearAllFilters() } : {}),
		...filterSidebarBody(h, "logs-filters", [
			logSearchInput(h, model.searchText, model.searchHelp),
			facetSection(h, model, "Severity", "severities", facets.severities, {
				colorOf: (name) => SEVERITY_COLORS[name],
			}),
			facetSection(h, model, "Environment", "deploymentEnvs", facets.deploymentEnvs),
			pinnedNamespace !== null
				? pinnedNamespaceNotice(h, pinnedNamespace, Message.ClickedClearNamespacePin())
				: facetSection(h, model, "Namespace", "namespaces", facets.namespaces, {
						isSearchable: true,
					}),
			facetSection(h, model, "Service", "services", facets.services, {
				isSearchable: true,
				// `serviceColorMap` covers the facet's services only: a selected unknown one has no swatch.
				colorOf: (name) =>
					facets.services.some((option) => option.name === name)
						? getServiceColor(name)
						: undefined,
			}),
		]),
	])
}

/** `LogsFilterSidebar`; its Mount asks for the facets once the rail is actually rendered. */
export const filtersRail = (h: HtmlBuilder<Message>, model: Model, pinnedNamespace: string | null): Html =>
	h.div(
		[h.Class("contents"), h.OnMount(MountFilterRail())],
		[
			AsyncData.matchData(model.facets.data, {
				onEmpty: () => filterSidebarLoading(h, 3),
				onFailure: (failure) => failedRail(h, model, failure),
				onData: (facets) => loadedRail(h, model, facets, pinnedNamespace),
			}),
		],
	)
