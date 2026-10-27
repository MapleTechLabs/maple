import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { errorState } from "../../../ui/error-state"
import { filterChip } from "../../../ui/filter-chip"
import { activeFilterChips } from "../../../ui/filters/active-filter-chips"
import { skeletonList } from "../../../ui/skeleton"
import * as TabsView from "../../../ui/tabs-view"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
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
const toolbar = (h: H, model: Model, count: number | null): Html =>
	h.div(
		[h.Class("flex flex-wrap items-center gap-2 gap-y-1.5 pb-3")],
		[
			h.submodel({
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
			h.div(
				[h.Class("ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2")],
				count === null
					? []
					: [
							h.span(
								[h.Class("text-xs text-muted-foreground tabular-nums")],
								[String(count), " ", count === 1 ? "anomaly" : "anomalies"],
							),
						],
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
		onIdle: () => skeletonList(h, { rows: 5, rowClassName: "h-9", className: "p-2" }),
		onLoading: () => skeletonList(h, { rows: 5, rowClassName: "h-9", className: "p-2" }),
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
			// The toolbar sits one header gap under the title, as tabs do on tabbed pages.
			scrollClassName: "pt-0",
		},
		[
			h.div(
				[],
				[
					toolbar(h, model, hasFirstPage ? filtered.length : null),
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
