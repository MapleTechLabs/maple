import { toggleFilterValue, toggleTraffic } from "../../components/analytics/filters"
import { Option, Result, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Chart from "../../charts/chart"
import { LoadChartRuntime } from "../../charts/chart-runtime"
import * as Keyed from "../../data/keyed"
import { type LoadFailure, toLoadFailure } from "../../data/load-failure"
import type { Resources } from "../../platform/resources"
import { AppRoute, hrefOf } from "../../route"
import * as Dialog from "../../ui/dialog"
import * as FilterSections from "../../ui/filters/filter-sections"
import { type PageContext, PageOutMessage, type PageReturn } from "../contract"
import { SignalPresenceData } from "../kit/signal-presence"
import { nextSort } from "../kit/table-sort"
import { routeWindowStep, snapModeOf } from "../kit/route-window"
import * as TimeRangePicker from "../kit/time-range-picker"
import type { PresetValue } from "../kit/time-controls"
import { CompleteReloadSpin, LoadSignalPresence, ResolveWindow } from "./command"
import { type FilterKey, Message, type RequestMode, type SlotName } from "./message"
import {
	AiCrawlers,
	AiReferralPoint,
	AnalyticsEvent,
	AnalyticsPage,
	Breakdowns,
	Live,
	type Model,
	PageviewsPoint,
	type PanelState,
	type Search,
	Summary,
	TimeseriesPoint,
	TraceSample,
} from "./model"
import { filtersOf, requestSlots, showsOverviewContent, tabOf } from "./requests"

type Return = PageReturn<Model, Message>
type Cmd = Command.Command<Message, never, Resources>

export const DEFAULT_PRESET: PresetValue = "1w"

const SLOT_SCHEMAS = {
	breakdowns: Breakdowns,
	events: Schema.Array(AnalyticsEvent),
	live: Live,
	summary: Summary,
	mix: Summary,
	timeseries: Schema.Array(TimeseriesPoint),
	pageviews: Schema.Array(PageviewsPoint),
	pages: Schema.Array(AnalyticsPage),
	previousSummary: Summary,
	previousPageviews: Schema.Array(PageviewsPoint),
	aiReferrals: Schema.Array(AiReferralPoint),
	previousAiReferrals: Schema.Array(AiReferralPoint),
	aiCrawlers: AiCrawlers,
	traceSamples: Schema.Array(TraceSample),
} satisfies Record<SlotName, Schema.Top>

const SLOTS = Object.keys(SLOT_SCHEMAS).filter((name): name is SlotName => name in SLOT_SCHEMAS)

const decodeFailure: LoadFailure = toLoadFailure("The response could not be read.")

/** Folds an answer into every slot that asked under its key, decoded with that slot's schema. */
const settleSlots = (model: Model, key: string, result: Result.Result<unknown, LoadFailure>): Model =>
	SLOTS.reduce<Model>((next, name) => {
		if (next[name].key !== key) return next
		const decoded = Result.match(result, {
			onFailure: (failure) => Result.fail(failure),
			onSuccess: (value) =>
				Option.match(Schema.decodeUnknownOption(SLOT_SCHEMAS[name])(value), {
					onNone: () => Result.fail(decodeFailure),
					onSome: (data) => Result.succeed(data),
				}),
		})
		const slot: Keyed.Keyed<unknown, LoadFailure> = next[name]
		return { ...next, [name]: Keyed.accept(slot, key, decoded) }
	}, model)

const resolveCommand = (model: Model, context: PageContext, mode: RequestMode): Cmd =>
	ResolveWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

const navigate = (model: Model, search: Search, isReplace = false): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.Analytics({ search })),
		isReplace,
	}),
})

/** `onFilterChange`: an empty value drops out of the URL. */
const withFilter = (search: Search, key: FilterKey, value: string | undefined): Search => ({
	...search,
	[key]: value === "" ? undefined : value,
})

const withRequests = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	if (model.window === null) return { model }
	return requestSlots(model, context, model.window, mode)
}

const defaultPanel: PanelState = { pickedTab: null, query: "", sortKey: null, sortDir: "desc" }
export const panelOf = (model: Model, panel: string): PanelState => model.panels[panel] ?? defaultPanel

const withPanel = (model: Model, panel: string, patch: Partial<PanelState>): Model => ({
	...model,
	panels: { ...model.panels, [panel]: { ...panelOf(model, panel), ...patch } },
})

const hasRows = <A>(slot: Keyed.Keyed<ReadonlyArray<A>, LoadFailure>): boolean =>
	Option.match(AsyncData.getData(slot.data), { onNone: () => false, onSome: (rows) => rows.length > 0 })

/**
 * `useTableSort`'s `initialKey` is read once, when the card mounts with the breakdowns: Pages and
 * Events sort by their second column only if those rows were already in by then.
 */
const seedPanels = (model: Model): Model => {
	if (tabOf(model.search) !== "overview" || !showsOverviewContent(model)) return model
	if (Option.isNone(AsyncData.getData(model.breakdowns.data))) return model
	const seeds: ReadonlyArray<readonly [string, boolean]> = [
		["content", hasRows(model.pages)],
		["events", hasRows(model.events)],
	]
	return seeds.reduce<Model>(
		(next, [panel, hasViews]) =>
			next.panels[panel] === undefined
				? withPanel(next, panel, { sortKey: hasViews ? "views" : "count" })
				: next,
		model,
	)
}

const hasAnswered = (slot: Keyed.Keyed<unknown, LoadFailure>): boolean =>
	AsyncData.isSuccess(slot.data) || AsyncData.isFailure(slot.data)

/**
 * Both reads leave together, breakdowns first. The Events card's sort seeds from the breakdowns,
 * so an events answer that beats the breakdowns waits for them here.
 */
const delivered = (model: Model, key: string, result: Result.Result<unknown, LoadFailure>): Model => {
	if (key === model.events.key && key !== model.breakdowns.key && !hasAnswered(model.breakdowns))
		return { ...model, heldEvents: { key, result } }
	const next = seedPanels(settleSlots(model, key, result))
	const held = next.heldEvents
	return key !== next.breakdowns.key || held === null
		? next
		: seedPanels(settleSlots({ ...next, heldEvents: null }, held.key, held.result))
}

// ENTRY POINTS

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const model: Model = {
		search: route.search,
		window: null,
		nowMs: 0,
		breakdowns: Keyed.idle(),
		events: Keyed.idle(),
		live: Keyed.idle(),
		summary: Keyed.idle(),
		mix: Keyed.idle(),
		timeseries: Keyed.idle(),
		pageviews: Keyed.idle(),
		pages: Keyed.idle(),
		previousSummary: Keyed.idle(),
		previousPageviews: Keyed.idle(),
		aiReferrals: Keyed.idle(),
		previousAiReferrals: Keyed.idle(),
		aiCrawlers: Keyed.idle(),
		traceSamples: Keyed.idle(),
		presence: SignalPresenceData.Loading(),
		pickedMetric: null,
		panels: {},
		heldEvents: null,
		expandedPanel: null,
		expandDialog: Dialog.init("analytics-expand-dialog", "dialog"),
		failedFavicons: [],
		filterSections: FilterSections.init(),
		timePicker: TimeRangePicker.init("analytics-time-range"),
		chart: Chart.init(),
		themeColors: null,
		chartRuntime: { _tag: "Loading" },
		refreshVersion: 0,
		isReloading: false,
	}
	return {
		model,
		commands: [
			resolveCommand(model, context, "Load"),
			LoadSignalPresence({ orgId: context.orgId }),
			Command.mapMessage(FilterSections.ReadRemembered(), (message) =>
				Message.GotFilterSectionsMessage({ message }),
			),
			Command.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
		],
	}
}

const searchHref = (search: Search) => hrefOf(AppRoute.Analytics({ search }))

export const routeChanged = (
	model: Model,
	route: { readonly search: Search },
	context: PageContext,
): Return => {
	if (searchHref(model.search) === searchHref(route.search)) return { model }
	// A tab switch unmounts the other tab's cards, and with them their tab, search and sort.
	const isSameTab = tabOf(model.search) === tabOf(route.search)
	const next = { ...model, search: route.search, panels: isSameTab ? model.panels : {} }
	return routeWindowStep(model.search, route.search, {
		resolve: (): Return => ({
			model: next,
			commands: [resolveCommand(next, context, snapModeOf(model.refreshVersion))],
		}),
		requestAll: (mode) => withRequests(next, context, mode),
	})
}

export const contextChanged = (model: Model, context: PageContext): Return =>
	withRequests(model, context, "Load")

const lift = <A>(
	model: Model,
	commands: ReadonlyArray<Command.Command<A, never, Resources>> | undefined,
	wrap: (inner: A) => Message,
	patch: Partial<Model>,
): Return => ({ model: { ...model, ...patch }, commands: Command.mapMessages(commands ?? [], wrap) })

const refreshOnly = (model: Model, context: PageContext, slots: ReadonlyArray<SlotName>): Return =>
	model.window === null ? { model } : requestSlots(model, context, model.window, "Refresh", slots)

/** A failure card's Try again: `Load` asks again only for the slots among `slots` that failed. */
const retryFailed = (model: Model, context: PageContext, slots: ReadonlyArray<SlotName>): Return =>
	model.window === null ? { model } : requestSlots(model, context, model.window, "Load", slots)

/** `onClearFilters`: the window and the tab stay; the filters go. */
const clearedFilters = (search: Search): Search => ({
	startTime: search.startTime,
	endTime: search.endTime,
	timePreset: search.timePreset,
	tab: search.tab,
})

const dialogStep = (model: Model, inner: Dialog.Message): Return => {
	const next = Dialog.update(model.expandDialog, inner)
	const closed = next.outMessage?._tag === "Closed"
	return lift(model, next.commands, (m) => Message.GotExpandDialogMessage({ message: m }), {
		expandDialog: next.model,
		expandedPanel: closed ? null : model.expandedPanel,
	})
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, mode }) =>
			withRequests({ ...model, window, nowMs }, context, mode),
		CompletedFetch: ({ key, result }) => ({ model: delivered(model, key, result) }),
		CompletedLoadSignalPresence: ({ result }) =>
			withRequests(
				seedPanels({ ...model, presence: AsyncData.settle(model.presence, result) }),
				context,
				"Load",
			),
		TickedLivePoll: () => refreshOnly(model, context, ["live"]),
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
			navigate(model, {
				...model.search,
				startTime: undefined,
				endTime: undefined,
				timePreset: DEFAULT_PRESET,
			}),
		ClickedRetrySummary: () => refreshOnly(model, context, ["summary"]),
		ClickedRetryBreakdowns: () => refreshOnly(model, context, ["breakdowns"]),
		ClickedRetrySummaryAndBreakdowns: () => refreshOnly(model, context, ["summary", "breakdowns"]),
		ClickedRetryAiReferrals: () => retryFailed(model, context, ["aiReferrals", "previousAiReferrals"]),
		ClickedRetryAiCrawlers: () => retryFailed(model, context, ["aiCrawlers"]),
		ToggledFilter: ({ key, value }) => {
			const filters = filtersOf(model.search)
			return navigate(model, withFilter(model.search, key, toggleFilterValue(filters[key], value)))
		},
		ChangedFilter: ({ key, value }) => navigate(model, withFilter(model.search, key, value)),
		ToggledTraffic: ({ which, isOn }) =>
			navigate(
				model,
				withFilter(
					model.search,
					"traffic",
					toggleTraffic(filtersOf(model.search).traffic, which, isOn),
				),
			),
		ClickedClearFilters: () => navigate(model, clearedFilters(model.search)),
		PickedMetric: ({ metric }) => ({ model: { ...model, pickedMetric: metric } }),
		PickedPanelTab: ({ panel, index }) => ({
			model: withPanel(model, panel, { pickedTab: index, query: "" }),
		}),
		ChangedPanelQuery: ({ panel, value }) => ({ model: withPanel(model, panel, { query: value }) }),
		ClickedPanelSort: ({ panel, key, current }) => {
			const next = nextSort<"name" | "count" | "views">(current, key, { stringKeys: ["name"] })
			return { model: withPanel(model, panel, { sortKey: next.key, sortDir: next.dir }) }
		},
		ClickedExpandPanel: ({ panel }) => {
			const opened = dialogStep({ ...model, expandedPanel: panel }, Dialog.Message.ClickedTrigger())
			return { ...opened, model: { ...opened.model, expandedPanel: panel } }
		},
		ClickedExpandedRow: ({ key, value }) => {
			const closed = dialogStep(model, Dialog.Message.ClickedClose())
			const filters = filtersOf(model.search)
			return {
				...closed,
				outMessage: navigate(
					model,
					withFilter(model.search, key, toggleFilterValue(filters[key], value)),
				).outMessage,
			}
		},
		FailedFavicon: ({ host }) =>
			model.failedFavicons.includes(host)
				? { model }
				: { model: { ...model, failedFavicons: [...model.failedFavicons, host] } },
		GotExpandDialogMessage: ({ message: inner }) => dialogStep(model, inner),
		GotFilterSectionsMessage: ({ message: inner }) => {
			const next = FilterSections.update(model.filterSections, inner)
			return lift(model, next.commands, (m) => Message.GotFilterSectionsMessage({ message: m }), {
				filterSections: next.model,
			})
		},
		GotTimePickerMessage: ({ message: inner }) => {
			const next = TimeRangePicker.update(model.timePicker, inner)
			const lifted = lift(model, next.commands, (m) => Message.GotTimePickerMessage({ message: m }), {
				timePicker: next.model,
			})
			return next.outMessage === undefined || next.outMessage._tag === "RejectedRange"
				? lifted
				: {
						...lifted,
						outMessage: navigate(model, {
							...model.search,
							...TimeRangePicker.searchPatchOf(next.outMessage),
						}).outMessage,
					}
		},
		GotChartMessage: ({ message: inner }) => {
			const next = Chart.update(model.chart, inner)
			return lift(model, next.commands, (m) => Message.GotChartMessage({ message: m }), {
				chart: next.model,
			})
		},
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
	})
