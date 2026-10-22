import { TimeRangeSchema } from "@maple/domain/http"
import { resolveTimeRangeWindow } from "@maple/query-engine"
import {
	REFRESH_INTERVAL_OPTIONS,
	resolveRefreshIntervalSeconds,
	variableValuesFromSearch,
} from "../../lib/dashboard-controls/search-params"
import { Option, Schema } from "effect"
import { Command } from "foldkit"
import * as Chart from "../../charts/chart"
import { LoadChartRuntime } from "../../charts/chart-runtime"
import { AppRoute, hrefOf } from "../../route"
import * as Menu from "../../ui/menu"
import { type PageReturn, PageOutMessage } from "../contract"
import { presetLabel } from "../kit/time-controls"
import { withActiveTab, withSectionCollapsed } from "../../lib/dashboards/section-view-state"
import {
	DATA_UNAVAILABLE_MESSAGE,
	FetchBatch,
	GoToSignIn,
	ReadFrame,
	ResolveClock,
	ResolveReloadClock,
	ResolveShare,
	WaitFlushFrame,
} from "./command"
import { Message } from "./message"
import type { Model, QueuedBatch, SharedDashboard, ShareWindow, WidgetState } from "./model"

type Return = PageReturn<Model, Message>
type Route = { readonly token: string; readonly search: Model["search"] }

const BATCH_MAX = 4
const DEFAULT_SHARE_TIME_RANGE = { type: "relative", value: "1h" } as const
const decodeTimeRange = Schema.decodeUnknownOption(TimeRangeSchema)

/** `resolveShareWindow`: `?from`/`?to`, then `?range`, then the board's own range. */
export const resolveShareWindow = (model: Model, share: SharedDashboard): ShareWindow | null => {
	const { search } = model
	const options = { snap: model.refreshTick === 0, nowMs: model.nowMs }
	if (search.from !== undefined && search.to !== undefined)
		// TODO(range-label): format an absolute window with `formatTimeRangeDisplay`.
		return { startTime: search.from, endTime: search.to, label: `${search.from} - ${search.to}` }
	if (search.range !== undefined) {
		const range = resolveTimeRangeWindow({ type: "relative", value: search.range }, options)
		if (range !== null) return { ...range, label: presetLabel(search.range) }
	}
	const timeRange = Option.getOrElse(
		decodeTimeRange(share.dashboard.timeRange),
		() => DEFAULT_SHARE_TIME_RANGE,
	)
	const resolved =
		resolveTimeRangeWindow(timeRange, options) ??
		resolveTimeRangeWindow(DEFAULT_SHARE_TIME_RANGE, options)
	if (resolved === null) return null
	return {
		...resolved,
		label:
			timeRange.type === "relative"
				? presetLabel(timeRange.value)
				: `${resolved.startTime} - ${resolved.endTime}`,
	}
}

export const shareOf = (model: Model): SharedDashboard | null =>
	model.resolve._tag === "Ready" ? model.resolve.share : null

export const refreshSecondsOf = (model: Model): number => {
	const share = shareOf(model)
	return resolveRefreshIntervalSeconds(model.search.refresh, share?.dashboard.refreshIntervalSeconds)
}

const variableValuesOf = (model: Model): Record<string, string> => ({
	...variableValuesFromSearch(model.search),
})

/** Queued batches cut down to the widgets still requested under the same key; empty ones drop. */
const liveBatches = (
	batches: ReadonlyArray<QueuedBatch>,
	requested: Model["requested"],
): ReadonlyArray<QueuedBatch> =>
	batches.flatMap((batch) => {
		const requests = batch.requests.filter((request) => requested[request.widgetId] === request.key)
		return requests.length === 0 ? [] : [{ ...batch, requests }]
	})

/** `useShareWidgetData`'s effect: every reported widget whose request key moved, in batches of four. */
const flush = (model: Model): Return => {
	const share = shareOf(model)
	const window = model.window
	if (share === null || window === null) return { model }
	const variableValues = variableValuesOf(model)
	const variablesKey = JSON.stringify(variableValues)
	const pending = share.dashboard.widgets.flatMap((widget) => {
		const maxDataPoints = model.options[widget.id]
		if (maxDataPoints === undefined) return []
		const key = JSON.stringify([window.startTime, window.endTime, variablesKey, maxDataPoints])
		return model.requested[widget.id] === key
			? []
			: [{ widgetId: widget.id, key, maxDataPoints, transform: widget.dataSource.transform }]
	})
	if (pending.length === 0) return { model }
	const batches = Array.from({ length: Math.ceil(pending.length / BATCH_MAX) }, (_, i) => ({
		startTime: window.startTime,
		endTime: window.endTime,
		variableValues,
		requests: pending.slice(i * BATCH_MAX, (i + 1) * BATCH_MAX),
	}))
	const [first, ...rest] = batches
	const requested = {
		...model.requested,
		...Object.fromEntries(pending.map((request) => [request.widgetId, request.key])),
	}
	return {
		model: {
			...model,
			requested,
			states: {
				...model.states,
				...Object.fromEntries(
					pending
						.filter((request) => model.states[request.widgetId] === undefined)
						.map((request) => [request.widgetId, { _tag: "Loading" } as const]),
				),
			},
			queuedBatches: [...liveBatches(model.queuedBatches, requested), ...rest],
			sentBatchId: first === undefined ? model.sentBatchId : model.sentBatchId + 1,
		},
		commands:
			first === undefined
				? []
				: [FetchBatch({ token: model.token, batchId: model.sentBatchId + 1, ...first })],
	}
}

const withWindow = (model: Model): Model => {
	const share = shareOf(model)
	return share === null || model.nowMs === 0
		? model
		: { ...model, window: resolveShareWindow(model, share) }
}

const reload = (model: Model): Return => {
	const refreshTick = model.refreshTick + 1
	const next = withWindow({ ...model, refreshTick, requested: {} })
	return flush(next)
}

// ENTRY POINTS

export const init = (route: Route): Return => ({
	model: {
		token: route.token,
		search: route.search,
		resolve: { _tag: "Loading" },
		refreshTick: 0,
		window: null,
		options: {},
		requested: {},
		isFlushScheduled: false,
		queuedBatches: [],
		sentBatchId: 0,
		states: {},
		gridWidth: 0,
		charts: {},
		tableSorts: {},
		themeColors: null,
		chartRuntime: { _tag: "Loading" },
		refreshMenu: Menu.init("share-refresh-menu"),
		nowMs: 0,
		isFramed: false,
		variables: {},
		sectionView: {},
	},
	commands: [
		ReadFrame(),
		ResolveClock(),
		ResolveShare({ token: route.token }),
		Command.mapMessage(LoadChartRuntime(), (message) =>
			message._tag === "CompletedLoadChartRuntime"
				? Message.CompletedLoadChartRuntime()
				: Message.FailedLoadChartRuntime({ reason: message.reason }),
		),
	],
})

/** A new search (`?refresh=`, `?range=`): the window re-resolves and changed keys refetch. */
export const routeChanged = (model: Model, route: Route): Return =>
	flush(withWindow({ ...model, search: route.search }))

const decodeInterval = (value: string): Option.Option<number> => {
	const seconds = Number(value)
	return REFRESH_INTERVAL_OPTIONS.some((option) => option === seconds)
		? Option.some(seconds)
		: Option.none()
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		CompletedResolveClock: ({ nowMs }) => ({ model: withWindow({ ...model, nowMs }) }),
		CompletedResolveShare: ({ token, resolve }) =>
			token !== model.token ? { model } : { model: withWindow({ ...model, resolve }) },
		MeasuredWidget: ({ widgetId, maxDataPoints }) => {
			if (model.options[widgetId] === maxDataPoints) return { model }
			const next = { ...model, options: { ...model.options, [widgetId]: maxDataPoints } }
			return next.isFlushScheduled
				? { model: next }
				: { model: { ...next, isFlushScheduled: true }, commands: [WaitFlushFrame()] }
		},
		MeasuredGrid: ({ width }) => ({ model: { ...model, gridWidth: width } }),
		CompletedFlushFrame: () => flush({ ...model, isFlushScheduled: false }),
		CompletedFetchBatch: ({ batchId, keys, states, variables }) => {
			// Only the batch sent last advances the queue, so a reload's batches never overlap.
			const isCurrent = batchId === model.sentBatchId
			const [next, ...rest] = isCurrent ? liveBatches(model.queuedBatches, model.requested) : []
			// A widget the answer left out settles as a failure instead of loading forever.
			const missing: WidgetState = { _tag: "Error", message: DATA_UNAVAILABLE_MESSAGE, kind: "runtime" }
			const settled = {
				...Object.fromEntries(Object.keys(keys).map((widgetId) => [widgetId, missing])),
				...states,
			}
			const isLive = Object.keys(settled).some(
				(widgetId) => model.requested[widgetId] === keys[widgetId],
			)
			return {
				model: {
					...model,
					queuedBatches: isCurrent ? rest : model.queuedBatches,
					sentBatchId: next === undefined ? model.sentBatchId : model.sentBatchId + 1,
					// A batch whose widgets all moved on is skipped whole, its variables included.
					variables: isLive && variables !== undefined ? variables : model.variables,
					states: {
						...model.states,
						...Object.fromEntries(
							Object.entries(settled).filter(
								([widgetId]) => model.requested[widgetId] === keys[widgetId],
							),
						),
					},
				},
				commands:
					next === undefined
						? []
						: [FetchBatch({ token: model.token, batchId: model.sentBatchId + 1, ...next })],
			}
		},
		ClickedReload: () => ({ model, commands: [ResolveReloadClock()] }),
		TickedAutoRefresh: () => ({ model, commands: [ResolveReloadClock()] }),
		CompletedResolveReloadClock: ({ nowMs }) => reload({ ...model, nowMs }),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		GotChartMessage: ({ widgetId, message: inner }) => {
			const next = Chart.update(model.charts[widgetId] ?? Chart.init(), inner)
			return {
				model: { ...model, charts: { ...model.charts, [widgetId]: next.model } },
				commands: Command.mapMessages(next.commands ?? [], (chart) =>
					Message.GotChartMessage({ widgetId, message: chart }),
				),
			}
		},
		ClickedSortColumn: ({ widgetId, field, isText }) => {
			const current = model.tableSorts[widgetId] ?? { key: null, dir: "desc" as const }
			const next =
				current.key === field
					? current.dir === "asc"
						? { key: null, dir: current.dir }
						: { key: field, dir: "asc" as const }
					: { key: field, dir: isText ? ("asc" as const) : ("desc" as const) }
			return { model: { ...model, tableSorts: { ...model.tableSorts, [widgetId]: next } } }
		},
		GotRefreshMenuMessage: ({ message: inner }) => {
			const next = Menu.update(model.refreshMenu, inner)
			const commands = Command.mapMessages(next.commands ?? [], (menu) =>
				Message.GotRefreshMenuMessage({ message: menu }),
			)
			const picked =
				next.outMessage === undefined ? Option.none<number>() : decodeInterval(next.outMessage.value)
			return Option.match(picked, {
				onNone: () => ({ model: { ...model, refreshMenu: next.model }, commands }),
				onSome: (refresh) => ({
					model: { ...model, refreshMenu: next.model },
					commands,
					outMessage: PageOutMessage.RequestedNavigation({
						url: hrefOf(
							AppRoute.Share({ token: model.token, search: { ...model.search, refresh } }),
						),
						isReplace: true,
					}),
				}),
			})
		},
		CompletedReadFrame: ({ isFramed }) => ({ model: { ...model, isFramed } }),
		AppliedShareAppearance: () => ({ model }),
		ClickedSectionChevron: ({ sectionId, collapsed }) => ({
			model: { ...model, sectionView: withSectionCollapsed(model.sectionView, sectionId, collapsed) },
		}),
		ClickedSectionTab: ({ sectionId, tabId }) => ({
			model: { ...model, sectionView: withActiveTab(model.sectionView, sectionId, tabId) },
		}),
		ClickedSignIn: () => ({ model, commands: [GoToSignIn()] }),
		StartedSignInRedirect: () => ({ model }),
	})
