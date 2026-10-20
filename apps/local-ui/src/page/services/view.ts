import type * as CopyButton from "@maple/web/ui/copy-button"
import { filterSection } from "@maple/web/ui/filters/filter-section"
import type * as FilterSections from "@maple/web/ui/filters/filter-sections"
import { filterSidebarBody, filterSidebarFrame, filterSidebarHeader } from "@maple/web/ui/filters/filter-sidebar"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureWithoutData, isPending } from "../../data/slot"
import { queryOf } from "../../route"
import { rangeOf } from "../contract"
import type { PageViewInputs } from "../kit/inputs"
import { pageShell } from "../kit/page-shell"
import { signalEmptyState } from "../kit/signal-empty-state"
import { refreshButton, timeRangeSelect, toolbar, toolbarSearch, toolbarStat, toolbarStats } from "../kit/toolbar"
import { errorState } from "../kit/view-states"
import { activeFilterCount, facetsOf, filtersOf, type ServicesFilters, unfilteredSlot, visibleEntries } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { servicesSkeleton, servicesTable } from "./view-table"

// The services list page.

const toSections = (message: FilterSections.Message) => Message.GotFilterSectionsMessage({ message })
const toCopy = (id: string, message: CopyButton.Message) => Message.GotCopyMessage({ id, message })

const isFetching = (slot: Model["catalog"]) => AsyncData.isLoading(slot.data) || AsyncData.isRefreshing(slot.data)

const sidebar = (h: HtmlBuilder<Message>, model: Model, filters: ServicesFilters): Html => {
	const { envFacets, nsFacets } = facetsOf(model, filters)
	const facet = (title: string, param: "env" | "ns", options: typeof envFacets, selected: string | undefined) =>
		filterSection(h, {
			title,
			options,
			selected: selected ? [selected] : [],
			isSearchable: true,
			sections: model.sections,
			toSectionsMessage: toSections,
			onToggle: (name) => Message.ToggledFacetOption({ param, name }),
		})
	return filterSidebarFrame(
		h,
		{ className: "w-56 shrink-0 px-4", isWaiting: isFetching(model.catalog) || isFetching(unfilteredSlot(model, filters)) },
		[
			filterSidebarHeader(h, activeFilterCount(filters) > 0 ? { onClear: Message.ClickedClearFacets() } : {}),
			...filterSidebarBody(
				h,
				"services-filters",
				[facet("Environment", "env", envFacets, filters.env), facet("Namespace", "ns", nsFacets, filters.ns)].filter(
					(section) => section !== null,
				),
			),
		],
	)
}

const servicesToolbar = (h: HtmlBuilder<Message>, model: Model, inputs: PageViewInputs, count: number, errors: number) =>
	toolbar(h, [
		toolbarSearch(h, {
			id: "services-search",
			value: model.search.text,
			placeholder: "Filter by service name…",
			onInput: (text) => Message.ChangedSearch({ text }),
			onClear: Message.ClickedClearSearch(),
			className: "min-w-48 flex-1",
		}),
		toolbarStats(
			h,
			[
				toolbarStat(h, { value: count, label: "services" }),
				toolbarStat(h, { value: Math.round(errors), label: "errors", isDanger: true }),
				refreshButton(h, {
					isSpinning: model.isRefreshing,
					hasNewData: inputs.hasNewDataSince(model.catalogUpdatedAtMs),
					onRefresh: Message.ClickedRefresh(),
				}),
				timeRangeSelect(h, rangeOf(inputs.context), (range) => Message.ChangedRange({ range })),
			],
			"shrink-0",
		),
	])

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const { context } = inputs
	const query = queryOf(context.location)
	const filters = filtersOf(query)
	const count = activeFilterCount(filters)
	const entries = visibleEntries(model, filters)
	const totalErrorCount = entries.reduce((sum, entry) => sum + entry.errorCount, 0)
	const content = (): Html => {
		if (isPending(model.catalog)) return servicesSkeleton(h)
		const failure = failureWithoutData(model.catalog)
		if (Option.isSome(failure))
			return errorState(h, { label: "services", failure: failure.value, onRetry: Message.ClickedRefresh() })
		if (entries.length === 0)
			return signalEmptyState(h, {
				signal: "traces",
				noun: "services",
				isFiltered: count > 0 || filters.search !== undefined,
				onClearFilters: Message.ClickedClearFilters(),
				range: rangeOf(context),
				onWidenRange: Message.ClickedWidenRange(),
				maybePresence: inputs.presenceOf("traces"),
				nowMs: inputs.presenceNowMs,
				guide: { id: "services-empty", endpoint: context.env.otlpEndpoint, copies: model.copies, toCopyMessage: toCopy },
			})
		return servicesTable(h, entries, query, model.catalog.isPlaceholder)
	}
	return pageShell(
		h,
		{
			onOpenFilters: Message.ClickedOpenFilters(),
			sidebar: sidebar(h, model, filters),
			toolbar: servicesToolbar(h, model, inputs, entries.length, totalErrorCount),
			activeFilterCount: count,
		},
		[content()],
	)
})
