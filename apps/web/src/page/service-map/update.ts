import { DB_NODE_PREFIX } from "@maple/ui/components/service-map/service-map-utils"
import { Option } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Chart from "../../charts/chart"
import { LoadChartRuntime } from "../../charts/chart-runtime"
import * as Keyed from "../../data/keyed"
import * as ServiceMap from "../../service-map/map/service-map"
import { sameFocus } from "../../service-map/map/state"
import * as Select from "../../ui/select"
import * as Tabs from "../../ui/tabs"
import type { PageContext } from "../contract"
import { SignalPresenceData } from "../kit/signal-presence"
import { routeWindowStep, snapModeOf } from "../kit/route-window"
import * as TimeRangePicker from "../kit/time-range-picker"
import * as Scene3d from "./scene3d"
import { CompleteReloadSpin, LoadSignalPresence, ReadStored, SaveStored } from "./command"
import { DEFAULT_PRESET, focusOf, scopedRows, type Search, sourceGraphOf, withFocus } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import {
	applySteps,
	bundleStep,
	databaseSteps,
	facetsStep,
	navigate,
	requestAll,
	resolveCommand,
	type Return,
	searchHref,
} from "./request"

/** The service panel's tabs (`<Tabs defaultValue="service">`). */
const initServiceTabs = () =>
	Tabs.init({ idBase: 60, values: ["service", "infrastructure"], selected: "service" })

const toMap = (message: ServiceMap.Message) => Message.GotMapMessage({ message })

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const model: Model = {
		search: route.search,
		window: null,
		windowZone: null,
		facetsWindow: null,
		nowMs: 0,
		facets: Keyed.idle(),
		bundle: Keyed.idle(),
		cloudflare: Keyed.idle(),
		planetscaleStats: Keyed.idle(),
		planetscaleInventory: Keyed.idle(),
		hyperdrives: Keyed.idle(),
		stored: Option.none(),
		map: Option.none(),
		dbSummary: Keyed.idle(),
		branchStats: Keyed.idle(),
		serviceTabs: initServiceTabs(),
		dbCharts: { volume: Chart.init(), latency: Chart.init() },
		environmentSelect: Select.init("service-map-environment", {
			value: "production",
			selectedIndex: null,
		}),
		timePicker: TimeRangePicker.init("service-map-time-range"),
		scene3d: Scene3d.init(),
		presence: SignalPresenceData.Loading(),
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
		refreshVersion: 0,
		isReloading: false,
	}
	return {
		model,
		commands: [
			LoadSignalPresence({ orgId: context.orgId }),
			resolveCommand(model, context, "Load"),
			ReadStored({ orgId: context.orgId }),
			Command.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
		],
	}
}

// THE MAP

const merge = (result: Return, next: Return): Return => ({
	model: next.model,
	commands: [...(result.commands ?? []), ...(next.commands ?? [])],
	outMessage: next.outMessage ?? result.outMessage,
})

const panelKind = (selectedId: Option.Option<string>) =>
	Option.map(selectedId, (id) => (id.startsWith(DB_NODE_PREFIX) ? "database" : "service"))

/**
 * What the host does after the map moved: the focus goes to the URL (replace), prefs and drags
 * go to localStorage, and a newly selected database node requests its summary. The service panel's
 * tabs reset when the panel closes or changes kind (not when only the node changes).
 */
const afterMap = (before: Option.Option<ServiceMap.Model>, result: Return, context: PageContext): Return => {
	const { model } = result
	if (Option.isNone(model.map)) return result
	const map = model.map.value
	const previous = Option.getOrUndefined(before)
	const isSaveNeeded =
		previous !== undefined &&
		(previous.minTrafficPct !== map.minTrafficPct ||
			previous.collapsedNamespaces !== map.collapsedNamespaces ||
			previous.snapshots !== map.snapshots)
	const tabs =
		previous !== undefined &&
		Option.getOrNull(panelKind(previous.selectedId)) === Option.getOrNull(panelKind(map.selectedId))
			? model.serviceTabs
			: initServiceTabs()
	const withTabs = { ...model, serviceTabs: tabs }
	const database =
		previous !== undefined && Option.getOrNull(previous.selectedId) === Option.getOrNull(map.selectedId)
			? { model: withTabs }
			: applySteps(withTabs, databaseSteps(withTabs, context, "Load"))
	const focusChanged = !sameFocus(map.focus, focusOf(model.search))
	return {
		model: database.model,
		commands: [
			...(result.commands ?? []),
			...(database.commands ?? []),
			...(isSaveNeeded
				? [
						SaveStored({
							orgId: context.orgId,
							stored: {
								prefs: {
									minTrafficPct: map.minTrafficPct,
									collapsedNamespaces: map.collapsedNamespaces,
								},
								snapshots: map.snapshots,
							},
						}),
					]
				: []),
		],
		outMessage: focusChanged
			? navigate(model, withFocus(model.search, map.focus), true).outMessage
			: result.outMessage,
	}
}

/** Folds a map step into the page: the map Model, its lifted Commands, then `afterMap`. */
const withMapStep = (
	model: Model,
	before: Option.Option<ServiceMap.Model>,
	step: ReturnType<typeof ServiceMap.update>,
	context: PageContext,
): Return =>
	afterMap(
		before,
		{
			model: { ...model, map: Option.some(step.model) },
			commands: Command.mapMessages(step.commands ?? [], toMap),
		},
		context,
	)

/**
 * Rebuild the graph from whatever has landed (`buildFlowElements`): the
 * first time the bundle and the stored prefs are both in, the map is created; later rows refine it.
 */
const syncMap =
	(context: PageContext) =>
	(result: Return): Return => {
		const { model } = result
		const rows = scopedRows(model, context.pinnedNamespace)
		if (model.window === null || rows === null || Option.isNone(model.stored)) return result
		const source = sourceGraphOf(model, rows, model.window)
		const stored = model.stored.value
		const step = Option.match(model.map, {
			onNone: () =>
				ServiceMap.init(source, {
					minTrafficPct: stored.prefs.minTrafficPct,
					collapsedNamespaces: stored.prefs.collapsedNamespaces,
					focus: focusOf(model.search),
					snapshots: stored.snapshots,
				}),
			onSome: (map) => ServiceMap.setSource(map, source),
		})
		return merge(result, withMapStep(model, model.map, step, context))
	}

/** The URL's focus reaches the map (a no-op when the map moved it there itself). */
const applyUrlFocus = (result: Return, context: PageContext): Return =>
	Option.match(result.model.map, {
		onNone: () => result,
		onSome: (map) =>
			merge(
				result,
				withMapStep(
					result.model,
					result.model.map,
					ServiceMap.setFocus(map, focusOf(result.model.search)),
					context,
				),
			),
	})

/** The search changed: a new window re-resolves; the environment re-keys the bundle; focus goes to the map. */
export const routeChanged = (
	model: Model,
	route: { readonly search: Search },
	context: PageContext,
): Return => {
	if (searchHref(model.search) === searchHref(route.search)) return { model }
	// The 3D viewport remounts when the view switches to it, so its state starts over.
	const isEntering3d = route.search.view === "3d" && model.search.view !== "3d"
	const next = { ...model, search: route.search, scene3d: isEntering3d ? Scene3d.init() : model.scene3d }
	const requested = routeWindowStep(model.search, route.search, {
		resolve: (): Return => ({
			model: next,
			commands: [resolveCommand(next, context, snapModeOf(model.refreshVersion))],
		}),
		requestAll: (mode) => requestAll(next, context, mode),
	})
	return applyUrlFocus(requested, context)
}

/** The namespace pin scopes the rows on the client: rebuild the graph. A new zone re-resolves "today". */
export const contextChanged = (model: Model, context: PageContext): Return => {
	const synced = syncMap(context)({ model })
	const isNewZone = model.windowZone !== null && model.windowZone !== context.timeZone
	if (!isNewZone) return synced
	const mode = model.refreshVersion === 0 ? "Load" : "Refresh"
	return { ...synced, commands: [...(synced.commands ?? []), resolveCommand(synced.model, context, mode)] }
}

const withEnvironmentSelect = (model: Model, message: Select.Message): Return => {
	const next = Select.update(model.environmentSelect, message)
	const lifted = {
		model: { ...model, environmentSelect: next.model },
		commands: Command.mapMessages(next.commands ?? [], (inner) =>
			Message.GotEnvironmentSelectMessage({ message: inner }),
		),
	}
	// `handleEnvironmentChange`: "All environments" stays in the URL as `__all__`, so it sticks.
	return next.outMessage === undefined
		? lifted
		: {
				...lifted,
				outMessage: navigate(model, { ...model.search, environment: next.outMessage.value })
					.outMessage,
			}
}

/** The 3D view's step; a pick becomes the map's `onSelect`. */
const withScene3d = (model: Model, message: Scene3d.Message, context: PageContext): Return => {
	const next = Scene3d.update(model.scene3d, message)
	const lifted: Return = {
		model: { ...model, scene3d: next.model },
		commands: Command.mapMessages(next.commands ?? [], (inner) =>
			Message.GotScene3dMessage({ message: inner }),
		),
	}
	if (next.outMessage === undefined) return lifted
	const picked = ServiceMap.Message.PickedNode({ nodeId: next.outMessage.nodeId })
	return Option.match(lifted.model.map, {
		onNone: () => lifted,
		onSome: (map) =>
			merge(
				lifted,
				withMapStep(lifted.model, lifted.model.map, ServiceMap.update(map, picked), context),
			),
	})
}

const withTimePicker = (model: Model, message: TimeRangePicker.Message): Return => {
	const next = TimeRangePicker.update(model.timePicker, message)
	const lifted = {
		model: { ...model, timePicker: next.model },
		commands: Command.mapMessages(next.commands ?? [], (inner) =>
			Message.GotTimePickerMessage({ message: inner }),
		),
	}
	// `applyTimeRangeSearch` with a preset: the absolute bounds leave the URL.
	return next.outMessage === undefined || next.outMessage._tag === "RejectedRange"
		? TimeRangePicker.unpicked(lifted, next.outMessage)
		: {
				...lifted,
				outMessage: navigate(model, {
					...model.search,
					...TimeRangePicker.searchPatchOf(next.outMessage),
				}).outMessage,
			}
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, timeZone, facetsWindow, nowMs, mode }) =>
			// The facets window is minted once per visit and kept.
			requestAll(
				{
					...model,
					window,
					windowZone: timeZone,
					facetsWindow: model.facetsWindow ?? facetsWindow,
					nowMs,
				},
				context,
				mode,
			),
		CompletedReadStored: ({ stored }) =>
			syncMap(context)({ model: { ...model, stored: Option.some(stored) } }),
		CompletedSaveStored: () => ({ model }),
		// The default environment can move once facets land (a confirmed no-production org).
		CompletedFetchFacets: ({ key, result }) => {
			const next = { ...model, facets: Keyed.accept(model.facets, key, result) }
			const rekeyed = applySteps(next, [bundleStep(next, context, "Load")])
			// Only a new environment re-asks; the same key keeps its answer, a failure included.
			return rekeyed.model.bundle.key === model.bundle.key ? { model: next } : rekeyed
		},
		CompletedFetchBundle: ({ key, result }) =>
			syncMap(context)({ model: { ...model, bundle: Keyed.accept(model.bundle, key, result) } }),
		CompletedFetchCloudflare: ({ key, result }) =>
			syncMap(context)({
				model: { ...model, cloudflare: Keyed.accept(model.cloudflare, key, result) },
			}),
		CompletedFetchPlanetScaleStats: ({ key, result }) =>
			syncMap(context)({
				model: { ...model, planetscaleStats: Keyed.accept(model.planetscaleStats, key, result) },
			}),
		CompletedFetchPlanetScaleInventory: ({ key, result }) =>
			syncMap(context)({
				model: {
					...model,
					planetscaleInventory: Keyed.accept(model.planetscaleInventory, key, result),
				},
			}),
		CompletedFetchHyperdrives: ({ key, result }) =>
			syncMap(context)({
				model: { ...model, hyperdrives: Keyed.accept(model.hyperdrives, key, result) },
			}),
		CompletedFetchDbSummary: ({ key, result }) => ({
			model: { ...model, dbSummary: Keyed.accept(model.dbSummary, key, result) },
		}),
		CompletedFetchBranchStats: ({ key, result }) => ({
			model: { ...model, branchStats: Keyed.accept(model.branchStats, key, result) },
		}),
		CompletedLoadSignalPresence: ({ result }) => ({
			model: { ...model, presence: AsyncData.settle(model.presence, result) },
		}),
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
		ClickedRetryFacets: () => applySteps(model, [facetsStep(model, context, "Refresh")]),
		ClickedResetTimeRange: () =>
			navigate(model, {
				...model.search,
				startTime: undefined,
				endTime: undefined,
				timePreset: DEFAULT_PRESET,
			}),
		ClickedView: ({ view }) => navigate(model, { ...model.search, view }),
		GotMapMessage: ({ message: inner }) =>
			Option.match(model.map, {
				onNone: () => ({ model }),
				onSome: (map) => withMapStep(model, model.map, ServiceMap.update(map, inner), context),
			}),
		GotEnvironmentSelectMessage: ({ message: inner }) => withEnvironmentSelect(model, inner),
		GotScene3dMessage: ({ message: inner }) => withScene3d(model, inner, context),
		GotTimePickerMessage: ({ message: inner }) => withTimePicker(model, inner),
		GotServiceTabsMessage: ({ message: inner }) => {
			const next = Tabs.update(model.serviceTabs, inner)
			return {
				model: { ...model, serviceTabs: next.model },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotServiceTabsMessage({ message: m }),
				),
			}
		},
		GotChartMessage: ({ chart, message: inner }) => {
			const next = Chart.update(model.dbCharts[chart], inner)
			return {
				model: { ...model, dbCharts: { ...model.dbCharts, [chart]: next.model } },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotChartMessage({ chart, message: m }),
				),
			}
		},
	})
