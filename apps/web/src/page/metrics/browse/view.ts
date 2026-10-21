import { formatNumber } from "@maple/ui/lib/format"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { isChartRuntimeReady } from "../../../charts/chart-runtime"
import { ResolveThemeColors } from "../../../charts/theme-colors"
import { errorState } from "../../../ui/error-state"
import { icon } from "../../../ui/icon"
import { segmentedSelect } from "../../../ui/segmented-select"
import type * as Select from "../../../ui/select"
import { type SelectEntry, type SelectOption, view as selectView } from "../../../ui/select-view"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { presenceOf } from "../../kit/signal-presence"
import { signalEmptyState } from "../../kit/signal-empty-state"
import { timeControls } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { METRIC_TYPE_COLORS } from "../shared"
import { toEntries } from "./derive"
import { type BrowseView, Message } from "./message"
import type { Model, SummaryRow } from "./model"
import { DEFAULT_PRESET } from "./update"
import { loadingGrid, previewGrid } from "./view-grid"
import { loadingTable, metricsTable } from "./view-table"
import { searchInput } from "../../../ui/search-input"

// The window carried across pages is the root's (`route/session-time-range.ts`).
// TODO(session-range): `sessionTimeRangeSearchMiddleware` (the window carried across pages) is not ported.

type H = HtmlBuilder<Message>

const THEME_TOKENS = [...METRIC_TYPE_COLORS.values(), "var(--chart-1)"]

const TYPE_ITEMS = [
	{ value: "all", label: "All types" },
	{ value: "sum", label: "Sum" },
	{ value: "gauge", label: "Gauge" },
	{ value: "histogram", label: "Histogram" },
	{ value: "exponential_histogram", label: "Exp histogram" },
] as const

const TYPE_ENTRIES: ReadonlyArray<SelectEntry> = TYPE_ITEMS.map((item) => ({
	_tag: "Item",
	item: { value: item.value, label: item.label },
}))

/** `MetricsTypeFilter`'s menu rows: the counts live in the menu (decoration; a failed summary hides them). */
const typeItem =
	(h: H, summary: Option.Option<ReadonlyArray<SummaryRow>>) =>
	(option: SelectOption): ReadonlyArray<Html | string> => {
		const rows = Option.getOrUndefined(summary)
		const row = rows?.find((candidate) => candidate.metricType === option.value)
		const count =
			rows === undefined
				? undefined
				: option.value === "all"
					? rows.reduce((total, next) => total + next.metricCount, 0)
					: (row?.metricCount ?? 0)
		const dataPoints =
			option.value === "all"
				? rows?.reduce((total, next) => total + next.dataPointCount, 0)
				: row?.dataPointCount
		return [
			h.span(
				[
					h.Class("flex w-full items-center justify-between gap-6"),
					...(dataPoints === undefined ? [] : [h.Title(`${formatNumber(dataPoints)} data points`)]),
				],
				[
					option.label,
					...(count === undefined
						? []
						: [h.span([h.Class("text-muted-foreground tabular-nums")], [String(count)])]),
				],
			),
		]
	}

/** `ToolbarSearch` (debounced) over `SearchInput`. */
const toolbarSearch = (h: H, model: Model): Html =>
	searchInput(h, {
		id: "metrics-search",
		size: "default",
		className: "max-w-sm w-64",
		placeholder: "Search metrics...",
		value: model.searchInput,
		onInput: (value) => Message.ChangedSearchInput({ value }),
		onClear: Message.ClickedClearSearch(),
	})

const toTypeSelect = (message: Select.Message) => Message.GotTypeSelectMessage({ message })

const filters = (h: H, model: Model): Html =>
	h.submodel({
		slotId: "metrics-type-filter",
		model: model.typeSelect,
		view: selectView,
		toParentMessage: toTypeSelect,
		viewInputs: {
			entries: TYPE_ENTRIES,
			renderItem: typeItem(h, AsyncData.getData(model.summary.data)),
			ariaLabel: "Metric type",
			className: "w-auto min-w-0",
			toView: (parts) =>
				h.div(
					[h.Class("flex min-w-0 flex-wrap items-center gap-2")],
					[toolbarSearch(h, model), ...parts],
				),
		},
	})

const VIEW_OPTIONS = (h: H) =>
	[
		{ value: "grid", label: "", icon: icon(h, "GridIcon", { size: 14 }), ariaLabel: "Grid view" },
		{ value: "table", label: "", icon: icon(h, "MenuIcon", { size: 14 }), ariaLabel: "Table view" },
	] as const

const toTimePicker = (message: TimeRangePicker.Message) => Message.GotTimePickerMessage({ message })

const actions = (h: H, model: Model): Html =>
	h.div(
		[h.Class("flex flex-wrap items-center gap-2")],
		[
			segmentedSelect<BrowseView, Message>(h, {
				size: "sm",
				ariaLabel: "View",
				options: VIEW_OPTIONS(h),
				value: model.search.view ?? "grid",
				onChange: (view) => Message.ClickedView({ view }),
			}),
			timeControls(h, {
				search: model.search,
				defaultPreset: DEFAULT_PRESET,
				window: model.window,
				onReset: Message.ClickedResetTimeRange(),
				onReload: Message.ClickedReload(),
				isReloading: model.isReloading,
				trigger: (label) =>
					h.submodel({
						slotId: "time-range-picker",
						model: model.timePicker,
						view: TimeRangePicker.view,
						toParentMessage: toTimePicker,
						viewInputs: {
							label,
							selectedPreset:
								model.search.timePreset ??
								(model.search.startTime === undefined ? DEFAULT_PRESET : undefined),
							presets: TimeRangePicker.PRESET_VALUES,
						},
					}),
			}),
		],
	)

const isFiltered = (model: Model) => (model.search.q ?? "") !== "" || model.search.type !== undefined

const emptyState = (h: H, model: Model): Html =>
	h.div(
		[h.Class("contents")],
		[
			signalEmptyState(h, {
				signal: "metrics",
				presence: presenceOf(model.presence, "metrics"),
				nowMs: model.nowMs,
				isFiltered: isFiltered(model),
				onClearFilters: Message.ClickedClearFilters(),
			}),
		],
	)

const gridArea = (h: H, model: Model, orgId: string): Html =>
	AsyncData.matchData(model.catalog.data, {
		onEmpty: () => loadingGrid(h),
		onFailure: (failure) => errorState(h, { failure }),
		onData: (rows) =>
			toEntries(rows).length === 0
				? emptyState(h, model)
				: model.themeColors === null || !isChartRuntimeReady(model.chartRuntime)
					? loadingGrid(h)
					: previewGrid(h, model, orgId, model.themeColors, rows),
	})

const tableArea = (h: H, model: Model, timeZone: string): Html =>
	AsyncData.matchData(model.table.data, {
		onEmpty: () => loadingTable(h),
		onFailure: (failure) => errorState(h, { failure }),
		onData: (rows) =>
			rows.length === 0
				? emptyState(h, model)
				: metricsTable(h, model, rows, AsyncData.isRefreshing(model.table.data), timeZone),
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: THEME_TOKENS }))],
		[
			dashboardPage(h, { titleContent: filters(h, model), actions: actions(h, model) }, [
				(model.search.view ?? "grid") === "grid"
					? gridArea(h, model, inputs.context.orgId)
					: tableArea(h, model, inputs.context.timeZone),
			]),
		],
	),
)
