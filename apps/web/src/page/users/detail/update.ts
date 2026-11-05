import { Option, Result } from "effect"
import { Command } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import { type TimeWindow } from "../../../data/time-range"
import { resolveUsersWindow, usersSearch } from "../window"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import type { UserDetailTab } from "../../../route/search"
import { type PageContext, PageOutMessage, type PageReturn, pickCommands } from "../../contract"
import { routeWindowStep, snapModeOf } from "../../kit/route-window"
import type { PresetValue } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import {
	CompleteReloadSpin,
	detailInputs,
	FetchGroupStats,
	FetchLogs,
	FetchOverview,
	FetchTraces,
	ResolveWindow,
} from "./command"
import { Message, type RequestMode } from "./message"
import type { Model, Search } from "./model"

type Return = PageReturn<Model, Message>
type Cmd = Command.Command<Message, never, Resources>
type Route = Readonly<{ userId: string; search: Search }>

export const DEFAULT_PRESET: PresetValue = "1w"

/** The page's URL; the Activity tab is the default, so it leaves `tab` out. */
export const userDetailHref = (userId: string, search: Search): string =>
	hrefOf(
		AppRoute.UserDetail({
			userId,
			search: { ...search, tab: search.tab === "activity" ? undefined : search.tab },
		}),
	)

/** The open tab: the URL's, else Activity. */
export const tabOf = (search: Search): UserDetailTab => search.tab ?? "activity"

/** Only the window: what a link to another page carries along. */
export const windowSearch = (search: Search) => ({
	startTime: search.startTime,
	endTime: search.endTime,
	timePreset: search.timePreset,
})

const resolveCommand = (model: Model, context: PageContext, mode: RequestMode): Cmd =>
	ResolveWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

/**
 * The overview (profile, activity and issues) always; the Traces and Logs tabs' reads only while
 * their tab is open, so a page view never scans rows it does not show.
 */
const requestAll = (model: Model, context: PageContext, window: TimeWindow, mode: RequestMode): Return => {
	const inputs = detailInputs(model.userId, model.search, window, context.pinnedNamespace)
	const tab = tabOf(model.search)
	const overviewKey = requestKey(context.orgId, "getUserOverview", { data: inputs })
	const tracesKey = requestKey(context.orgId, "getUserTraces", { data: inputs })
	const logsKey = requestKey(context.orgId, "getUserLogs", { data: inputs })
	const profile = Keyed.request(model.profile, overviewKey, mode)
	const activity = Keyed.request(model.activity, overviewKey, mode)
	const issues = Keyed.request(model.issues, overviewKey, mode)
	const traces = tab === "traces" ? Keyed.request(model.traces, tracesKey, mode) : Option.none()
	const logs = tab === "logs" ? Keyed.request(model.logs, logsKey, mode) : Option.none()
	const refresh = mode === "Refresh"
	return {
		model: {
			...model,
			window,
			profile: Option.getOrElse(profile, () => model.profile),
			activity: Option.getOrElse(activity, () => model.activity),
			issues: Option.getOrElse(issues, () => model.issues),
			traces: Option.getOrElse(traces, () => model.traces),
			logs: Option.getOrElse(logs, () => model.logs),
		},
		commands: [
			...(Option.isSome(profile) || Option.isSome(activity) || Option.isSome(issues)
				? [FetchOverview({ key: overviewKey, refresh, ...inputs })]
				: []),
			...(Option.isSome(traces) ? [FetchTraces({ key: tracesKey, refresh, ...inputs })] : []),
			...(Option.isSome(logs) ? [FetchLogs({ key: logsKey, refresh, ...inputs })] : []),
		],
	}
}

/**
 * The group card's read, once the overview names the user's group: org-wide under the pin, not the
 * page's namespace pick, since a group spans namespaces. A reload refreshes it with the overview.
 */
const requestGroupStats = (model: Model, context: PageContext, groupId: string | null): Return => {
	if (groupId === null || model.window === null) return { model }
	const inputs = {
		groupId,
		startTime: model.window.startTime,
		endTime: model.window.endTime,
		namespaces: context.pinnedNamespace === null ? [] : [context.pinnedNamespace],
	}
	const key = requestKey(context.orgId, "listUserGroups", { data: inputs })
	const groupStats = Keyed.request(model.groupStats, key, model.isReloading ? "Refresh" : "Load")
	return Option.match(groupStats, {
		onNone: () => ({ model }),
		onSome: (next) => ({
			model: { ...model, groupStats: next },
			commands: [FetchGroupStats({ key, refresh: model.isReloading, ...inputs })],
		}),
	})
}

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: userDetailHref(model.userId, search),
		isReplace: false,
	}),
})

// ENTRY POINTS

export const init = (route: Route, context: PageContext): Return => {
	const model: Model = {
		userId: route.userId,
		search: usersSearch(route.search),
		window: null,
		nowMs: 0,
		profile: Keyed.idle(),
		activity: Keyed.idle(),
		issues: Keyed.idle(),
		traces: Keyed.idle(),
		logs: Keyed.idle(),
		groupStats: Keyed.idle(),
		timePicker: TimeRangePicker.init("user-time-range"),
		refreshVersion: 0,
		isReloading: false,
	}
	return { model, commands: [resolveCommand(model, context, "Load")] }
}

/** The route loader warms the profile and the activity, and the open tab's issues, spans or logs. */
export const preload = (route: Route, context: PageContext, nowMs: number) => {
	const { model } = init(route, context)
	const window = resolveUsersWindow(
		{
			startTime: model.search.startTime,
			endTime: model.search.endTime,
			preset: model.search.timePreset ?? DEFAULT_PRESET,
			snap: true,
			timeZone: context.timeZone,
		},
		nowMs,
	)
	return pickCommands(requestAll(model, context, window, "Load"), [
		FetchOverview.name,
		FetchTraces.name,
		FetchLogs.name,
	])
}

/** A tab or namespace pick keeps the reads it can; opening Traces or Logs starts that tab's read. */
export const routeChanged = (model: Model, route: Route, context: PageContext): Return => {
	const search = usersSearch(route.search)
	if (userDetailHref(model.userId, model.search) === userDetailHref(route.userId, search)) return { model }
	const next: Model = { ...model, search }
	const resolve = (): Return => ({
		model: next,
		commands: [resolveCommand(next, context, snapModeOf(model.refreshVersion))],
	})
	return routeWindowStep(model.search, search, {
		resolve,
		requestAll: (mode) =>
			next.window === null ? resolve() : requestAll(next, context, next.window, mode),
	})
}

/** The org pin changed: every read is keyed on the scope, so the stale ones refetch. */
export const contextChanged = (model: Model, context: PageContext): Return =>
	model.window === null ? { model } : requestAll(model, context, model.window, "Load")

const pickedTime = (model: Model, message: TimeRangePicker.Message): Return => {
	const next = TimeRangePicker.update(model.timePicker, message)
	const lifted: Return = {
		model: { ...model, timePicker: next.model },
		commands: Command.mapMessages(next.commands ?? [], (m) =>
			Message.GotTimePickerMessage({ message: m }),
		),
	}
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

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, mode }) =>
			requestAll({ ...model, nowMs }, context, window, mode),
		CompletedFetchOverview: ({ key, result }) =>
			requestGroupStats(
				{
					...model,
					profile: Keyed.accept(
						model.profile,
						key,
						Result.map(result, (data) => data.profile),
					),
					activity: Keyed.accept(
						model.activity,
						key,
						Result.map(result, (data) => data.activity),
					),
					issues: Keyed.accept(
						model.issues,
						key,
						Result.map(result, (data) => data.issues),
					),
				},
				context,
				Result.match(result, {
					onSuccess: (data) => data.profile.profile?.groupId ?? null,
					onFailure: () => null,
				}),
			),
		CompletedFetchGroupStats: ({ key, result }) => ({
			model: { ...model, groupStats: Keyed.accept(model.groupStats, key, result) },
		}),
		CompletedFetchTraces: ({ key, result }) => ({
			model: { ...model, traces: Keyed.accept(model.traces, key, result) },
		}),
		CompletedFetchLogs: ({ key, result }) => ({
			model: { ...model, logs: Keyed.accept(model.logs, key, result) },
		}),
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
		ClickedRetry: () =>
			model.window === null ? { model } : requestAll(model, context, model.window, "Refresh"),
		ClickedTab: ({ tab }) => navigate(model, { ...model.search, tab }),
		// The pin wins while it is on, so a pick waits for it to be cleared.
		ClickedNamespace: ({ namespace }) =>
			context.pinnedNamespace !== null
				? { model }
				: navigate(model, { ...model.search, namespace: namespace ?? undefined }),
		ClickedClearNamespacePin: () => ({
			model,
			outMessage: PageOutMessage.RequestedNamespacePin({ maybeNamespace: Option.none() }),
		}),
		GotTimePickerMessage: ({ message: inner }) => pickedTime(model, inner),
	})
