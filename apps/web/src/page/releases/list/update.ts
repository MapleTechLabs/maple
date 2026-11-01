import { toEpochMs } from "@maple/ui/lib/time-format"
import { isReleaseHealth } from "../../../components/releases/release-model"
import { AsyncData, Command } from "foldkit"
import * as Overlays from "../overlays"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import { commitDetailsKey } from "../../kit/commit-card"
import type { TimeWindow } from "../../../data/time-range"
import { AppRoute, hrefOf } from "../../../route"
import * as FilterSections from "../../../ui/filters/filter-sections"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { chain, chainAll, slotStep } from "../../kit/keyed-step"
import { routeWindowStep, snapModeOf } from "../../kit/route-window"
import { SignalPresenceData } from "../../kit/signal-presence"
import * as TimeRangePicker from "../../kit/time-range-picker"
import {
	CompleteReleasesReloadSpin,
	FetchReleaseCommits,
	FetchReleaseIssues,
	FetchReleaseRanges,
	FetchReleases,
	LoadReleasesSignalPresence,
	ResolveReleasesWindow,
	type ReleasesInput,
} from "./command"
import { DEFAULT_PRESET, deriveOf, rangesKeyOf, type Search, shasKeyOf } from "./derive"
import { Message, type RequestMode } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>

const resolveCommand = (model: Model, context: PageContext, mode: RequestMode) =>
	ResolveReleasesWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

const inputOf = (model: Model, window: TimeWindow, context: PageContext): ReleasesInput => ({
	startTime: window.startTime,
	endTime: window.endTime,
	environments: model.search.environments,
	excludedEnvironments: model.search.excludedEnvironments,
	services: model.search.services,
	namespaces: context.pinnedNamespace === null ? undefined : [context.pinnedNamespace],
})

/** One slot's request; nothing when the slot already holds the key (`Load`). */
const requestReleases = (model: Model, context: PageContext, window: TimeWindow, mode: RequestMode): Return => {
	const input = inputOf(model, window, context)
	const key = requestKey(context.orgId, "getReleases", { data: input })
	return slotStep({ ...model, window }, model.releases, (releases) => ({ releases }), key, mode, () => FetchReleases({ key, input, refresh: mode === "Refresh" }))
}

/**
 * What the table reads once it mounts (`ReleasesTableWithIssues`): the issues introduced in the
 * window, then the commit ranges and the commit messages of the rows on screen.
 */
const followTable = (model: Model, context: PageContext, mode: RequestMode): Return => {
	const data = AsyncData.getOrElse(model.releases.data, () => null)
	if (!model.hasPaintedTable || data === null) return { model }
	// The table resolves commits for the rows it shows: the health filter changes its keys.
	const health = model.search.impact
	const groups = deriveOf(data).groups.filter((group) => health === undefined || group.health === health)
	const introducedAfter = new Date(toEpochMs(data.startTime)).toISOString()
	const issuesKey = requestKey(context.orgId, "errorIssues.list", { introduced_after: introducedAfter, limit: 100 })
	const rangesKey = rangesKeyOf(groups)
	const shasKey = shasKeyOf(groups)
	return chainAll<Model, Message>(model, [
		(next: Model): Return =>
			slotStep(next, next.issues, (issues) => ({ issues }), issuesKey, mode, () => FetchReleaseIssues({ key: issuesKey, introducedAfter })),
		(next: Model): Return => {
			if (rangesKey === "") return { model: next }
			const key = requestKey(context.orgId, "vcsCommitRanges", { ranges: rangesKey, limit: 0 })
			return slotStep(next, next.ranges, (ranges) => ({ ranges }), key, mode, () => FetchReleaseRanges({ key, ranges: rangesKey, limit: 0 }))
		},
		(next: Model): Return => {
			if (shasKey === "") return { model: next }
			const key = commitDetailsKey(context.orgId, shasKey)
			const command = FetchReleaseCommits({ key, shas: shasKey, refresh: mode === "Refresh" })
			return slotStep(next, next.commits, (commits) => ({ commits }), key, mode, () => command)
		},
	])
}

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const model: Model = {
		search: route.search,
		window: null,
		nowMs: 0,
		refreshVersion: 0,
		isReloading: false,
		releases: Keyed.idle(),
		hasPaintedTable: false,
		issues: Keyed.idle(),
		commits: Keyed.idle(),
		ranges: Keyed.idle(),
		trackWidth: 0,
		expanded: [],
		filterSections: FilterSections.init(),
		timePicker: TimeRangePicker.init("releases-time-range"),
		overlays: Overlays.init("releases-list"),
		presence: SignalPresenceData.Loading(),
	}
	return {
		model,
		commands: [
			resolveCommand(model, context, "Load"),
			LoadReleasesSignalPresence({ orgId: context.orgId }),
			Command.mapMessage(FilterSections.ReadRemembered(), (message) => Message.GotFilterSectionsMessage({ message })),
		],
	}
}

const searchHref = (search: Search) => hrefOf(AppRoute.Releases({ search }))

/** The releases read, then the table's reads that follow it. */
const requestAll = (model: Model, context: PageContext, window: TimeWindow, mode: RequestMode): Return =>
	chain(requestReleases(model, context, window, mode), (next) => followTable(next, context, mode))

export const routeChanged = (model: Model, route: { readonly search: Search }, context: PageContext): Return => {
	if (searchHref(model.search) === searchHref(route.search)) return { model }
	const next = { ...model, search: route.search }
	const resolve = (): Return => ({ model: next, commands: [resolveCommand(next, context, snapModeOf(model.refreshVersion))] })
	return routeWindowStep(model.search, route.search, {
		resolve,
		requestAll: (mode) => (next.window === null ? resolve() : requestAll(next, context, next.window, mode)),
	})
}

export const contextChanged = (model: Model, context: PageContext): Return =>
	model.window === null ? { model } : requestReleases(model, context, model.window, "Load")

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url: searchHref(search), isReplace: false }),
})

const listOrUndefined = (values: ReadonlyArray<string>) => (values.length === 0 ? undefined : values)

/** `FilterSection`'s tri-state toggle over a facet and its excluded twin. */
const toggled = (selected: ReadonlyArray<string> | undefined, excluded: ReadonlyArray<string> | undefined, name: string) => ({
	selected: listOrUndefined(
		(selected ?? []).includes(name) ? (selected ?? []).filter((value) => value !== name) : [...(selected ?? []), name],
	),
	excluded: (excluded ?? []).includes(name) ? listOrUndefined((excluded ?? []).filter((value) => value !== name)) : excluded,
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
		CompletedFetchReleases: ({ key, result }) =>
			followTable({ ...model, releases: Keyed.accept(model.releases, key, result) }, context, "Load"),
		CompletedFetchIssues: ({ key, result }) => ({ model: { ...model, issues: Keyed.accept(model.issues, key, result) } }),
		CompletedFetchCommits: ({ key, result }) => ({ model: { ...model, commits: Keyed.accept(model.commits, key, result) } }),
		CompletedFetchRanges: ({ key, result }) => ({ model: { ...model, ranges: Keyed.accept(model.ranges, key, result) } }),
		CompletedLoadSignalPresence: ({ result }) => ({
			model: { ...model, presence: AsyncData.settle(model.presence, result) },
		}),
		PaintedTable: () => (model.hasPaintedTable ? { model } : followTable({ ...model, hasPaintedTable: true }, context, "Load")),
		MeasuredTrack: ({ width }) => (width === model.trackWidth ? { model } : { model: { ...model, trackWidth: width } }),
		ClickedReload: () => {
			const reloaded = { ...model, refreshVersion: model.refreshVersion + 1, isReloading: true }
			return {
				model: reloaded,
				commands: [resolveCommand(reloaded, context, "Refresh"), CompleteReleasesReloadSpin({ version: reloaded.refreshVersion })],
			}
		},
		CompletedReloadSpin: ({ version }) =>
			version === model.refreshVersion ? { model: { ...model, isReloading: false } } : { model },
		ClickedRetry: () => (model.window === null ? { model } : requestReleases(model, context, model.window, "Refresh")),
		ClickedResetTimeRange: () =>
			navigate(model, { ...model.search, startTime: undefined, endTime: undefined, timePreset: DEFAULT_PRESET }),
		// Single-select on a multi-select control: the newly ticked value wins; un-ticking clears.
		ToggledHealthOption: ({ name }) =>
			navigate(model, { ...model.search, impact: name !== model.search.impact && isReleaseHealth(name) ? name : undefined }),
		ToggledEnvironment: ({ name }) => {
			const next = toggled(model.search.environments, model.search.excludedEnvironments, name)
			return navigate(model, { ...model.search, environments: next.selected, excludedEnvironments: next.excluded })
		},
		ClickedOnlyEnvironment: ({ name }) =>
			navigate(model, { ...model.search, environments: [name], excludedEnvironments: undefined }),
		ClickedExcludeEnvironment: ({ name }) => {
			const next = toggled(model.search.excludedEnvironments, model.search.environments, name)
			return navigate(model, { ...model.search, excludedEnvironments: next.selected, environments: next.excluded })
		},
		ToggledService: ({ name }) => navigate(model, { ...model.search, services: toggled(model.search.services, undefined, name).selected }),
		ClickedClearFilters: () =>
			navigate(model, { startTime: model.search.startTime, endTime: model.search.endTime, timePreset: model.search.timePreset }),
		ClickedClearHealthFilter: () => navigate(model, { ...model.search, impact: undefined }),
		RemovedFilterChip: ({ param }) => navigate(model, { ...model.search, [param]: undefined }),
		ToggledExpanded: ({ commitSha }) => ({
			model: {
				...model,
				expanded: model.expanded.includes(commitSha)
					? model.expanded.filter((sha) => sha !== commitSha)
					: [...model.expanded, commitSha],
			},
		}),
		GotFilterSectionsMessage: ({ message: inner }) => {
			const next = FilterSections.update(model.filterSections, inner)
			return {
				model: { ...model, filterSections: next.model },
				commands: Command.mapMessages(next.commands ?? [], (sections) => Message.GotFilterSectionsMessage({ message: sections })),
			}
		},
		GotTimePickerMessage: ({ message: inner }) => {
			const next = TimeRangePicker.update(model.timePicker, inner)
			const lifted: Return = {
				model: { ...model, timePicker: next.model },
				commands: Command.mapMessages(next.commands, (picker) => Message.GotTimePickerMessage({ message: picker })),
			}
			return next.outMessage === undefined || next.outMessage._tag === "RejectedRange"
				? TimeRangePicker.unpicked(lifted, next.outMessage)
				: {
						...lifted,
						outMessage: PageOutMessage.RequestedNavigation({
							url: searchHref({
								...model.search,
								...TimeRangePicker.searchPatchOf(next.outMessage),
							}),
							isReplace: false,
						}),
					}
		},
	})
