import { Option } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import * as AddToDashboard from "./add-to-dashboard"
import {
	appliedSuggestion,
	caretMessage,
	completedAttributeValues,
	dismissedSuggestions,
	isWhereOpen,
	movedSuggestion,
	pressedTab,
} from "./update-where"
import { initWhereEditor } from "./where-editor"
import * as Chart from "../../../charts/chart"
import { LoadChartRuntime } from "../../../charts/chart-runtime"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { TimeWindow } from "../../../data/time-range"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import type { MetricSearch } from "../../../route/search"
import * as Combobox from "../../../ui/combobox"
import * as CopyButton from "../../../ui/copy-button"
import * as Select from "../../../ui/select"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { routeWindowStep, snapModeOf } from "../../kit/route-window"
import * as TimeRangePicker from "../../kit/time-range-picker"
import {
	BuildAlertLink,
	CompleteReloadSpin,
	DebounceWhere,
	FetchAttributeKeys,
	FetchAutocomplete,
	FetchBreakdown,
	FetchCatalog,
	FetchTimeseries,
	ReadLocation,
	ResolveWindow,
} from "./command"
import {
	appendWhereFilter,
	breakdownGroupBy,
	buildBreakdownDraft,
	buildMetricExplorerDraft,
	type CatalogSummary,
	chartQuery,
	SERVICE_KEY,
	summarizeCatalogRows,
} from "./derive"
import { Message, type RequestMode } from "./message"
import { AutocompleteLookup, type Model } from "./model"

type Return = PageReturn<Model, Message>
export type Search = typeof MetricSearch.Type
type Route = { readonly metricName: string; readonly search: Search }
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>

/** `DashboardPage`'s `defaultPreset` for a metric. */
export const DEFAULT_PRESET = "24h"
/** `MetricQueryControls`' "no breakdown" item, shown as its label (`itemToStringLabel`). */
export const GROUP_BY_NONE_LABEL = "Everything (no breakdown)"

const resolveCommand = (model: Model, context: PageContext, mode: RequestMode) =>
	ResolveWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

/** The catalog summary once the catalog has rows for this metric (and the URL's type). */
export const summaryOf = (model: Model): CatalogSummary | null =>
	Option.match(AsyncData.getData(model.catalog.data), {
		onNone: () => null,
		onSome: (rows) => summarizeCatalogRows(rows, model.metricName, model.search.type),
	})

export const draftOf = (model: Model, summary: CatalogSummary) =>
	buildMetricExplorerDraft(summary, model.search)

/** `MetricBreakdown`'s key: the URL's `bd`, else `service.name`. */
export const breakdownKeyOf = (search: Search): string => search.bd ?? SERVICE_KEY

type Step<A, E> = Readonly<{ slot: Keyed.Keyed<A, E>; commands: Commands }>

const keyed = <A, E>(
	slot: Keyed.Keyed<A, E>,
	key: string,
	mode: Keyed.RequestMode,
	fetch: (key: string) => Command.Command<Message, never, Resources>,
): Step<A, E> =>
	Option.match(Keyed.request(slot, key, mode), {
		onNone: () => ({ slot, commands: [] }),
		onSome: (next) => ({ slot: next, commands: [fetch(key)] }),
	})

const LOOKUP_OPERATION = new Map<AutocompleteLookup, string>([
	["tracesFacets", "getTracesFacets"],
	["logsFacets", "getLogsFacets"],
	["spanAttributeKeys", "getSpanAttributeKeys"],
	["resourceAttributeKeys", "getResourceAttributeKeys"],
	["metricAttributeKeys", "getMetricAttributeKeys"],
	["productEventNames", "productEventNames"],
	["productEventAttributeKeys", "getProductEventAttributeKeys"],
])

/** `AutocompleteValuesProvider`'s lookups for the window, fired when it mounts with the page. */
const requestAutocomplete = (model: Model, context: PageContext, window: TimeWindow, mode: RequestMode) => {
	const steps = AutocompleteLookup.literals.map((lookup) => {
		const operation = LOOKUP_OPERATION.get(lookup) ?? lookup
		const input = lookup === "productEventNames" ? { ...window, limit: 200 } : window
		return {
			lookup,
			...keyed(
				model.autocomplete[lookup] ?? Keyed.idle(),
				requestKey(context.orgId, operation, { data: input }),
				mode,
				(key) => FetchAutocomplete({ key, lookup, window }),
			),
		}
	})
	return {
		autocomplete: {
			...model.autocomplete,
			...Object.fromEntries(steps.map((step) => [step.lookup, step.slot])),
		},
		commands: steps.flatMap((step) => step.commands),
	}
}

/** What `MetricDetailContent` reads once the summary exists: scoped keys, the chart and the breakdown. */
const requestContent = (model: Model, context: PageContext, mode: RequestMode): Return => {
	const summary = summaryOf(model)
	if (summary === null || model.window === null) return { model }
	const { window } = model
	const org = context.orgId
	const draft = draftOf(model, summary)
	const keysInput = { ...window, metricName: summary.metricName, metricType: summary.metricType }
	const chartInput = { ...window, query: chartQuery(draft) }
	const breakdownInput = {
		...window,
		query: buildBreakdownDraft(draft, breakdownGroupBy(breakdownKeyOf(model.search))),
	}
	const attributeKeys = keyed(
		model.attributeKeys,
		requestKey(org, "getMetricAttributeKeys", { data: keysInput }),
		// The scoped keys are read with `useAtomValue`: Reload leaves them alone.
		"Load",
		(key) => FetchAttributeKeys({ key, input: keysInput }),
	)
	const timeseries = keyed(
		model.timeseries,
		requestKey(org, "getQueryBuilderTimeseries", { data: { ...window, queries: [chartInput.query] } }),
		mode,
		(key) => FetchTimeseries({ key, input: chartInput }),
	)
	const breakdown = keyed(
		model.breakdown,
		requestKey(org, "getQueryBuilderBreakdown", { data: { ...window, queries: [breakdownInput.query] } }),
		mode,
		(key) => FetchBreakdown({ key, input: breakdownInput }),
	)
	return {
		model: {
			...syncControls(model),
			attributeKeys: attributeKeys.slot,
			timeseries: timeseries.slot,
			breakdown: breakdown.slot,
		},
		commands: [...attributeKeys.commands, ...timeseries.commands, ...breakdown.commands],
	}
}

/** Every query the page reads for the resolved window. */
const requestAll = (model: Model, context: PageContext, window: TimeWindow, mode: RequestMode): Return => {
	const catalog = keyed(
		model.catalog,
		requestKey(context.orgId, "listMetrics", {
			data: { search: model.metricName, ...window, limit: 1000 },
		}),
		mode,
		(key) => FetchCatalog({ key, metricName: model.metricName, window }),
	)
	// Reload leaves the provider's lookups alone: they are read with `useAtomValue`.
	const lookups = requestAutocomplete(model, context, window, "Load")
	const content = requestContent(
		{ ...model, window, catalog: catalog.slot, autocomplete: lookups.autocomplete },
		context,
		mode,
	)
	return {
		model: content.model,
		commands: [...catalog.commands, ...lookups.commands, ...(content.commands ?? [])],
	}
}

/** The select and comboboxes show what the URL and the summary say. */
const syncControls = (model: Model): Model => {
	const summary = summaryOf(model)
	const aggregation = summary === null ? model.aggregationSelect.value : draftOf(model, summary).aggregation
	const groupBy =
		model.search.groupBy === undefined || model.search.groupBy === ""
			? GROUP_BY_NONE_LABEL
			: model.search.groupBy
	const breakdownKey = breakdownKeyOf(model.search)
	const syncCombobox = (combobox: Combobox.Model, value: string): Combobox.Model =>
		combobox.isOpen || combobox.selected[0] === value
			? combobox
			: { ...combobox, selected: [value], inputValue: value }
	return {
		...model,
		aggregationSelect: { ...model.aggregationSelect, value: aggregation },
		groupByCombobox: syncCombobox(model.groupByCombobox, groupBy),
		breakdownCombobox: syncCombobox(model.breakdownCombobox, breakdownKey),
	}
}

// NAVIGATION

const metricHref = (model: Model, search: Search) =>
	hrefOf(AppRoute.Metric({ metricName: model.metricName, search }))

/** `handlePatch`: query changes replace the history entry. */
const patchSearch = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url: metricHref(model, search), isReplace: true }),
})

/** `buildBackToMetricsHref`: back to the browse page with the time range only. */
export const backToMetricsHref = (search: Search): string =>
	hrefOf(
		AppRoute.Metrics({
			search: { startTime: search.startTime, endTime: search.endTime, timePreset: search.timePreset },
		}),
	)

/** The dialog's step; a widget that landed opens its dashboard. */
const liftAddToDashboard = (
	model: Model,
	step: Update.ReturnWithOutMessage<
		AddToDashboard.Model,
		AddToDashboard.Message,
		AddToDashboard.OutMessage,
		Resources
	>,
): Return => {
	const lifted: Return = {
		model: { ...model, addToDashboard: step.model },
		commands: Command.mapMessages(step.commands ?? [], (message) =>
			Message.GotAddToDashboardMessage({ message }),
		),
	}
	if (step.outMessage === undefined) return lifted
	const dashboardId = AppRoute.Dashboard.fields.dashboardId.make(step.outMessage.dashboardId)
	return {
		...lifted,
		outMessage: PageOutMessage.RequestedNavigation({
			url: hrefOf(AppRoute.Dashboard({ dashboardId, search: {} })),
			isReplace: false,
		}),
	}
}

// ENTRY POINTS

export const AGGREGATION_SELECT_ID = "metric-aggregation"

export const init = (route: Route, context: PageContext): Return => {
	const model: Model = {
		metricName: route.metricName,
		search: route.search,
		window: null,
		nowMs: 0,
		catalog: Keyed.idle(),
		autocomplete: {},
		attributeKeys: Keyed.idle(),
		timeseries: Keyed.idle(),
		breakdown: Keyed.idle(),
		whereInput: route.search.where ?? "",
		whereGeneration: 0,
		whereEditor: initWhereEditor(route.search.where ?? ""),
		stepInput: route.search.step ?? "",
		aggregationSelect: Select.init(AGGREGATION_SELECT_ID, { value: "", selectedIndex: null }),
		groupByCombobox: Combobox.init("metric-group-by", "single", {
			selected: [route.search.groupBy ?? GROUP_BY_NONE_LABEL],
		}),
		breakdownCombobox: Combobox.init("metric-breakdown-key", "single", {
			selected: [breakdownKeyOf(route.search)],
		}),
		copyLink: CopyButton.init(),
		addToDashboard: AddToDashboard.init(),
		chart: Chart.init(),
		timePicker: TimeRangePicker.init("metric-time-range"),
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
		refreshVersion: 0,
		isReloading: false,
	}
	return {
		model,
		commands: [
			resolveCommand(model, context, "Load"),
			Command.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
		],
	}
}

/** The query changed in the URL: inputs resync, and a new window re-resolves first. */
export const routeChanged = (model: Model, route: Route, context: PageContext): Return => {
	if (metricHref(model, model.search) === metricHref(model, route.search)) return { model }
	const next = syncControls({
		...model,
		search: route.search,
		whereInput: route.search.where ?? "",
		stepInput: route.search.step ?? "",
	})
	const resolve = (): Return => ({ model: next, commands: [resolveCommand(next, context, snapModeOf(model.refreshVersion))] })
	return routeWindowStep(model.search, route.search, {
		resolve,
		requestAll: (mode) => (next.window === null ? resolve() : requestContent(next, context, mode)),
	})
}

export const contextChanged = (model: Model, context: PageContext): Return =>
	model.window === null ? { model } : requestAll(model, context, model.window, "Load")

// SUBMODELS

const liftAggregation = (model: Model, message: Select.Message): Return => {
	const next = Select.update(model.aggregationSelect, message)
	const lifted: Return = {
		model: { ...model, aggregationSelect: next.model },
		commands: Command.mapMessages(next.commands, (inner) =>
			Message.GotAggregationSelectMessage({ message: inner }),
		),
	}
	if (next.outMessage === undefined) return lifted
	const agg = next.outMessage.value
	const isKnown =
		agg === "avg" ||
		agg === "sum" ||
		agg === "min" ||
		agg === "max" ||
		agg === "count" ||
		agg === "rate" ||
		agg === "increase"
	return isKnown
		? { ...lifted, outMessage: patchSearch(lifted.model, { ...model.search, agg }).outMessage }
		: lifted
}

const liftCombobox = (
	model: Model,
	field: "groupByCombobox" | "breakdownCombobox",
	message: Combobox.Message,
	toMessage: (message: Combobox.Message) => Message,
	onValue: (value: string) => Search,
): Return => {
	const next = Combobox.update(model[field], message)
	const lifted: Return = {
		model: { ...model, [field]: next.model },
		commands: Command.mapMessages(next.commands, toMessage),
	}
	return next.outMessage?._tag === "ChangedValue" && next.outMessage.value !== ""
		? { ...lifted, outMessage: patchSearch(lifted.model, onValue(next.outMessage.value)).outMessage }
		: lifted
}

const liftCopyLink = (model: Model, message: CopyButton.Message): Return => {
	const next = CopyButton.update(model.copyLink, message)
	return {
		model: { ...model, copyLink: next.model },
		commands: Command.mapMessages(next.commands, (inner) =>
			Message.GotCopyLinkMessage({ message: inner }),
		),
	}
}

const liftTimePicker = (model: Model, message: TimeRangePicker.Message): Return => {
	const next = TimeRangePicker.update(model.timePicker, message)
	const lifted: Return = {
		model: { ...model, timePicker: next.model },
		commands: Command.mapMessages(next.commands, (inner) =>
			Message.GotTimePickerMessage({ message: inner }),
		),
	}
	return next.outMessage === undefined || next.outMessage._tag === "RejectedRange"
		? lifted
		: {
				...lifted,
				outMessage: PageOutMessage.RequestedNavigation({
					url: metricHref(model, {
						...model.search,
						...TimeRangePicker.searchPatchOf(next.outMessage),
					}),
					isReplace: false,
				}),
			}
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, mode }) =>
			requestAll({ ...model, nowMs }, context, window, mode),
		CompletedFetchCatalog: ({ key, result }) =>
			requestContent({ ...model, catalog: Keyed.accept(model.catalog, key, result) }, context, "Load"),
		CompletedFetchAutocomplete: ({ lookup, key, result }) => {
			const slot = model.autocomplete[lookup]
			return slot === undefined
				? { model }
				: {
						model: {
							...model,
							autocomplete: {
								...model.autocomplete,
								[lookup]: Keyed.accept(slot, key, result),
							},
						},
					}
		},
		CompletedFetchAttributeKeys: ({ key, result }) => ({
			model: { ...model, attributeKeys: Keyed.accept(model.attributeKeys, key, result) },
		}),
		CompletedFetchTimeseries: ({ key, result }) => ({
			model: { ...model, timeseries: Keyed.accept(model.timeseries, key, result) },
		}),
		CompletedFetchBreakdown: ({ key, result }) => ({
			model: { ...model, breakdown: Keyed.accept(model.breakdown, key, result) },
		}),
		ChangedWhereInput: ({ value }) => {
			const whereGeneration = model.whereGeneration + 1
			return {
				model: { ...model, whereInput: value, whereGeneration },
				commands: [DebounceWhere({ generation: whereGeneration })],
			}
		},
		CompletedWhereDebounce: ({ generation }) =>
			generation === model.whereGeneration
				? patchSearch(model, {
						...model.search,
						where: model.whereInput === "" ? undefined : model.whereInput,
					})
				: { model },
		// Where clauses are single-line: Enter never inserts a newline (suggestions are not ported).
		PressedWhereEnter: () => ({ model }),
		GotCaretMessage: ({ message: caret }) => caretMessage(model, caret, context, summaryOf(model)),
		MovedWhereSuggestion: ({ step }) => (isWhereOpen(model) ? movedSuggestion(model, step) : { model }),
		DismissedWhereSuggestions: () => (isWhereOpen(model) ? dismissedSuggestions(model) : { model }),
		AppliedWhereSuggestion: ({ index }) => appliedSuggestion(model, index, context, summaryOf(model)),
		CompletedPlaceWhereCaret: () => ({ model }),
		PressedWhereTab: () =>
			isWhereOpen(model) ? pressedTab(model, model.whereEditor.activeIndex, context, summaryOf(model)) : { model },
		PressedWhereEnterOnList: () =>
			isWhereOpen(model)
				? appliedSuggestion(model, model.whereEditor.activeIndex, context, summaryOf(model))
				: { model },
		CompletedFetchAttributeValues: ({ key, result }) => completedAttributeValues(model, key, result),
		ChangedStepInput: ({ value }) => ({ model: { ...model, stepInput: value } }),
		CommittedStepInput: () =>
			model.stepInput === (model.search.step ?? "")
				? { model }
				: patchSearch(model, {
						...model.search,
						step: model.stepInput === "" ? undefined : model.stepInput,
					}),
		ClickedBreakdownValue: ({ groupBy, value }) => {
			const where = appendWhereFilter(model.search.where ?? "", groupBy, value)
			return patchSearch(model, { ...model.search, where: where === "" ? undefined : where })
		},
		ClickedCreateAlert: () => {
			const summary = summaryOf(model)
			return summary === null
				? { model }
				: {
						model,
						commands: [
							BuildAlertLink({ query: draftOf(model, summary), title: model.metricName }),
						],
					}
		},
		BuiltAlertLink: ({ url }) => ({
			model,
			outMessage: PageOutMessage.RequestedNavigation({ url, isReplace: false }),
		}),
		ClickedAddToDashboard: () => liftAddToDashboard(model, AddToDashboard.open(model.addToDashboard)),
		GotAddToDashboardMessage: ({ message: inner }) => {
			const summary = summaryOf(model)
			return liftAddToDashboard(
				model,
				AddToDashboard.update(model.addToDashboard, inner, {
					orgId: context.orgId,
					draft: summary === null ? null : draftOf(model, summary),
				}),
			)
		},
		ClickedCopyLink: () => ({ model, commands: [ReadLocation()] }),
		ReadLocationHref: ({ href }) => liftCopyLink(model, CopyButton.Message.ClickedCopy({ text: href })),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		ClickedReload: () => {
			const reloaded = { ...model, refreshVersion: model.refreshVersion + 1, isReloading: true }
			return {
				model: reloaded,
				commands: [
					resolveCommand(reloaded, context, "Refresh"),
					CompleteReloadSpin({ version: reloaded.refreshVersion }),
				],
			}
		},
		CompletedReloadSpin: ({ version }) =>
			version === model.refreshVersion ? { model: { ...model, isReloading: false } } : { model },
		ClickedResetTimeRange: () =>
			patchSearch(model, {
				...model.search,
				startTime: undefined,
				endTime: undefined,
				timePreset: DEFAULT_PRESET,
			}),
		GotAggregationSelectMessage: ({ message: inner }) => liftAggregation(model, inner),
		GotGroupByComboboxMessage: ({ message: inner }) =>
			liftCombobox(
				model,
				"groupByCombobox",
				inner,
				(next) => Message.GotGroupByComboboxMessage({ message: next }),
				(value) => ({ ...model.search, groupBy: value === GROUP_BY_NONE_LABEL ? undefined : value }),
			),
		GotBreakdownComboboxMessage: ({ message: inner }) =>
			liftCombobox(
				model,
				"breakdownCombobox",
				inner,
				(next) => Message.GotBreakdownComboboxMessage({ message: next }),
				(value) => ({ ...model.search, bd: value }),
			),
		GotCopyLinkMessage: ({ message: inner }) => liftCopyLink(model, inner),
		GotChartMessage: ({ message: inner }) => {
			const next = Chart.update(model.chart, inner)
			return {
				model: { ...model, chart: next.model },
				commands: Command.mapMessages(next.commands ?? [], (chart) =>
					Message.GotChartMessage({ message: chart }),
				),
			}
		},
		GotTimePickerMessage: ({ message: inner }) => liftTimePicker(model, inner),
	})
