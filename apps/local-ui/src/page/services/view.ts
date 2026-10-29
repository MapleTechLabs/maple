import type * as CopyButton from "@maple/web/ui/copy-button"
import { filterSection } from "@maple/web/ui/filters/filter-section"
import type * as FilterSections from "@maple/web/ui/filters/filter-sections"
import { filterSidebarBody, filterSidebarFrame, filterSidebarHeader } from "@maple/web/ui/filters/filter-sidebar"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html } from "foldkit/html"
import { presenceOf, type PresenceResult } from "../../data/signal-presence"
import { failureWithoutData, isPending } from "../../data/slot"
import { queryOf } from "../../route"
import { type PageContext, rangeOf } from "../contract"
import { pageShell } from "../kit/page-shell"
import { signalEmptyState } from "../kit/signal-empty-state"
import { refreshButton, timeRangeSelect, toolbar, toolbarSearch, toolbarStat, toolbarStats } from "../kit/toolbar"
import { errorState } from "../kit/view-states"
import { activeFilterCount, facetsOf, filtersOf, type ServicesFilters, unfilteredSlot, visibleEntries } from "./derive"
import {
	EndpointCopyBinding,
	EnvCopyBinding,
	FilterSectionsBinding,
	ServicesComposition,
	type ServicesViewBuilder,
} from "./composition"
import { Message } from "./message"
import type { Model } from "./model"
import { servicesSkeleton, servicesTable } from "./view-table"

// The services list page.

/** What the view reads from the root: data only, as Block view inputs carry no callbacks. */
export type ServicesViewInputs = Readonly<{
	context: PageContext
	/** The shared signal presence read (`useSignalPresence`): none while loading or unreadable. */
	maybePresence: Option.Option<PresenceResult>
	/** The server's last ingest, for `useNewDataSince`'s "New data" pill. */
	lastIngestAtMs: Option.Option<number>
}>

/** `useNewDataSince(sinceMs)`: telemetry arrived after the list loaded. */
const hasNewDataSince = (inputs: ServicesViewInputs, sinceMs: number): boolean =>
	sinceMs > 0 && Option.exists(inputs.lastIngestAtMs, (last) => last > sinceMs)

const GUIDE_ID = "services-empty"

/** The connect guide's copy buttons are this page's own Blocks. */
const embedGuideCopy =
	(h: ServicesViewBuilder, model: Model) =>
	(slot: "endpoint" | "env", viewInputs: CopyButton.CopyButtonViewInputs): Html =>
		slot === "endpoint"
			? h.block(EndpointCopyBinding.embedView({ slotId: `${GUIDE_ID}-endpoint`, model: model.endpointCopy, viewInputs }))
			: h.block(EnvCopyBinding.embedView({ slotId: `${GUIDE_ID}-env`, model: model.envCopy, viewInputs }))

/** Each section's open/closed state is the remembered sections Block's own. */
const embedSection = (h: ServicesViewBuilder, model: Model) => (viewInputs: FilterSections.ViewInputs) =>
	h.block(
		FilterSectionsBinding.embedView({ slotId: `filter-section-${viewInputs.key}`, model: model.sections, viewInputs }),
	)

const isFetching = (slot: Model["catalog"]) => AsyncData.isLoading(slot.data) || AsyncData.isRefreshing(slot.data)

const sidebar = (h: ServicesViewBuilder, model: Model, filters: ServicesFilters): Html => {
	const { envFacets, nsFacets } = facetsOf(model, filters)
	const facet = (title: string, param: "env" | "ns", options: typeof envFacets, selected: string | undefined) =>
		filterSection(h, {
			title,
			options,
			selected: selected ? [selected] : [],
			isSearchable: true,
			embedSection: embedSection(h, model),
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

const servicesToolbar = (h: ServicesViewBuilder, model: Model, inputs: ServicesViewInputs, count: number, errors: number) =>
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
					hasNewData: hasNewDataSince(inputs, model.catalogUpdatedAtMs),
					onRefresh: Message.ClickedRefresh(),
				}),
				timeRangeSelect(h, rangeOf(inputs.context), (range) => Message.ChangedRange({ range })),
			],
			"shrink-0",
		),
	])

export const view = ServicesComposition.makeView.withInputs<ServicesViewInputs>((model, inputs, h) => {
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
				maybePresence: presenceOf(inputs.maybePresence, "traces"),
				nowMs: Option.match(inputs.maybePresence, { onNone: () => 0, onSome: (result) => result.nowMs }),
				guide: { id: GUIDE_ID, endpoint: context.env.otlpEndpoint, embedCopy: embedGuideCopy(h, model) },
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
