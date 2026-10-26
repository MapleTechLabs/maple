import { UPTIME_LIST_LIMIT } from "../../alerts/shared/uptime-commands"
import { ENDPOINTS_LIMIT } from "../../../components/services/service-endpoints"
import { buildServiceOpenIssuesQuery } from "../../../lib/services/error-issues"
import { parseWarehouseDateTime } from "@maple/query-engine"
import { Option, type Result } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Chart from "../../../charts/chart"
import { LoadChartRuntime } from "../../../charts/chart-runtime"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import { commitDetailKey } from "../../kit/commit-card"
import { resolveWindow, type TimeWindow } from "../../../data/time-range"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import * as Select from "../../../ui/select"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import * as TimeRangePicker from "../../kit/time-range-picker"
import {
	CompleteReloadSpin,
	type DetailInput,
	ResolveClock,
	FetchApiOverview,
	FetchCommit,
	FetchDependencies,
	FetchEndpointSeries,
	FetchEndpoints,
	FetchStatusBreakdown,
	FetchIssues,
	FetchOperations,
	FetchOverview,
	FetchRefinement,
	FetchUptimeMonitors,
	FetchUsage,
	FetchWorkloads,
} from "./command"
import {
	ALL_ENVIRONMENTS,
	DEFAULT_PRESET,
	environmentsOf,
	ISSUES_DETAIL_LIMIT_MS,
	OPERATIONS_LIMIT,
	apiBucketSeconds,
	operationsBucketSeconds,
	previousWindow,
	type ServiceTab,
	singleDeploymentEnv,
	tabOf,
	windowSeconds,
} from "./derive"
import { commitMarkers, markerShas } from "./derive-markers"
import { initialSort, nextSort, operationTraceSearch, TRACE_DETAIL_LIMIT_SECONDS } from "./derive-tables"
import { deriveDeploys, isResolvableSha } from "./derive-panels"
import { matchesFilter } from "./derive-api"
import * as EndpointPeek from "./endpoint-peek/model"
import * as EndpointPeekUpdate from "./endpoint-peek/update"
import { Message, type RequestMode } from "./message"
import type { Commit, CommitFailure, Model } from "./model"
import type { Endpoint } from "./model-tabs"
import { groupsOf, visibleEndpoints } from "./view-api"

export type Return = PageReturn<Model, Message>

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
const runSteps = (model: Model, steps: ReadonlyArray<(model: Model) => Step>): Return =>
	steps.reduce<Return>(
		(result, step) => {
			const next = step(result.model)
			return {
				...result,
				model: { ...result.model, ...next.patch },
				commands: [...(result.commands ?? []), ...next.commands],
			}
		},
		{ model },
	)

/** `useEffectiveTimeRange(startTime, endTime, timePreset ?? "12h")`; snapped until a Reload. */
export const windowOf = (model: Model, context: PageContext, nowMs: number): TimeWindow =>
	resolveWindow(
		{
			startTime: model.search.startTime,
			endTime: model.search.endTime,
			preset: model.search.timePreset ?? DEFAULT_PRESET,
			snap: model.refreshVersion === 0,
			timeZone: context.timeZone,
		},
		nowMs,
	)

/** `environments` stays `undefined` for every environment; keys and payloads drop it like a missing field. */
export const detailInput = (model: Model, window: TimeWindow): DetailInput => ({
	serviceName: model.serviceName,
	startTime: window.startTime,
	endTime: window.endTime,
	environments: environmentsOf(model.search),
})

// REQUESTS

type Steps = ReadonlyArray<(model: Model) => Step>

/** The header's environment switcher reads the overview on every tab (`ServiceEnvironmentSwitcher`). */
const overviewStep =
	(context: PageContext, window: TimeWindow, mode: RequestMode) =>
	(model: Model): Step => {
		const input = detailInput(model, window)
		return keyed(
			model.overview,
			requestKey(context.orgId, "getServiceDetailOverview", { data: input }),
			mode,
			(overview) => ({ overview }),
			(key) => FetchOverview({ key, input }),
		)
	}

/** `getServiceOperationsResultAtom`: the Overview panel and the Operations tab share the key. */
const operationsStep =
	(context: PageContext, window: TimeWindow, mode: RequestMode) =>
	(model: Model): Step => {
		const input = {
			...detailInput(model, window),
			bucketSeconds: operationsBucketSeconds(window),
			limit: OPERATIONS_LIMIT,
		}
		return keyed(
			model.operations,
			requestKey(context.orgId, "getServiceOperations", { data: input }),
			mode,
			(operations) => ({ operations }),
			(key) => FetchOperations({ key, input }),
		)
	}

/** `getServiceDependenciesBundleResultAtom`: the strip and the Dependencies tab share the key. */
const dependenciesStep =
	(context: PageContext, window: TimeWindow, mode: RequestMode) =>
	(model: Model): Step => {
		const input = {
			serviceName: model.serviceName,
			startTime: window.startTime,
			endTime: window.endTime,
			deploymentEnv: singleDeploymentEnv(environmentsOf(model.search)),
		}
		return keyed(
			model.dependencies,
			requestKey(context.orgId, "getServiceDependenciesBundle", { data: input }),
			mode,
			(dependencies) => ({ dependencies }),
			(key) => FetchDependencies({ key, input }),
		)
	}

/** Sampling verdict from the loaded overview (`samplingActive`), part of the refinement key. */
const samplingActive = (model: Model): boolean =>
	Option.match(AsyncData.getData(model.overview.data), {
		onNone: () => false,
		onSome: (overview) => overview.points.some((point) => point.hasSampling),
	})

/** `ServiceErrorsPanel`'s query: one selected environment scopes it to the window, capped at 90 days. */
const issuesQuery = (model: Model, window: TimeWindow) => {
	const environments = environmentsOf(model.search)
	const environment = environments?.length === 1 ? environments[0] : undefined
	const endMs = parseWarehouseDateTime(window.endTime)
	const isLimited = endMs - parseWarehouseDateTime(window.startTime) > ISSUES_DETAIL_LIMIT_MS
	return buildServiceOpenIssuesQuery(model.serviceName, {
		environment,
		startTime: isLimited ? new Date(endMs - ISSUES_DETAIL_LIMIT_MS).toISOString() : window.startTime,
		endTime: window.endTime,
	})
}

/** Every sha the Overview resolves: the marker labels and the resolvable deploy rows on screen. */
const overviewShas = (model: Model): ReadonlyArray<string> =>
	Option.match(AsyncData.getData(model.overview.data), {
		onNone: () => [],
		onSome: (overview) => {
			const buckets = overview.points.map((point) => point.bucket)
			const markers = commitMarkers(overview.releases, buckets, model.commits)
			const deploys = deriveDeploys(overview.releases)
			const visible = deploys.slice(0, model.isDeploysExpanded ? DEPLOYS_EXPANDED : DEPLOYS_RAIL)
			return [
				...new Set([
					...markerShas(markers),
					...visible.flatMap((deploy) => (isResolvableSha(deploy.sha) ? [deploy.sha] : [])),
				]),
			]
		},
	})

export const DEPLOYS_RAIL = 8
export const DEPLOYS_EXPANDED = 50

/** `commitQueryAtom(sha)` is cached per sha for the page's life; only missing ones are requested. */
const commitsStep =
	(context: PageContext) =>
	(model: Model): Step => {
		const missing = overviewShas(model).filter((sha) => model.commits[sha] === undefined)
		return missing.length === 0
			? NONE
			: {
					patch: {
						commits: {
							...model.commits,
							...Object.fromEntries(missing.map((sha) => [sha, AsyncData.Loading()])),
						},
					},
					commands: missing.map((sha) =>
						FetchCommit({ key: commitDetailKey(context.orgId, sha), sha }),
					),
				}
	}

/** What `OverviewTab` mounts: the panels' reads, the refinement once sampling shows, the commits. */
const overviewTabSteps = (context: PageContext, window: TimeWindow, mode: RequestMode): Steps => [
	operationsStep(context, window, mode),
	(model) => {
		const query = issuesQuery(model, window)
		// A plain `useAtomValue`: Reload re-requests it only when its key moved (an environment's window).
		return keyed(
			model.issues,
			requestKey(context.orgId, "errorIssues.list", { query }),
			"Load",
			(issues) => ({ issues }),
			(key) => FetchIssues({ key, query }),
		)
	},
	(model) => {
		const input = { service: model.serviceName, ...window, ...previousWindow(window) }
		return keyed(
			model.usage,
			requestKey(context.orgId, "getServiceUsage", { data: input }),
			mode,
			(usage) => ({ usage }),
			(key) => FetchUsage({ key, input }),
		)
	},
	(model) => {
		const input = { services: [model.serviceName], ...window }
		return keyed(
			model.workloads,
			requestKey(context.orgId, "getServiceWorkloads", { data: input }),
			mode,
			(workloads) => ({ workloads }),
			(key) => FetchWorkloads({ key, input }),
		)
	},
	dependenciesStep(context, window, mode),
	(model) => {
		const input = { ...detailInput(model, window), samplingActive: samplingActive(model) }
		// The function answers `[]` without a request unless sampling is on over every environment.
		return !input.samplingActive || input.environments !== undefined
			? NONE
			: keyed(
					model.refinement,
					requestKey(context.orgId, "getServiceDetailThroughputRefinement", { data: input }),
					// `useAtomValue` too: only a moved key re-requests it.
					"Load",
					(refinement) => ({ refinement }),
					(key) => FetchRefinement({ key, input }),
				)
	},
	commitsStep(context),
	// Not windowed: a Reload revalidates it, a window change leaves it alone.
	(model) =>
		keyed(
			model.uptimeMonitors,
			requestKey(context.orgId, "uptimeMonitors.list", { query: { limit: UPTIME_LIST_LIMIT } }),
			mode,
			(uptimeMonitors) => ({ uptimeMonitors }),
			(key) => FetchUptimeMonitors({ key }),
		),
]

const tabSteps = (model: Model, context: PageContext, window: TimeWindow, mode: RequestMode): Steps => {
	switch (tabOf(model.search)) {
		case "overview":
			return overviewTabSteps(context, window, mode)
		case "operations":
			return [operationsStep(context, window, mode)]
		case "dependencies":
			return [dependenciesStep(context, window, mode)]
		case "api":
			return apiTabSteps(context, window, mode)
	}
}

/** Row sparklines for the busiest endpoints; the read takes at most 50 names. */
const SPARKLINE_ENDPOINTS = 50

const loadedEndpoints = (model: Model): ReadonlyArray<Endpoint> =>
	AsyncData.getOrElse(model.endpoints.data, () => [])

/** Groups the probes and unrouted paths fold into; their rows stay hidden until opened. */
const isCollapsedKind = (kind: string) => kind === "probes" || kind === "unrouted"

/**
 * The busiest endpoints the table can show, sorted so the key is stable. Read from data that
 * answers the current window (a Refresh keeps it), never from rows retained across a change.
 */
export const seriesSpanNames = (model: Model): ReadonlyArray<string> =>
	model.endpoints.retained === true
		? []
		: groupsOf(loadedEndpoints(model), model.sorts.endpoints)
				.filter((group) => !isCollapsedKind(group.kind))
				.flatMap((group) => group.endpoints)
				.toSorted((a, b) => b.estimatedSpanCount - a.estimatedSpanCount)
				.slice(0, SPARKLINE_ENDPOINTS)
				.map((endpoint) => endpoint.spanName)
				.toSorted()

/** What `ServiceApiTab` mounts: the endpoints, the KPI overview, the status rows and the sparklines. */
const apiTabSteps = (context: PageContext, window: TimeWindow, mode: RequestMode): Steps => [
	(model) => {
		const input = { ...detailInput(model, window), limit: ENDPOINTS_LIMIT }
		return keyed(
			model.endpoints,
			requestKey(context.orgId, "getServiceEndpoints", { data: input }),
			mode,
			(endpoints) => ({ endpoints }),
			(key) => FetchEndpoints({ key, input }),
		)
	},
	(model) => {
		const input = {
			...detailInput(model, window),
			...previousWindow(window),
			bucketSeconds: apiBucketSeconds(window),
		}
		return keyed(
			model.apiOverview,
			requestKey(context.orgId, "getServiceApiOverview", { data: input }),
			mode,
			(apiOverview) => ({ apiOverview }),
			(key) => FetchApiOverview({ key, input }),
		)
	},
	(model) => {
		const input = detailInput(model, window)
		return keyed(
			model.statusBreakdown,
			requestKey(context.orgId, "getServiceEndpointStatusBreakdown", { data: input }),
			mode,
			(statusBreakdown) => ({ statusBreakdown }),
			(key) => FetchStatusBreakdown({ key, input }),
		)
	},
	(model) => {
		const spanNames = seriesSpanNames(model)
		if (spanNames.length === 0) return NONE
		const input = { ...detailInput(model, window), bucketSeconds: apiBucketSeconds(window), spanNames }
		return keyed(
			model.endpointSeries,
			requestKey(context.orgId, "getServiceEndpointsTimeseries", { data: input }),
			mode,
			(endpointSeries) => ({ endpointSeries }),
			(key) => FetchEndpointSeries({ key, input }),
		)
	},
]

/** The table's rows in screen order: the filter, the search and the sort applied. */
export const tableRows = (model: Model): ReadonlyArray<Endpoint> =>
	visibleEndpoints(
		groupsOf(
			loadedEndpoints(model).filter((endpoint) =>
				matchesFilter(endpoint, model.endpointFilter, model.endpointQuery),
			),
			model.sorts.endpoints,
		),
		model.expandedEndpointGroups,
	)

/** The drawer's endpoint on the API tab, `null` elsewhere or when no row matches. */
export const peekOf = (model: Model): EndpointPeekUpdate.Peek | null =>
	tabOf(model.search) === "api"
		? EndpointPeekUpdate.resolvePeek(tableRows(model), model.search.endpoint)
		: null

const peekScope = (model: Model, context: PageContext): EndpointPeekUpdate.PeekScope => ({
	context,
	window: model.window,
	serviceName: model.serviceName,
	environments: environmentsOf(model.search),
	bucketSeconds: model.window === null ? 60 : apiBucketSeconds(model.window),
	tabSeriesNames: seriesSpanNames(model),
})

const liftPeek = (model: Model, result: EndpointPeekUpdate.Return): Return => {
	const commands = Command.mapMessages(result.commands ?? [], (message) =>
		Message.GotEndpointPeekMessage({ message }),
	)
	const next = { ...model, endpointPeek: result.model }
	if (result.outMessage === undefined) return { model: next, commands }
	const out = result.outMessage
	if (out._tag === "Closed") {
		return {
			model: next,
			commands,
			outMessage: navigate(next, { ...model.search, endpoint: undefined }, true).outMessage,
		}
	}
	// At either end of the table a step has nowhere to go.
	const target = stepTarget(model, out.step)
	return target === undefined
		? { model: next, commands }
		: {
				model: next,
				commands,
				outMessage: navigate(next, { ...model.search, endpoint: target }, true).outMessage,
			}
}

const stepTarget = (model: Model, step: 1 | -1): string | undefined => {
	const rows = tableRows(model)
	const index = rows.findIndex((row) => row.spanName === model.search.endpoint)
	return index < 0 ? undefined : rows[index + step]?.spanName
}

/**
 * A URL endpoint the settled table cannot show: inside a collapsed group it opens that group,
 * otherwise (gone from the window, hidden by the filter) it leaves the URL, so it cannot reopen
 * on its own later.
 */
const reconcilePeek = (model: Model): Readonly<{ model: Model; clear: boolean }> => {
	const spanName = model.search.endpoint
	if (spanName === undefined || tabOf(model.search) !== "api" || !AsyncData.isSuccess(model.endpoints.data))
		return { model, clear: false }
	if (tableRows(model).some((row) => row.spanName === spanName)) return { model, clear: false }
	const group = groupsOf(loadedEndpoints(model), model.sorts.endpoints).find(
		(candidate) =>
			isCollapsedKind(candidate.kind) && candidate.endpoints.some((row) => row.spanName === spanName),
	)
	return group === undefined || model.expandedEndpointGroups.includes(group.kind)
		? { model, clear: true }
		: {
				model: { ...model, expandedEndpointGroups: [...model.expandedEndpointGroups, group.kind] },
				clear: false,
			}
}

/** The drawer follows the URL and the loaded rows; run after every request pass. */
const syncPeek = (result: Return, context: PageContext, mode: RequestMode): Return => {
	const reconciled = reconcilePeek(result.model)
	const peeked = liftPeek(
		reconciled.model,
		EndpointPeekUpdate.sync(
			reconciled.model.endpointPeek,
			peekScope(reconciled.model, context),
			peekOf(reconciled.model),
			mode,
		),
	)
	const commands = [...(result.commands ?? []), ...(peeked.commands ?? [])]
	return reconciled.clear
		? {
				model: peeked.model,
				commands,
				outMessage: navigate(peeked.model, { ...peeked.model.search, endpoint: undefined }, true)
					.outMessage,
			}
		: { ...result, model: peeked.model, commands }
}

/**
 * Every query the current tab reads, keyed by its inputs. Idempotent under `Load`: a slot
 * already holding (or loading) its key sends nothing, so any Message may re-run it.
 */
export const sync = (model: Model, context: PageContext, mode: RequestMode): Return => {
	if (model.nowMs === null) return { model }
	const window = windowOf(model, context, model.nowMs)
	const requested = runSteps({ ...model, window }, [
		overviewStep(context, window, mode),
		...tabSteps(model, context, window, mode),
	])
	return syncPeek(requested, context, mode)
}

// NAVIGATION

type Search = Model["search"]

export const searchHref = (serviceName: string, search: Search) =>
	hrefOf(AppRoute.Service({ serviceName, search }))

const navigate = (model: Model, search: Search, isReplace: boolean): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url: searchHref(model.serviceName, search), isReplace }),
})

/** `handleTabChange`: Overview leaves the URL, and the history entry is replaced. */
export const tabSearch = (search: Search, tab: ServiceTab): Search => ({
	...search,
	endpoint: undefined,
	tab: tab === "overview" ? undefined : tab,
})

// ENTRY POINTS

export const CHART_IDS = ["latency", "throughput", "apdex", "error-rate"] as const

export const init = (
	route: { readonly serviceName: string; readonly search: Search },
	_context: PageContext,
): Return => ({
	model: {
		serviceName: route.serviceName,
		search: route.search,
		nowMs: null,
		window: null,
		overview: Keyed.idle(),
		refinement: Keyed.idle(),
		operations: Keyed.idle(),
		endpoints: Keyed.idle(),
		expandedEndpointGroups: [],
		apiOverview: Keyed.idle(),
		endpointSeries: Keyed.idle(),
		statusBreakdown: Keyed.idle(),
		endpointFilter: "all",
		endpointQuery: "",
		endpointPeek: EndpointPeek.init("service-endpoint-peek"),
		issues: Keyed.idle(),
		usage: Keyed.idle(),
		uptimeMonitors: Keyed.idle(),
		workloads: Keyed.idle(),
		dependencies: Keyed.idle(),
		commits: {},
		isDeploysExpanded: false,
		sorts: {
			operations: initialSort("operations"),
			endpoints: initialSort("endpoints"),
			dependencies: initialSort("dependencies"),
		},
		environmentSelect: Select.init("service-environment", { value: ALL_ENVIRONMENTS, selectedIndex: 0 }),
		timePicker: TimeRangePicker.init("service-time-range"),
		charts: Object.fromEntries(CHART_IDS.map((id) => [id, Chart.init()])),
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
		refreshVersion: 0,
		isReloading: false,
	},
	commands: [
		ResolveClock({ mode: "Load" }),
		Command.mapMessage(LoadChartRuntime(), (message) =>
			message._tag === "CompletedLoadChartRuntime"
				? Message.CompletedLoadChartRuntime()
				: Message.FailedLoadChartRuntime({ reason: message.reason }),
		),
	],
})

/** The search changed (tab, environment, window): re-resolve and re-request. */
export const routeChanged = (
	model: Model,
	route: { readonly serviceName: string; readonly search: Search },
	context: PageContext,
): Return => {
	if (searchHref(model.serviceName, model.search) === searchHref(route.serviceName, route.search))
		return { model }
	const next = { ...model, search: route.search }
	return isWindowChange(model.search, route.search) ? resolveClock(next) : sync(next, context, "Load")
}

/** `useEffectiveTimeRange` re-resolves against now on a window or zone change. */
const isWindowChange = (a: Search, b: Search) =>
	a.startTime !== b.startTime || a.endTime !== b.endTime || a.timePreset !== b.timePreset

const resolveClock = (model: Model): Return => ({
	model,
	commands: [ResolveClock({ mode: model.refreshVersion === 0 ? "Load" : "Refresh" })],
})

/** A zone change moves the window (today, yesterday): read the clock again. A pin change does not. */
export const contextChanged = (model: Model, context: PageContext): Return =>
	model.nowMs === null || isSameWindow(model.window, windowOf(model, context, model.nowMs))
		? sync(model, context, "Load")
		: resolveClock(model)

const isSameWindow = (a: TimeWindow | null, b: TimeWindow) =>
	a !== null && a.startTime === b.startTime && a.endTime === b.endTime

const withPicker = (model: Model, message: TimeRangePicker.Message): Return => {
	const next = TimeRangePicker.update(model.timePicker, message)
	const lifted = {
		model: { ...model, timePicker: next.model },
		commands: Command.mapMessages(next.commands, (inner) =>
			Message.GotTimePickerMessage({ message: inner }),
		),
	}
	// `applyTimeRangeSearch` with a preset: the absolute bounds leave the URL.
	return next.outMessage === undefined || next.outMessage._tag === "RejectedRange"
		? TimeRangePicker.unpicked(lifted, next.outMessage)
		: {
				...lifted,
				outMessage: navigate(
					model,
					{
						...model.search,
						...TimeRangePicker.searchPatchOf(next.outMessage),
					},
					false,
				).outMessage,
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
				outMessage: navigate(
					model,
					{
						...model.search,
						environments:
							next.outMessage.value === ALL_ENVIRONMENTS ? undefined : [next.outMessage.value],
					},
					false,
				).outMessage,
			}
}

const withChart = (model: Model, chartId: string, message: Chart.Message): Return => {
	const chart = model.charts[chartId] ?? Chart.init()
	const next = Chart.update(chart, message)
	return {
		model: { ...model, charts: { ...model.charts, [chartId]: next.model } },
		commands: Command.mapMessages(next.commands ?? [], (inner) =>
			Message.GotChartMessage({ chartId, message: inner }),
		),
	}
}

/** A drill-down's window: the raw URL window, or its last 30 days when it is longer. */
const traceWindow = (model: Model) => {
	const window = model.window
	return window !== null && windowSeconds(window) > TRACE_DETAIL_LIMIT_SECONDS
		? {
				startTime: new Date(
					parseWarehouseDateTime(window.endTime) - TRACE_DETAIL_LIMIT_SECONDS * 1000,
				).toISOString(),
				endTime: window.endTime,
				timePreset: undefined,
			}
		: {
				startTime: model.search.startTime,
				endTime: model.search.endTime,
				timePreset: model.search.timePreset,
			}
}

/** `handleRowClick` on an operation or endpoint. */
export const traceSearch = (model: Model, spanName: string) =>
	operationTraceSearch({
		serviceName: model.serviceName,
		spanName,
		environments: environmentsOf(model.search),
		...traceWindow(model),
	})

const settleCommit = (model: Model, sha: string, result: Result.Result<Commit, CommitFailure>): Model => ({
	...model,
	commits: {
		...model.commits,
		[sha]: AsyncData.settle<Commit, CommitFailure>(model.commits[sha] ?? AsyncData.Loading(), result),
	},
})

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveClock: ({ nowMs, mode }) => sync({ ...model, nowMs }, context, mode),
		CompletedFetchOverview: ({ key, result }) =>
			sync({ ...model, overview: Keyed.accept(model.overview, key, result) }, context, "Load"),
		CompletedFetchRefinement: ({ key, result }) => ({
			model: { ...model, refinement: Keyed.accept(model.refinement, key, result) },
		}),
		CompletedFetchOperations: ({ key, result }) => ({
			model: { ...model, operations: Keyed.accept(model.operations, key, result) },
		}),
		ClickedDependency: ({ whereClause }) => {
			const window = traceWindow(model)
			return {
				model,
				outMessage: PageOutMessage.RequestedNavigation({
					url: hrefOf(
						AppRoute.Traces({
							search: { services: [model.serviceName], whereClause, ...window },
						}),
					),
					isReplace: false,
				}),
			}
		},
		// The sparkline read keys on the loaded endpoints, and the drawer on the rows: sync both.
		CompletedFetchEndpoints: ({ key, result }) =>
			sync({ ...model, endpoints: Keyed.accept(model.endpoints, key, result) }, context, "Load"),
		CompletedFetchApiOverview: ({ key, result }) => ({
			model: { ...model, apiOverview: Keyed.accept(model.apiOverview, key, result) },
		}),
		CompletedFetchEndpointSeries: ({ key, result }) => ({
			model: { ...model, endpointSeries: Keyed.accept(model.endpointSeries, key, result) },
		}),
		CompletedFetchStatusBreakdown: ({ key, result }) => ({
			model: { ...model, statusBreakdown: Keyed.accept(model.statusBreakdown, key, result) },
		}),
		ClickedEndpoint: ({ spanName }) =>
			navigate(
				model,
				{ ...model.search, endpoint: model.search.endpoint === spanName ? undefined : spanName },
				false,
			),
		ClickedEndpointFilter: ({ filter }) =>
			syncPeek({ model: { ...model, endpointFilter: filter } }, context, "Load"),
		ChangedEndpointQuery: ({ value }) =>
			syncPeek({ model: { ...model, endpointQuery: value } }, context, "Load"),
		GotEndpointPeekMessage: ({ message: inner }) => {
			const lifted = liftPeek(
				model,
				EndpointPeekUpdate.update(
					model.endpointPeek,
					inner,
					peekScope(model, context),
					peekOf(model),
				),
			)
			// The drawer's charts may read the tab's sparkline series; a retry re-reads it when it failed.
			if (inner._tag !== "ClickedRetryDetail" || !AsyncData.isFailure(model.endpointSeries.data))
				return lifted
			const retried = sync({ ...lifted.model, endpointSeries: Keyed.idle() }, context, "Load")
			return { ...retried, commands: [...(lifted.commands ?? []), ...(retried.commands ?? [])] }
		},
		ClickedToggleEndpointGroup: ({ kind }) =>
			syncPeek(
				{
					model: {
						...model,
						expandedEndpointGroups: model.expandedEndpointGroups.includes(kind)
							? model.expandedEndpointGroups.filter((open) => open !== kind)
							: [...model.expandedEndpointGroups, kind],
					},
				},
				context,
				"Load",
			),
		CompletedFetchIssues: ({ key, result }) => ({
			model: { ...model, issues: Keyed.accept(model.issues, key, result) },
		}),
		CompletedFetchUsage: ({ key, result }) => ({
			model: { ...model, usage: Keyed.accept(model.usage, key, result) },
		}),
		CompletedFetchUptimeMonitors: ({ key, result }) => ({
			model: { ...model, uptimeMonitors: Keyed.accept(model.uptimeMonitors, key, result) },
		}),
		CompletedFetchWorkloads: ({ key, result }) => ({
			model: { ...model, workloads: Keyed.accept(model.workloads, key, result) },
		}),
		CompletedFetchDependencies: ({ key, result }) => ({
			model: { ...model, dependencies: Keyed.accept(model.dependencies, key, result) },
		}),
		CompletedFetchCommit: ({ sha, result }) => ({ model: settleCommit(model, sha, result) }),
		CompletedMountLinkedCursor: () => ({ model }),
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
					ResolveClock({ mode: "Refresh" }),
					CompleteReloadSpin({ version: reloaded.refreshVersion }),
				],
			}
		},
		CompletedReloadSpin: ({ version }) =>
			version === model.refreshVersion ? { model: { ...model, isReloading: false } } : { model },
		// `useAtomRefresh` on the failed overview: forget the slot, so the next sync requests it again.
		ClickedRetry: () => sync({ ...model, overview: Keyed.idle() }, context, "Load"),
		ClickedResetTimeRange: () =>
			navigate(
				model,
				{ ...model.search, startTime: undefined, endTime: undefined, timePreset: undefined },
				false,
			),
		ClickedTab: ({ tab }) => navigate(model, tabSearch(model.search, tab), true),
		ClickedToggleDeploys: () =>
			sync({ ...model, isDeploysExpanded: !model.isDeploysExpanded }, context, "Load"),
		ClickedSort: ({ table, key }) =>
			syncPeek(
				{
					model: {
						...model,
						sorts: { ...model.sorts, [table]: nextSort(table, model.sorts[table], key) },
					},
				},
				context,
				"Load",
			),
		ClickedOperation: ({ spanName }) => ({
			model,
			outMessage: PageOutMessage.RequestedNavigation({
				url: hrefOf(AppRoute.Traces({ search: traceSearch(model, spanName) })),
				isReplace: false,
			}),
		}),
		GotEnvironmentSelectMessage: ({ message: inner }) => withEnvironmentSelect(model, inner),
		GotTimePickerMessage: ({ message: inner }) => withPicker(model, inner),
		GotChartMessage: ({ chartId, message: inner }) => withChart(model, chartId, inner),
	})
