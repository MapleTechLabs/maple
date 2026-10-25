import { formatWarehouseDateTime, parseWarehouseDateTime, snapRangeForCache } from "@maple/query-engine"
import { Option } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Chart from "../../charts/chart"
import { LoadChartRuntime } from "../../charts/chart-runtime"
import * as Keyed from "../../data/keyed"
import { requestKey } from "../../data/request-key"
import { resolveWindow, type TimeWindow } from "../../data/time-range"
import type { Resources } from "../../platform/resources"
import { AppRoute, hrefOf } from "../../route"
import type { HomeSearch } from "../../route/search"
import * as Select from "../../ui/select"
import { type PageContext, PageOutMessage, type PageReturn } from "../contract"
import { SignalPresenceData } from "../kit/signal-presence"
import * as TimeRangePicker from "../kit/time-range-picker"
import {
	DEFAULT_HINT,
	FetchAnomalies,
	FetchFacets,
	FetchLogSeries,
	FetchOverviewSeries,
	FetchRefinement,
	FetchSnapshot,
	FetchUsage,
	type LogInput,
	LoadSignalPresence,
	ReadEntry,
	ResolveClock,
	SaveFacetsHint,
	CompleteReloadSpin,
	type RefinementInput,
	type ScopedInput,
	type UsageInput,
} from "./command"
import {
	ALL_ENVIRONMENTS,
	canFetch,
	derivedHint,
	environmentFilter,
	facetsReady,
	timePresetOf,
} from "./derive"
import { Message, type RequestMode, type RetryTarget } from "./message"
import { IncidentsData, type Model, RulesData } from "./model"
import { isClerkAuthEnabled } from "../../lib/services/common/auth-mode"
import { storageKeyOf } from "../onboarding/quick-start-state"
import type * as SetupChecklist from "./setup-checklist"
import { Message as SetupMessage } from "./setup-checklist"
import * as Setup from "./setup-checklist-update"

export type Return = PageReturn<Model, Message>
type Search = typeof HomeSearch.Type

/** The grid's cards, in `OVERVIEW_CHARTS` order. */
export const CHART_IDS = ["throughput", "error-rate", "latency", "log-volume"] as const

const FACETS_RANGE_MS = 24 * 60 * 60 * 1000

/** `facetsRange`: a fixed 24 h, snapped to the cache grid, once per mount. */
const facetsWindowAt = (nowMs: number): TimeWindow =>
	snapRangeForCache({
		startTime: formatWarehouseDateTime(nowMs - FACETS_RANGE_MS),
		endTime: formatWarehouseDateTime(nowMs),
	})

/** `useEffectiveTimeRange` for the URL and the current default preset; snapped until a Reload. */
export const windowOf = (model: Model, context: PageContext, nowMs: number): TimeWindow =>
	resolveWindow(
		{
			startTime: model.search.startTime,
			endTime: model.search.endTime,
			preset: timePresetOf(model),
			snap: model.refreshVersion === 0,
			timeZone: context.timeZone,
		},
		nowMs,
	)

/** `shiftRangeBack`: the equally long window that ends where this one starts. */
export const usageInput = (window: TimeWindow): UsageInput => {
	const start = parseWarehouseDateTime(window.startTime)
	const end = parseWarehouseDateTime(window.endTime)
	if (!Number.isFinite(start) || !Number.isFinite(end)) return window
	return {
		...window,
		previousStartTime: formatWarehouseDateTime(start - (end - start)),
		previousEndTime: formatWarehouseDateTime(start),
	}
}

// REQUESTS

type Step = Readonly<{
	patch: Partial<Model>
	commands: ReadonlyArray<Command.Command<Message, never, Resources>>
}>

const NONE: Step = { patch: {}, commands: [] }

/** One `Keyed.request`: `Some` writes the slot and returns its fetch (S6). */
const keyed = <A, E>(
	slot: Keyed.Keyed<A, E>,
	key: string,
	mode: Keyed.RequestMode,
	write: (next: Keyed.Keyed<A, E>) => Partial<Model>,
	fetch: (key: string) => Command.Command<Message, never, Resources>,
): Step =>
	// `sync` runs after every answer, so a failed key is not loaded again until a retry or Reload.
	mode === "Load" && slot.key === key && AsyncData.isFailure(slot.data)
		? NONE
		: Option.match(Keyed.request(slot, key, mode), {
				onNone: () => NONE,
				onSome: (next) => ({ patch: write(next), commands: [fetch(key)] }),
			})

/** Steps run in order, each against the Model the previous ones patched. */
const runSteps = (model: Model, steps: ReadonlyArray<(model: Model) => Step>, prior?: Return): Return =>
	steps.reduce<Return>((result, step) => {
		const next = step(result.model)
		return {
			...result,
			model: { ...result.model, ...next.patch },
			commands: [...(result.commands ?? []), ...next.commands],
		}
	}, prior ?? { model })

const environmentsInput = (model: Model) => {
	const environments = environmentFilter(model)
	return environments === undefined ? {} : { environments }
}

export const scopedInput = (model: Model, window: TimeWindow): ScopedInput => ({
	startTime: window.startTime,
	endTime: window.endTime,
	...environmentsInput(model),
})

/** Sampling verdict from the loaded overview series (`overviewSamplingActive`). */
const samplingActive = (model: Model): boolean =>
	canFetch(model) &&
	Option.match(AsyncData.getData(model.overviewSeries.data), {
		onNone: () => false,
		onSome: (rows) => rows.some((row) => row.hasSampling === true),
	})

/** Sent on mount: facets, open anomaly counts and the usage cards. */
const alwaysSteps = (
	context: PageContext,
	facetsWindow: TimeWindow,
	window: TimeWindow,
	mode: RequestMode,
): ReadonlyArray<(model: Model) => Step> => {
	const usage = usageInput(window)
	return [
		(model) =>
			keyed(
				model.facets,
				requestKey(context.orgId, "getServicesFacets", { data: facetsWindow }),
				// Reload leaves the facets probe alone (`useAtomValue`, not refreshable).
				"Load",
				(facets) => ({ facets }),
				(key) => FetchFacets({ key, window: facetsWindow, refresh: false }),
			),
		(model) =>
			keyed(
				model.anomalies,
				requestKey(context.orgId, "anomalies.serviceCounts", { status: "open" }),
				mode,
				(anomalies) => ({ anomalies }),
				(key) => FetchAnomalies({ key, refresh: mode === "Refresh" }),
			),
		(model) =>
			keyed(
				model.usage,
				requestKey(context.orgId, "getServiceUsage", { data: usage }),
				mode,
				(next) => ({ usage: next }),
				(key) => FetchUsage({ key, input: usage }),
			),
	]
}

/** Sent once `canFetch`: health snapshot, overview series, log volume, then the refinement. */
const gatedSteps = (
	context: PageContext,
	window: TimeWindow,
	mode: RequestMode,
): ReadonlyArray<(model: Model) => Step> => [
	(model) => {
		const input = scopedInput(model, window)
		return keyed(
			model.snapshot,
			requestKey(context.orgId, "getServiceHealthSnapshot", { data: input }),
			mode,
			(snapshot) => ({ snapshot }),
			(key) => FetchSnapshot({ key, input }),
		)
	},
	(model) => {
		const input = scopedInput(model, window)
		return keyed(
			model.overviewSeries,
			requestKey(context.orgId, "getOverviewTimeSeries", { data: input }),
			mode,
			(overviewSeries) => ({ overviewSeries }),
			(key) => FetchOverviewSeries({ key, input }),
		)
	},
	(model) => {
		const input: LogInput = {
			...scopedInput(model, window),
			namespaces: context.pinnedNamespace === null ? undefined : [context.pinnedNamespace],
		}
		return keyed(
			model.logSeries,
			requestKey(context.orgId, "getCustomChartTimeSeries", { data: input }),
			mode,
			(logSeries) => ({ logSeries }),
			(key) => FetchLogSeries({ key, input }),
		)
	},
	(model) => {
		const input: RefinementInput = {
			...scopedInput(model, window),
			samplingActive: samplingActive(model),
		}
		// The function answers `[]` without a request unless sampling is on over every environment.
		return !input.samplingActive || input.environments !== undefined
			? NONE
			: keyed(
					model.refinement,
					requestKey(context.orgId, "getOverviewThroughputRefinement", { data: input }),
					mode,
					(refinement) => ({ refinement }),
					(key) => FetchRefinement({ key, input }),
				)
	},
]

const isSameHint = (a: Model["hint"], b: Model["hint"]) =>
	a.environment === b.environment && a.preset === b.preset && a.seen === b.seen

/** `FacetsHintPersister`: once facets are ready, store the derived defaults when they changed. */
const persistHint =
	(context: PageContext) =>
	(model: Model): Step => {
		if (!facetsReady(model)) return NONE
		const hint = derivedHint(model)
		return isSameHint(hint, model.hint)
			? NONE
			: { patch: { hint }, commands: [SaveFacetsHint({ orgId: context.orgId, hint })] }
	}

/**
 * Every query the page reads, keyed by its inputs, for the current Model. Idempotent under
 * `Load`: a slot already holding (or loading) its key sends nothing, so any Message may re-run it.
 */
export const sync = (model: Model, context: PageContext, mode: RequestMode): Return => {
	const { nowMs, facetsWindow } = model
	if (nowMs === null || facetsWindow === null) return { model }
	const window = windowOf(model, context, nowMs)
	return runSteps({ ...model, window }, [
		...alwaysSteps(context, facetsWindow, window, mode),
		...(canFetch(model) ? gatedSteps(context, window, mode) : []),
		persistHint(context),
	])
}

// SETUP CHECKLIST

/** Runs a setup-checklist step on top of `result`, lifting its Commands and OutMessage. */
const withSetup = (
	result: Return,
	step: (setup: SetupChecklist.Model) => PageReturn<SetupChecklist.Model, SetupChecklist.Message>,
): Return => {
	const setup = result.model.setup
	if (setup === null) return result
	const next = step(setup)
	const lifted: Return = {
		...result,
		model: { ...result.model, setup: next.model },
		commands: [
			...(result.commands ?? []),
			...Command.mapMessages(next.commands ?? [], (message) => Message.GotSetupMessage({ message })),
		],
	}
	return next.outMessage === undefined ? lifted : { ...lifted, outMessage: next.outMessage }
}

/** `useIngestConnection`'s `useEffectiveTimeRange(undefined, undefined, "1h")`. */
const resolveSetupWindow = (result: Return, context: PageContext): Return => {
	const nowMs = result.model.nowMs
	if (nowMs === null) return result
	const window = resolveWindow(
		{ preset: "1h", snap: result.model.refreshVersion === 0, timeZone: context.timeZone },
		nowMs,
	)
	return withSetup(result, (setup) => Setup.windowResolved(setup, window, context.pinnedNamespace))
}

// NAVIGATION

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.Home({ search })),
		isReplace: false,
	}),
})

// ENTRY POINTS

const loadChartRuntime = () =>
	Command.mapMessage(LoadChartRuntime(), (message) =>
		message._tag === "CompletedLoadChartRuntime"
			? Message.CompletedLoadChartRuntime()
			: Message.FailedLoadChartRuntime({ reason: message.reason }),
	)

/** `init`, with the Clerk gate as an input (`{isClerkAuthEnabled && <SetupChecklist />}`). */
export const initWith =
	(isClerk: boolean) =>
	(route: { readonly search: Search }, context: PageContext): Return => {
		const setup = isClerk ? Setup.init(storageKeyOf(Option.some(context.orgId))) : null
		const model: Model = {
			search: route.search,
			nowMs: null,
			hint: DEFAULT_HINT,
			facetsWindow: null,
			window: null,
			facets: Keyed.idle(),
			snapshot: Keyed.idle(),
			anomalies: Keyed.idle(),
			usage: Keyed.idle(),
			overviewSeries: Keyed.idle(),
			logSeries: Keyed.idle(),
			refinement: Keyed.idle(),
			incidents: IncidentsData.Loading(),
			rules: RulesData.Loading(),
			presence: SignalPresenceData.Loading(),
			environmentSelect: Select.init("overview-environment", {
				value: ALL_ENVIRONMENTS,
				selectedIndex: 0,
			}),
			timePicker: TimeRangePicker.init("overview-time-range"),
			charts: Object.fromEntries(CHART_IDS.map((id) => [id, Chart.init()])),
			chartRuntime: { _tag: "Loading" },
			themeColors: null,
			refreshVersion: 0,
			isReloading: false,
			setup: setup?.model ?? null,
		}
		return {
			model,
			commands: [
				ReadEntry({ orgId: context.orgId }),
				LoadSignalPresence({ orgId: context.orgId }),
				...Command.mapMessages(setup?.commands ?? [], (message) =>
					Message.GotSetupMessage({ message }),
				),
				loadChartRuntime(),
			],
		}
	}

const searchHref = (search: Search) => hrefOf(AppRoute.Home({ search }))

/** The search changed (environment, window): re-resolve and re-request. */
export const routeChanged = (
	model: Model,
	route: { readonly search: Search },
	context: PageContext,
): Return =>
	searchHref(model.search) === searchHref(route.search)
		? { model }
		: sync({ ...model, search: route.search }, context, "Load")

export const init = initWith(isClerkAuthEnabled)

/** Back after leaving: the last data stays on screen while entry re-reads the clock (snapped, so cached reads serve). */
export const revive = (model: Model, route: { readonly search: Search }, context: PageContext): Return => {
	// The open-anomalies key never changes, so entry alone would keep the parked counts.
	const anomaliesKey = requestKey(context.orgId, "anomalies.serviceCounts", { status: "open" })
	const anomalies = Keyed.request(Keyed.forgetFailure(model.anomalies), anomaliesKey, "Refresh")
	// A runtime that failed before parking is asked for again, as entry does.
	const isRuntimeFailed = model.chartRuntime._tag === "Failed"
	const revived: Return = {
		model: {
			...model,
			search: route.search,
			refreshVersion: 0,
			isReloading: false,
			facets: Keyed.forgetFailure(model.facets),
			snapshot: Keyed.forgetFailure(model.snapshot),
			anomalies: Option.getOrElse(anomalies, () => model.anomalies),
			usage: Keyed.forgetFailure(model.usage),
			overviewSeries: Keyed.forgetFailure(model.overviewSeries),
			logSeries: Keyed.forgetFailure(model.logSeries),
			refinement: Keyed.forgetFailure(model.refinement),
			charts: Object.fromEntries(CHART_IDS.map((id) => [id, Chart.init()])),
			chartRuntime: isRuntimeFailed ? { _tag: "Loading" } : model.chartRuntime,
		},
		commands: [
			ReadEntry({ orgId: context.orgId }),
			LoadSignalPresence({ orgId: context.orgId }),
			...(Option.isSome(anomalies) ? [FetchAnomalies({ key: anomaliesKey, refresh: false })] : []),
			...(isRuntimeFailed ? [loadChartRuntime()] : []),
		],
	}
	return withSetup(revived, Setup.revived)
}

export const contextChanged = (model: Model, context: PageContext): Return =>
	resolveSetupWindow(sync(model, context, "Load"), context)

/** Retry (`useAtomRefresh` on a failed read): forget the slot, so the next sync requests it again. */
const RETRY_SLOT = {
	Facets: "facets",
	Overview: "overviewSeries",
	LogVolume: "logSeries",
	Refinement: "refinement",
} as const satisfies Record<RetryTarget, keyof Model>

const retry = (model: Model, context: PageContext, target: RetryTarget): Return => {
	// Cards sharing a target each offer a retry: one request in flight answers them all.
	const slot: Keyed.Keyed<unknown, unknown> = model[RETRY_SLOT[target]]
	if (AsyncData.isPending(slot.data)) return { model }
	const { facetsWindow } = model
	// Facets are shared with the shell through the probe, which keeps a failure until refreshed.
	return target === "Facets" && facetsWindow !== null && model.facets.key !== null
		? runSteps(model, [
				(current) =>
					keyed(
						current.facets,
						current.facets.key ?? "",
						"Refresh",
						(facets) => ({ facets }),
						(key) => FetchFacets({ key, window: facetsWindow, refresh: true }),
					),
			])
		: sync({ ...model, [RETRY_SLOT[target]]: Keyed.idle() }, context, "Load")
}

/** Forget every failed card read so the next sync requests them, then retry the facets read. */
const retryPage = (model: Model, context: PageContext): Return => {
	const synced = sync(
		{
			...model,
			snapshot: Keyed.forgetFailure(model.snapshot),
			anomalies: Keyed.forgetFailure(model.anomalies),
			usage: Keyed.forgetFailure(model.usage),
			overviewSeries: Keyed.forgetFailure(model.overviewSeries),
			logSeries: Keyed.forgetFailure(model.logSeries),
			refinement: Keyed.forgetFailure(model.refinement),
		},
		context,
		"Load",
	)
	const facets = retry(synced.model, context, "Facets")
	const retried: Return = { model: facets.model, commands: [...(synced.commands ?? []), ...(facets.commands ?? [])] }
	// One strip can stand for a setup failure too; its own poll is the setup card's retry.
	const setup = facets.model.setup
	return setup !== null && AsyncData.isFailure(setup.services)
		? withSetup(retried, (current) => Setup.update(current, SetupMessage.TickedPoll(), context))
		: retried
}

const withPicker = (model: Model, message: TimeRangePicker.Message): Return => {
	const next = TimeRangePicker.update(model.timePicker, message)
	const lifted = {
		model: { ...model, timePicker: next.model },
		commands: Command.mapMessages(next.commands, (picker) =>
			Message.GotTimePickerMessage({ message: picker }),
		),
	}
	// `applyTimeRangeSearch` with a preset: the absolute bounds leave the URL.
	return next.outMessage === undefined || next.outMessage._tag === "RejectedRange"
		? lifted
		: {
				...lifted,
				outMessage: navigate(model, {
					...model.search,
					...TimeRangePicker.searchPatchOf(next.outMessage),
				}).outMessage,
			}
}

const withEnvironmentSelect = (model: Model, message: Select.Message): Return => {
	const next = Select.update(model.environmentSelect, message)
	const lifted = {
		model: { ...model, environmentSelect: next.model },
		commands: Command.mapMessages(next.commands, (inner) =>
			Message.GotEnvironmentSelectMessage({ message: inner }),
		),
	}
	// `handleEnvironmentChange`: "All environments" leaves the URL.
	return next.outMessage === undefined
		? lifted
		: {
				...lifted,
				outMessage: navigate(model, {
					...model.search,
					environment:
						next.outMessage.value === ALL_ENVIRONMENTS ? undefined : next.outMessage.value,
				}).outMessage,
			}
}

const withChart = (model: Model, chartId: string, message: Chart.Message): Return => {
	const chart = model.charts[chartId]
	if (chart === undefined) return { model }
	const next = Chart.update(chart, message)
	return {
		model: { ...model, charts: { ...model.charts, [chartId]: next.model } },
		commands: Command.mapMessages(next.commands ?? [], (inner) =>
			Message.GotChartMessage({ chartId, message: inner }),
		),
	}
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedMountLinkedCursor: () => ({ model }),
		CompletedReadEntry: ({ nowMs, hint }) =>
			resolveSetupWindow(
				sync({ ...model, nowMs, hint, facetsWindow: facetsWindowAt(nowMs) }, context, "Load"),
				context,
			),
		CompletedResolveClock: ({ nowMs }) =>
			resolveSetupWindow(sync({ ...model, nowMs }, context, "Refresh"), context),
		CompletedFetchFacets: ({ key, result }) =>
			sync({ ...model, facets: Keyed.accept(model.facets, key, result) }, context, "Load"),
		CompletedFetchSnapshot: ({ key, result }) => ({
			model: { ...model, snapshot: Keyed.accept(model.snapshot, key, result) },
		}),
		CompletedFetchAnomalies: ({ key, result }) => ({
			model: { ...model, anomalies: Keyed.accept(model.anomalies, key, result) },
		}),
		CompletedFetchUsage: ({ key, result }) => ({
			model: { ...model, usage: Keyed.accept(model.usage, key, result) },
		}),
		CompletedFetchOverviewSeries: ({ key, result }) =>
			sync(
				{ ...model, overviewSeries: Keyed.accept(model.overviewSeries, key, result) },
				context,
				"Load",
			),
		CompletedFetchLogSeries: ({ key, result }) => ({
			model: { ...model, logSeries: Keyed.accept(model.logSeries, key, result) },
		}),
		CompletedFetchRefinement: ({ key, result }) => ({
			model: { ...model, refinement: Keyed.accept(model.refinement, key, result) },
		}),
		CompletedSaveFacetsHint: () => ({ model }),
		UpdatedIncidents: ({ orgId, incidents }) =>
			orgId === context.orgId
				? { model: { ...model, incidents: IncidentsData.Success({ data: incidents }) } }
				: { model },
		FailedLoadIncidents: ({ orgId }) =>
			orgId === context.orgId && AsyncData.isLoading(model.incidents)
				? { model: { ...model, incidents: IncidentsData.Failure({ error: "Unavailable" }) } }
				: { model },
		FailedLoadRules: ({ orgId }) =>
			orgId === context.orgId && AsyncData.isLoading(model.rules)
				? { model: { ...model, rules: RulesData.Failure({ error: "Unavailable" }) } }
				: { model },
		UpdatedRules: ({ orgId, enabled }) =>
			orgId === context.orgId
				? { model: { ...model, rules: RulesData.Success({ data: enabled }) } }
				: { model },
		UpdatedRuleStates: () => ({ model }),
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
				commands: [ResolveClock(), CompleteReloadSpin({ version: reloaded.refreshVersion })],
			}
		},
		CompletedReloadSpin: ({ version }) =>
			version === model.refreshVersion ? { model: { ...model, isReloading: false } } : { model },
		ClickedRetry: ({ target }) => retry(model, context, target),
		ClickedRetryPage: () => retryPage(model, context),
		ClickedResetTimeRange: () =>
			navigate(model, {
				...model.search,
				startTime: undefined,
				endTime: undefined,
				timePreset: undefined,
			}),
		GotEnvironmentSelectMessage: ({ message: inner }) => withEnvironmentSelect(model, inner),
		GotTimePickerMessage: ({ message: inner }) => withPicker(model, inner),
		GotChartMessage: ({ chartId, message: inner }) => withChart(model, chartId, inner),
		GotSetupMessage: ({ message: inner }) =>
			withSetup({ model }, (setup) => Setup.update(setup, inner, context)),
	})
