import { toEpochMs } from "@maple/ui/lib/time-format"
import { NEW_ISSUE_SLACK_MS, previousSha } from "../../../components/releases/release-model"
import { Option } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Overlays from "../overlays"
import * as Chart from "../../../charts/chart"
import { ChartRuntime } from "../../../charts/chart-runtime"
import * as Keyed from "../../../data/keyed"
import type { LoadFailure } from "../../../data/load-failure"
import { requestKey } from "../../../data/request-key"
import { commitDetailKey } from "../../kit/commit-card"
import type { TimeWindow } from "../../../data/time-range"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { routeWindowStep, snapModeOf } from "../../kit/route-window"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { commitRangesKey, isResolvableSha } from "../kit"
import { DEFAULT_PRESET } from "../list/derive"
import type { RequestMode } from "../list/message"
import {
	CompleteReleaseReloadSpin,
	FetchChangeset,
	FetchDeployIssues,
	FetchDeployReleases,
	FetchReleaseCommit,
	ResolveReleaseWindow,
} from "./command"
import { groupOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { followLoaded, followService } from "./service"

type Return = PageReturn<Model, Message>
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>
type ReleaseRoute = Extract<AppRoute, { readonly _tag: "Release" }>

const resolveCommand = (model: Model, context: PageContext, mode: RequestMode) =>
	ResolveReleaseWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

const slotStep = <A>(
	model: Model,
	slot: Keyed.Keyed<A, LoadFailure>,
	write: (next: Keyed.Keyed<A, LoadFailure>) => Partial<Model>,
	key: string,
	mode: RequestMode,
	command: Commands[number],
): Return =>
	Option.match(Keyed.request(slot, key, mode), {
		onNone: () => ({ model }),
		onSome: (next) => ({ model: { ...model, ...write(next) }, commands: [command] }),
	})

const chain = (first: Return, next: (model: Model) => Return): Return => {
	const second = next(first.model)
	return { model: second.model, commands: [...(first.commands ?? []), ...(second.commands ?? [])] }
}

const requestReleases = (
	model: Model,
	context: PageContext,
	window: TimeWindow,
	mode: RequestMode,
): Return => {
	const environments = model.search.environments
	// `globalNamespace: "top"`: the pin is part of the read and its key.
	const namespaces = context.pinnedNamespace === null ? undefined : [context.pinnedNamespace]
	const key = requestKey(context.orgId, "getReleases", {
		data: { startTime: window.startTime, endTime: window.endTime, environments, namespaces },
	})
	return slotStep(
		{ ...model, window },
		model.releases,
		(releases) => ({ releases }),
		key,
		mode,
		FetchDeployReleases({
			key,
			refresh: mode === "Refresh",
			startTime: window.startTime,
			endTime: window.endTime,
			environments,
			namespaces,
		}),
	)
}

/** What mounts with the loaded deploy: its changeset and its issues; with `?service=`, the service body. */
const followDeploy = (model: Model, context: PageContext, mode: RequestMode): Return =>
	model.search.service !== undefined
		? followService(model, context, mode)
		: followOverview(model, context, mode)

const followOverview = (model: Model, context: PageContext, mode: RequestMode): Return =>
	Option.match(groupOf(model), {
		onNone: () => ({ model }),
		onSome: (group) => {
			const base = previousSha(group)
			const ranges = base === undefined ? "" : commitRangesKey([{ base, head: model.commitSha }])
			const introducedAfter = new Date(toEpochMs(group.firstSeen) - NEW_ISSUE_SLACK_MS).toISOString()
			const issuesKey = requestKey(context.orgId, "errorIssues.list", {
				introduced_after: introducedAfter,
				limit: 100,
			})
			const changesetKey = requestKey(context.orgId, "vcsCommitRanges", { ranges, limit: 100 })
			return chain(
				ranges === ""
					? { model }
					: slotStep(
							model,
							model.changeset,
							(changeset) => ({ changeset }),
							changesetKey,
							mode,
							FetchChangeset({ key: changesetKey, ranges }),
						),
				(next) =>
					slotStep(
						next,
						next.issues,
						(issues) => ({ issues }),
						issuesKey,
						mode,
						FetchDeployIssues({ key: issuesKey, introducedAfter }),
					),
			)
		},
	})

const loadCommit = (model: Model, context: PageContext): Return => {
	if (!isResolvableSha(model.commitSha)) return { model }
	const key = commitDetailKey(context.orgId, model.commitSha)
	return slotStep(
		model,
		model.commit,
		(commit) => ({ commit }),
		key,
		"Load",
		FetchReleaseCommit({ key, sha: model.commitSha }),
	)
}

export const init = (route: ReleaseRoute, context: PageContext): Return => {
	const model: Model = {
		commitSha: route.commitSha,
		search: route.search,
		window: null,
		nowMs: 0,
		refreshVersion: 0,
		isReloading: false,
		commit: Keyed.idle(),
		releases: Keyed.idle(),
		changeset: Keyed.idle(),
		issues: Keyed.idle(),
		timePicker: TimeRangePicker.init("release-time-range"),
		overlays: Overlays.init("release-detail"),
		detail: Keyed.idle(),
		series: "version",
		serviceIssues: Keyed.idle(),
		charts: {},
		themeColors: null,
		chartRuntime: null,
		markerCommits: {},
	}
	const commit = loadCommit(model, context)
	return {
		model: commit.model,
		commands: [resolveCommand(model, context, "Load"), ...(commit.commands ?? [])],
	}
}

const searchHref = (commitSha: string, search: Model["search"]) =>
	hrefOf(AppRoute.Release({ commitSha, search }))

/** The releases read, then the deploy's reads that follow it. */
const requestAll = (model: Model, context: PageContext, window: TimeWindow, mode: RequestMode): Return =>
	chain(requestReleases(model, context, window, mode), (next) => followDeploy(next, context, mode))

export const routeChanged = (model: Model, route: ReleaseRoute, context: PageContext): Return => {
	if (searchHref(model.commitSha, model.search) === searchHref(route.commitSha, route.search))
		return { model }
	const next = { ...model, search: route.search }
	const resolve = (): Return => ({ model: next, commands: [resolveCommand(next, context, snapModeOf(model.refreshVersion))] })
	return routeWindowStep(model.search, route.search, {
		resolve,
		requestAll: (mode) => (next.window === null ? resolve() : requestAll(next, context, next.window, mode)),
	})
}

/** A pin or zone change re-resolves the window: the zone moves it, the pin re-keys the reads. */
export const contextChanged = (model: Model, context: PageContext): Return => ({
	model,
	commands: [resolveCommand(model, context, model.refreshVersion === 0 ? "Load" : "Refresh")],
})

const navigate = (model: Model, search: Model["search"]): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: searchHref(model.commitSha, search),
		isReplace: false,
	}),
})

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		GotOverlaysMessage: ({ message: inner }) => {
			const next = Overlays.update(model.overlays, inner, context.orgId)
			return {
				model: { ...model, overlays: next.model },
				commands: Command.mapMessages(next.commands ?? [], (overlay) => Message.GotOverlaysMessage({ message: overlay })),
			}
		},
		CompletedResolveWindow: ({ window, nowMs, mode }) => requestAll({ ...model, nowMs }, context, window, mode),
		CompletedFetchCommit: ({ key, result }) => ({
			model: { ...model, commit: Keyed.accept(model.commit, key, result) },
		}),
		CompletedFetchReleases: ({ key, result }) =>
			followDeploy({ ...model, releases: Keyed.accept(model.releases, key, result) }, context, "Load"),
		CompletedFetchChangeset: ({ key, result }) => ({
			model: { ...model, changeset: Keyed.accept(model.changeset, key, result) },
		}),
		CompletedFetchIssues: ({ key, result }) => ({
			model: { ...model, issues: Keyed.accept(model.issues, key, result) },
		}),
		CompletedFetchDetail: ({ key, result }) => {
			const next = { ...model, detail: Keyed.accept(model.detail, key, result) }
			return next.search.service === undefined
				? { model: next }
				: followLoaded(next, context, next.search.service, "Load")
		},
		CompletedFetchServiceIssues: ({ key, result }) => ({
			model: { ...model, serviceIssues: Keyed.accept(model.serviceIssues, key, result) },
		}),
		CompletedFetchMarkerCommit: ({ sha, result }) => ({
			model: {
				...model,
				markerCommits: {
					...model.markerCommits,
					[sha]: AsyncData.settle(model.markerCommits[sha] ?? AsyncData.Loading(), result),
				},
			},
		}),
		ClickedSeries: ({ series }) => followDeploy({ ...model, series }, context, "Load"),
		GotChartMessage: ({ chartId, message: inner }) => {
			const next = Chart.update(model.charts[chartId] ?? Chart.init(), inner)
			return {
				model: { ...model, charts: { ...model.charts, [chartId]: next.model } },
				commands: Command.mapMessages(next.commands ?? [], (chart) =>
					Message.GotChartMessage({ chartId, message: chart }),
				),
			}
		},
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: ChartRuntime.Ready() } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: ChartRuntime.Failed({ reason }) },
		}),
		CompletedMountLinkedCursor: () => ({ model }),
		ClickedReload: () => {
			const reloaded = { ...model, refreshVersion: model.refreshVersion + 1, isReloading: true }
			return {
				model: reloaded,
				commands: [
					resolveCommand(reloaded, context, "Refresh"),
					CompleteReleaseReloadSpin({ version: reloaded.refreshVersion }),
				],
			}
		},
		CompletedReloadSpin: ({ version }) =>
			version === model.refreshVersion ? { model: { ...model, isReloading: false } } : { model },
		// The service body's retry refreshes its detail bundle (`useAtomRefresh(atom)`), not the list.
		ClickedRetry: () =>
			model.window === null
				? { model }
				: model.search.service !== undefined && AsyncData.isFailure(model.detail.data)
					? followService(model, context, "Refresh")
					: requestReleases(model, context, model.window, "Refresh"),
		ClickedResetTimeRange: () =>
			navigate(model, {
				...model.search,
				startTime: undefined,
				endTime: undefined,
				timePreset: DEFAULT_PRESET,
			}),
		GotTimePickerMessage: ({ message: inner }) => {
			const next = TimeRangePicker.update(model.timePicker, inner)
			const lifted: Return = {
				model: { ...model, timePicker: next.model },
				commands: Command.mapMessages(next.commands, (picker) =>
					Message.GotTimePickerMessage({ message: picker }),
				),
			}
			return next.outMessage === undefined || next.outMessage._tag === "RejectedRange"
				? TimeRangePicker.unpicked(lifted, next.outMessage)
				: {
						...lifted,
						outMessage: navigate(model, {
							...model.search,
							...TimeRangePicker.searchPatchOf(next.outMessage),
						}).outMessage,
					}
		},
	})
