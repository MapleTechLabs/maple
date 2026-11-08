import { Option, Array as Arr, String as Str } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import { SignalPresenceData } from "@maple/views/data/signal-presence"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as FilterSections from "@maple/views/ui/filters/filter-sections"
import { type TimeWindow } from "../../../data/time-range"
import { resolveUsersWindow, usersSearch } from "../window"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn, pickCommands } from "../../contract"
import { routeWindowStep, snapModeOf } from "../../kit/route-window"
import type { PresetValue } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import {
	CompleteReloadSpin,
	DebounceQuery,
	FetchFacets,
	FetchGroups,
	FetchUsers,
	facetsInputs,
	groupsReadInputs,
	listInputs,
	LoadSignalPresence,
	ResolveWindow,
} from "./command"
import { Message, type RequestMode } from "./message"
import type { Model, Search } from "./model"

type Return = PageReturn<Model, Message>
type Cmd = Command.Command<Message, never, Resources>

export const DEFAULT_PRESET: PresetValue = "1w"
/** The window the empty directory offers when the selected one holds no users. */
export const WIDE_PRESET: PresetValue = "1mo"

const resolveCommand = (model: Model, context: PageContext, mode: RequestMode): Cmd =>
	ResolveWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

/** Whether the directory shows one row per group instead of per user. */
export const isGrouped = (search: Search): boolean => search.groupBy === "group"

/** The one group the list is narrowed to, whose numbers the summary strip shows; else `null`. */
export const pickedGroup = (search: Search): string | null => {
	const [only, ...rest] = search.groups ?? []
	return only !== undefined && rest.length === 0 ? only : null
}

const requestAll = (model: Model, context: PageContext, window: TimeWindow, mode: RequestMode): Return => {
	const pinnedNamespace = context.pinnedNamespace
	const grouped = isGrouped(model.search)
	const listKey = requestKey(context.orgId, "listUsers", {
		data: listInputs(model.search, window, pinnedNamespace),
	})
	const groupsKey = requestKey(context.orgId, "listUserGroups", {
		data: groupsReadInputs(model.search, window, pinnedNamespace),
	})
	const facetsKey = requestKey(context.orgId, "getUsersFacets", {
		data: facetsInputs(window, pinnedNamespace),
	})
	// Only the view on screen reads: the other keeps its last answer for a quick switch back. A list
	// narrowed to one group reads the group view too: that one row is the strip's numbers.
	const list = grouped ? Option.none() : Keyed.request(model.list, listKey, mode)
	const groups =
		grouped || pickedGroup(model.search) !== null
			? Keyed.request(model.groups, groupsKey, mode)
			: Option.none()
	const facets = Keyed.request(model.facets, facetsKey, mode)
	const args = { search: model.search, window, pinnedNamespace, refresh: mode === "Refresh" }
	return {
		model: {
			...model,
			window,
			list: Option.getOrElse(list, () => model.list),
			groups: Option.getOrElse(groups, () => model.groups),
			facets: Option.getOrElse(facets, () => model.facets),
		},
		commands: [
			...(Option.isSome(list) ? [FetchUsers({ key: listKey, ...args })] : []),
			...(Option.isSome(groups) ? [FetchGroups({ key: groupsKey, ...args })] : []),
			...(Option.isSome(facets) ? [FetchFacets({ key: facetsKey, ...args })] : []),
		],
	}
}

const searchHref = (search: Search) => hrefOf(AppRoute.Users({ search }))

/** The directory listing one group's users: the group view's filters, that group picked. */
export const groupUsersHref =
	(search: Search) =>
	(groupId: string): string =>
		searchHref({ ...search, groupBy: undefined, groups: [groupId] })

/** The user page a directory row links to, over the directory's window. */
export const userHref =
	(search: Search) =>
	(userId: string): string =>
		hrefOf(
			AppRoute.UserDetail({
				userId,
				search: {
					startTime: search.startTime,
					endTime: search.endTime,
					timePreset: search.timePreset,
				},
			}),
		)

const textValue = (text: string): string | undefined => {
	const trimmed = Str.trim(text)
	return trimmed === "" ? undefined : trimmed
}

/** Navigates to `search` with the typed query committed, so a pending debounce never loses it. */
export const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: searchHref({ ...search, q: textValue(model.query) }),
		isReplace: false,
	}),
})

/** A list param with `name` added or removed; an empty list leaves the URL. */
const toggled = (
	list: ReadonlyArray<string> | undefined,
	name: string,
): ReadonlyArray<string> | undefined => {
	const current = list ?? []
	const next = current.includes(name) ? Arr.filter(current, (each) => each !== name) : [...current, name]
	return next.length === 0 ? undefined : next
}

/** Clears the rail's toggles and picks; the search and the time range stay. */
export const clearedFilters = (search: Search): Search => ({
	...search,
	hasErrors: undefined,
	hasReplay: undefined,
	namespaces: undefined,
	groups: undefined,
})

// ENTRY POINTS

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const search = usersSearch(route.search)
	const model: Model = {
		search,
		window: null,
		nowMs: 0,
		list: Keyed.idle(),
		groups: Keyed.idle(),
		facets: Keyed.idle(),
		presence: SignalPresenceData.Loading(),
		query: search.q ?? "",
		queryGeneration: 0,
		filterSections: FilterSections.init(),
		timePicker: TimeRangePicker.init("users-time-range"),
		refreshVersion: 0,
		promptCopy: CopyButton.init(),
		isReloading: false,
	}
	return {
		model,
		commands: [
			LoadSignalPresence({ orgId: context.orgId }),
			resolveCommand(model, context, "Load"),
			Command.mapMessage(FilterSections.ReadRemembered(), (message) =>
				Message.GotFilterSectionsMessage({ message }),
			),
		],
	}
}

/** The route loader warms the list and the facets. */
export const preload = (route: { readonly search: Search }, context: PageContext, nowMs: number) => {
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
		FetchUsers.name,
		FetchGroups.name,
		FetchFacets.name,
	])
}

export const routeChanged = (
	model: Model,
	route: { readonly search: Search },
	context: PageContext,
): Return => {
	const search = usersSearch(route.search)
	if (searchHref(model.search) === searchHref(search)) return { model }
	const previous = model.search
	const next: Model = {
		...model,
		search,
		query: textValue(model.query) === search.q ? model.query : (search.q ?? ""),
	}
	const resolve = (): Return => ({
		model: next,
		commands: [resolveCommand(next, context, snapModeOf(model.refreshVersion))],
	})
	return routeWindowStep(previous, search, {
		resolve,
		requestAll: (mode) =>
			next.window === null ? resolve() : requestAll(next, context, next.window, mode),
	})
}

/** The org pin changed: every read is keyed on the scope, so the stale ones refetch. */
export const contextChanged = (model: Model, context: PageContext): Return =>
	model.window === null ? { model } : requestAll(model, context, model.window, "Load")

const changedQuery = (model: Model, value: string): Return => {
	const queryGeneration = model.queryGeneration + 1
	return {
		model: { ...model, query: value, queryGeneration },
		commands: [DebounceQuery({ generation: queryGeneration })],
	}
}

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
		CompletedFetchUsers: ({ key, result }) => ({
			model: { ...model, list: Keyed.accept(model.list, key, result) },
		}),
		CompletedFetchGroups: ({ key, result }) => ({
			model: { ...model, groups: Keyed.accept(model.groups, key, result) },
		}),
		ClickedGroupBy: ({ groupBy }) =>
			navigate(model, { ...model.search, groupBy: groupBy === null ? undefined : groupBy }),
		CompletedFetchFacets: ({ key, result }) => ({
			model: { ...model, facets: Keyed.accept(model.facets, key, result) },
		}),
		CompletedLoadSignalPresence: ({ result }) => ({
			model: { ...model, presence: AsyncData.settle(model.presence, result) },
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
		ClickedWidenRange: () =>
			navigate(model, {
				...model.search,
				startTime: undefined,
				endTime: undefined,
				timePreset: WIDE_PRESET,
			}),
		ClickedRetry: () =>
			model.window === null ? { model } : requestAll(model, context, model.window, "Refresh"),
		ChangedQuery: ({ value }) => changedQuery(model, value),
		ClickedClearQuery: () => changedQuery(model, ""),
		CompletedQueryDebounce: ({ generation }) => {
			if (generation !== model.queryGeneration) return { model }
			const q = textValue(model.query)
			return q === model.search.q ? { model } : navigate(model, { ...model.search, q })
		},
		ToggledErrors: () =>
			navigate(model, {
				...model.search,
				hasErrors: model.search.hasErrors === true ? undefined : true,
			}),
		ToggledReplay: () =>
			navigate(model, {
				...model.search,
				hasReplay: model.search.hasReplay === true ? undefined : true,
			}),
		ToggledNamespace: ({ name }) =>
			navigate(model, { ...model.search, namespaces: toggled(model.search.namespaces, name) }),
		ToggledGroup: ({ name }) =>
			navigate(model, { ...model.search, groups: toggled(model.search.groups, name) }),
		ClickedClearFilters: () => navigate(model, clearedFilters(model.search)),
		ClickedClearSearchAndFilters: () => {
			const cleared = { ...model, query: "", queryGeneration: model.queryGeneration + 1 }
			return navigate(cleared, clearedFilters(model.search))
		},
		ClickedClearNamespacePin: () => ({
			model,
			outMessage: PageOutMessage.RequestedNamespacePin({ maybeNamespace: Option.none() }),
		}),
		GotPromptCopyMessage: ({ message: inner }) => {
			const next = CopyButton.update(model.promptCopy, inner)
			return {
				model: { ...model, promptCopy: next.model },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotPromptCopyMessage({ message: m }),
				),
			}
		},
		GotFilterSectionsMessage: ({ message: inner }) => {
			const next = FilterSections.update(model.filterSections, inner)
			return {
				model: { ...model, filterSections: next.model },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotFilterSectionsMessage({ message: m }),
				),
			}
		},
		GotTimePickerMessage: ({ message: inner }) => pickedTime(model, inner),
	})
