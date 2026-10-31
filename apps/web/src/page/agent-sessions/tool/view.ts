import { pluralize } from "@maple/ui/lib/format"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"
import { fillSeriesBuckets, formatToolCount, scopeSummary } from "@maple/web-data/lib/tool-analytics"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ResolveThemeColors } from "../../../charts/theme-colors"
import type { LoadFailure } from "../../../data/load-failure"
import { errorState } from "../../../ui/error-state"
import { pageTitle } from "../../../ui/page-layout"
import { skeleton } from "../../../ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { timeControls } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import {
	chartBucketSeconds,
	DEFAULT_TOOL_PRESET,
	type ToolSeriesPoint,
	type TotalsResult,
} from "../tools-kit/model"
import { scopeRow } from "../tools-kit/scope-row"
import { facetSelect, toolFilterToolbar } from "../tools-kit/toolbar"
import { SESSIONS_LIMIT } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { rangeOf } from "./update"
import { detailCharts, GRID_TOKENS } from "./view-charts"
import { errorsTable, prepare } from "./view-errors"
import * as ErrorModal from "./error-modal-model"
import * as ErrorModalView from "./view-error-modal"
import { sessionsPanel } from "./view-sessions"

// TODO(tooltip): the description's tooltip is drawn as its trigger.

type H = HtmlBuilder<Message>

const failureOf = <A>(data: AsyncData.AsyncData<A, LoadFailure>): LoadFailure | undefined =>
	Option.getOrUndefined(AsyncData.getError(data))

const isPendingFirst = <A>(data: AsyncData.AsyncData<A, LoadFailure>): boolean =>
	!AsyncData.hasData(data) && failureOf(data) === undefined

const header = (h: H, model: Model, totals: TotalsResult, timeZone: string, controls: Html | undefined): Html => {
	const { current } = totals
	const subtitle = [
		`${formatToolCount(current.calls)} ${pluralize(current.calls, "call")} in ${formatToolCount(current.sessions)} ${pluralize(current.sessions, "session")}`,
		totals.firstSeen > 0
			? `first seen ${formatTimestampInTimezone(totals.firstSeen, { timeZone })}`
			: undefined,
		totals.lastSeen > 0
			? `last call ${formatRelativeTimeOrDate(totals.lastSeen, model.nowMs, timeZone)}`
			: undefined,
	].filter((part) => part !== undefined)
	return h.header(
		[h.Class("flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-6 pt-5 pb-4")],
		[
			h.div(
				[h.Class("flex min-w-0 flex-1 flex-col gap-1.5")],
				[
					h.div(
						[h.Class("flex min-w-0 items-baseline gap-3")],
						[
							pageTitle(h, { title: model.toolName, className: "font-mono" }, [model.toolName]),
							...(totals.description === undefined
								? []
								: [
										h.span(
											[
												h.Class(
													"w-0 min-w-0 flex-1 cursor-default truncate text-ui text-muted-foreground",
												),
												h.DataAttribute("base-ui-tooltip-trigger", ""),
												h.DataAttribute("slot", "tooltip-trigger"),
												h.Tabindex(0),
											],
											[totals.description],
										),
									]),
						],
					),
					h.p([h.Class("font-mono text-ui text-muted-foreground")], [subtitle.join(" · ")]),
				],
			),
			...(controls === undefined ? [] : [h.div([h.Class("flex shrink-0 items-center gap-2 pt-1")], [controls])]),
		],
	)
}

const toolbar = (h: H, model: Model, isWaiting: boolean): Html => {
	const facets = Option.getOrUndefined(AsyncData.getData(model.facets.data))
	const select = (
		facet: "service" | "model" | "env",
		options: ReadonlyArray<{ name: string; count: number }>,
	) =>
		facetSelect(h, {
			label: facet,
			value: model.search[facet],
			options,
			model:
				facet === "service"
					? model.serviceSelect
					: facet === "model"
						? model.modelSelect
						: model.envSelect,
			toMessage: (message) => Message.GotFacetSelectMessage({ facet, message }),
		})
	return toolFilterToolbar(h, {
		selects: [
			select("service", facets?.services ?? []),
			select("model", facets?.models ?? []),
			select("env", facets?.environments ?? []),
		],
		isFailingOnly: model.search.failing === true,
		onToggleFailingOnly: Message.ToggledFailingOnly(),
		isWaiting,
	})
}

const toTimePicker = (message: TimeRangePicker.Message) => Message.GotTimePickerMessage({ message })

const timeActions = (h: H, model: Model): Html =>
	timeControls(h, {
		search: model.search,
		defaultPreset: DEFAULT_TOOL_PRESET,
		window: model.window,
		onReset: Message.ClickedResetTimeRange(),
		onReload: Message.ClickedReload(),
		isReloading: model.isReloading,
		trigger: (label) =>
			h.submodel({
				slotId: "agent-tool-time-range-picker",
				model: model.timePicker,
				view: TimeRangePicker.view,
				toParentMessage: toTimePicker,
				viewInputs: {
					label,
					selectedPreset:
						model.search.timePreset ??
						(model.search.startTime === undefined ? DEFAULT_TOOL_PRESET : undefined),
					presets: TimeRangePicker.PRESET_VALUES,
				},
			}),
	})

const loadedView = (
	h: H,
	model: Model,
	totals: TotalsResult,
	timeZone: string,
	isRoute: boolean,
): Html => {
	const { window, themeColors } = model
	if (window === null || themeColors === null) return h.empty
	const isWaiting = AsyncData.isRefreshing(model.totals.data)
	const range = rangeOf(window)
	const series = Option.match(AsyncData.getData(model.series.data), {
		onNone: (): ReadonlyArray<ToolSeriesPoint> => [],
		// The route fills empty buckets; the lab hands the view its fixture's series as they are.
		onSome: (value) =>
			isRoute
				? fillSeriesBuckets(value.data, range.startMs, range.endMs, chartBucketSeconds(range.startMs, range.endMs))
				: value.data,
	})
	const sessions = AsyncData.getOrElse(model.sessions.data, () => ({ data: [] })).data
	return h.div(
		[h.Class("flex flex-col")],
		[
			header(h, model, totals, timeZone, isRoute ? timeActions(h, model) : undefined),
			toolbar(h, model, isWaiting),
			scopeRow(h, {
				chips: model.search.model === undefined ? [] : [{ kind: "model", value: model.search.model }],
				summary: scopeSummary(totals.current, totals.current.calls, model.toolName),
				onRemove: () => Message.RemovedModelChip(),
				onClearAll: Message.RemovedModelChip(),
			}),
			detailCharts(h, { series, charts: model.charts, theme: themeColors, timeZone, isWaiting }),
			errorsTable(h, {
				rows: AsyncData.getOrElse(model.errors.data, () => ({ data: [] })).data,
				tool: model.toolName,
				toolCalls: totals.current.calls,
				range,
				selected: model.search.error,
				sort: model.errorsSort,
				isExpanded: model.isErrorsExpanded,
				isLoading: isPendingFirst(model.errors.data),
				failure: failureOf(model.errors.data),
				isWaiting,
				nowMs: model.nowMs,
				timeZone,
			}),
			sessionsPanel(h, {
				rows: sessions,
				tool: model.toolName,
				isCapped: sessions.length >= SESSIONS_LIMIT,
				isLoading: isPendingFirst(model.sessions.data),
				failure: failureOf(model.sessions.data),
				isWaiting,
				nowMs: model.nowMs,
				timeZone,
			}),
			errorModalView(h, model, totals, range, timeZone),
		],
	)
}

/** `ErrorModal`: mounted from the row, so a stale `?error=` the window no longer holds opens nothing. */
const errorModalView = (
	h: H,
	model: Model,
	totals: TotalsResult,
	range: Readonly<{ startMs: number; endMs: number }>,
	timeZone: string,
): Html => {
	const rows = AsyncData.getOrElse(model.errors.data, () => ({ data: [] })).data
	const prepared = prepare(rows, range).rows
	const index = prepared.findIndex((row) => row.fingerprint === model.errorModal.fingerprint)
	const group = prepared[index]
	return h.submodel({
		slotId: "agent-tool-error-modal-root",
		model: model.errorModal,
		view: ErrorModalView.view,
		toParentMessage: (message: ErrorModal.Message) => Message.GotErrorModalMessage({ message }),
		viewInputs: {
			inputs:
				group === undefined
					? undefined
					: {
							tool: model.toolName,
							group,
							position: { index, total: prepared.length },
							toolFailures: rows.reduce((sum, row) => sum + row.calls, 0),
							toolCalls: totals.current.calls,
							range,
							session: model.search.session,
							variant: model.search.variant,
							timeZone,
							nowMs: model.nowMs,
						},
		},
	})
}

const loadingView = (h: H): Html =>
	h.div(
		[h.Class("flex flex-col gap-5 p-6")],
		[skeleton(h, "h-14 w-full max-w-2xl"), skeleton(h, "h-64"), skeleton(h, "h-64")],
	)

/** `ResultView` over the totals read; the lab draws it without the route's time controls. */
export const toolDetailBody = (
	h: H,
	model: Model,
	options: Readonly<{ timeZone: string; isRoute: boolean }>,
): Html =>
	AsyncData.matchData(model.totals.data, {
		onEmpty: () => loadingView(h),
		onFailure: (failure) => errorState(h, { failure, title: `Couldn't load ${model.toolName}` }),
		onData: (totals) =>
			model.themeColors === null || model.chartRuntime._tag === "Loading"
				? loadingView(h)
				: loadedView(h, model, totals, options.timeZone, options.isRoute),
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: GRID_TOKENS }))],
		[
			dashboardPage(h, { scrollClassName: "p-0" }, [
				toolDetailBody(h, model, { timeZone: inputs.context.timeZone, isRoute: true }),
			]),
		],
	),
)
