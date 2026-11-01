import { pluralize } from "@maple/ui/lib/format"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { errorState } from "../../../ui/error-state"
import { filterChip } from "../../../ui/filter-chip"
import { activeFilterChips } from "../../../ui/filters/active-filter-chips"
import { skeleton } from "../../../ui/skeleton"
import * as TabsView from "../../../ui/tabs-view"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { listToolbar, toolbarCount } from "../../kit/list-toolbar"
import {
	allIncidentsOf,
	anomalyFilterChips,
	filteredOf,
	filtersOf,
	hasAnomalyFilters,
	isLiveOf,
	nextCursorOf,
	statusOf,
} from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { filtersRail } from "./view-filters"
import { listBody } from "./view-list"

// The anomalies page.
// TODO(tooltip): the Live chip's "Auto-refreshing every 15s" tooltip popup.

type H = HtmlBuilder<Message>

const TAB_LABELS = ["Open", "Resolved", "All"]

const liveChip = (h: H, isLive: boolean): Html =>
	filterChip(
		h,
		{
			isPressed: isLive,
			onClick: Message.ToggledLive(),
			tone: "ok",
			hasDot: true,
			slot: "tooltip-trigger",
			attributes: [h.DataAttribute("base-ui-tooltip-trigger", "")],
		},
		[isLive ? "Live" : "Paused"],
	)

/** `ListToolbar`: the status tabs and the count readout. */
// The sticky area pads the page edge, so the toolbar adds no gap under itself.
const toolbar = (h: H, model: Model, count: number | null): Html =>
	listToolbar(h, {
		className: "pb-0",
		leading: h.submodel({
			slotId: "anomalies-status-tabs",
			model: model.tabs,
			view: TabsView.view,
			viewInputs: {
				labels: TAB_LABELS,
				ariaLabel: "Filter anomalies",
				tabClassName: "group/tab h-7 grow-0 px-2.5 text-xs sm:h-7 sm:text-xs",
				panel: () => undefined,
			},
			toParentMessage: (message) => Message.GotTabsMessage({ message }),
		}),
		trailing:
			count === null
				? []
				: [toolbarCount(h, [String(count), " ", pluralize(count, "anomaly", "anomalies")])],
	})

const SKELETON_WIDTHS = ["w-24", "w-20", "w-28", "w-16", "w-24", "w-20"]

/** The list before its first page: a group header and rows in the lanes `anomalyRow` draws. */
const listSkeleton = (h: H): Html =>
	h.div(
		[h.AriaBusy(true), h.AriaLabel("Loading anomalies")],
		[
			h.div(
				[h.Class("flex h-8 items-center gap-2 border-b border-border-subtle bg-surface-sunken px-2")],
				[skeleton(h, "size-3.5 rounded-sm"), skeleton(h, "h-3 w-16")],
			),
			h.div(
				[h.Class("divide-y divide-border-subtle")],
				SKELETON_WIDTHS.map((width) =>
					h.div(
						[h.Class("flex h-9 items-center gap-2 px-3"), h.AriaHidden(true)],
						[
							h.span([h.Class("flex w-3 shrink-0 justify-center")], [skeleton(h, "size-2 rounded-full")]),
							h.span([h.Class("flex flex-1 items-center sm:w-32 sm:flex-none")], [skeleton(h, `h-3.5 ${width}`)]),
							h.span([h.Class("flex w-28 shrink-0 justify-end")], [skeleton(h, "h-3 w-14")]),
							h.span([h.Class("hidden md:flex")], [skeleton(h, "h-4 w-24 rounded-full")]),
							h.span([h.Class("hidden min-w-0 flex-1 sm:block")]),
							h.span([h.Class("flex w-28 shrink-0 justify-end")], [skeleton(h, "h-3 w-12")]),
						],
					),
				),
			),
		],
	)

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const all = allIncidentsOf(model)
	const filtered = filteredOf(model, all)
	const filters = filtersOf(model.search)
	const chips = anomalyFilterChips(filters)
	const data = model.firstPage.data
	const hasFirstPage = AsyncData.hasData(data) && !AsyncData.isFailure(data)
	const body = AsyncData.match(data, {
		onIdle: () => listSkeleton(h),
		onLoading: () => listSkeleton(h),
		onFailure: (failure) => failed(h, failure),
		onStale: ({ error }) => failed(h, error),
		onSuccess: () => loaded(),
		onRefreshing: () => loaded(),
	})
	function loaded(): Html {
		return h.div(
			[h.Key("loaded"), h.Class("contents")],
			[
				listBody(h, model, {
					incidents: filtered,
					status: statusOf(model.search),
					hasActiveFilters: hasAnomalyFilters(filters),
					excludedValues: chips.filter((chip) => chip.negated).flatMap((chip) => chip.values),
					hasMore: nextCursorOf(model) !== null,
					timeZone: inputs.context.timeZone,
				}),
			],
		)
	}
	const chipBar = activeFilterChips(h, {
		chips: chips.map((chip) => ({
			id: chip.param,
			label: chip.label,
			values: chip.values,
			isNegated: chip.negated,
			onRemove: Message.RemovedFilterChip({ param: chip.param }),
		})),
		onClearAll: Message.ClickedClearFilters(),
		className: "mb-0 px-2 pb-2",
	})
	return dashboardPage(
		h,
		{
			title: "Anomalies",
			filters: filtersRail(h, model, all, AsyncData.isLoading(data) || AsyncData.isIdle(data)),
			// The live toggle is an action; while reads fail the error block owns the retry status.
			actions: AsyncData.hasError(data) ? undefined : liveChip(h, isLiveOf(model.search)),
			sticky: toolbar(h, model, hasFirstPage ? filtered.length : null),
		},
		[
			h.div(
				[],
				[
					...(chipBar === null ? [] : [chipBar]),
					body,
				],
			),
		],
	)
})

const failed = (h: H, failure: Parameters<typeof errorState<Message>>[1]["failure"]): Html =>
	h.div(
		[h.Class("pt-4")],
		[errorState(h, { failure, title: "Couldn't load anomalies", onRetry: Message.ClickedRetry() })],
	)
