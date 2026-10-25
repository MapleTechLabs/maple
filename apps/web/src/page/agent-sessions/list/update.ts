import { Array as Arr, Option } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import * as FilterSections from "../../../ui/filters/filter-sections"
import { formatCompact, parseRange, type RangeUnit } from "../../../ui/filters/range-format"
import { HistogramMessage } from "../../../ui/filters/range-histogram"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { SignalPresenceData } from "../../kit/signal-presence"
import { missingDetection } from "../kit/detected-models"
import { emptyWindow } from "../kit/virtualize"
import {
	CompleteReloadSpin,
	DebounceRange,
	DebounceSearch,
	DETAILS_CHUNK,
	DetectModels,
	FetchDetails,
	FetchDistributions,
	FetchFacets,
	FetchFirstPage,
	FetchNextPage,
	FetchTabSessions,
	FetchTabTools,
	LoadSignalPresence,
	ResolveWindow,
} from "./command"
import {
	detailsKeyOf,
	FILTER_KEYS,
	filterInputs,
	filterKeyOf,
	hasNextPage,
	PAGE_SIZE,
	pageRows,
	RANGE_PARAMS,
	rankedCount,
	type Search,
	sortPatch,
} from "./derive"
import { type ListFacet, Message, type RequestMode } from "./message"
import type { Model, RangeKey } from "./model"

type Return = PageReturn<Model, Message>

const withoutKey = (record: Readonly<Record<string, number>>, key: string): Readonly<Record<string, number>> =>
	Object.fromEntries(Object.entries(record).filter(([entry]) => entry !== key))
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>

export const RANGE_UNITS = {
	duration: "s",
	cost: "usd",
	tokens: "count",
	llmCalls: "count",
	toolCalls: "count",
} as const satisfies Record<RangeKey, RangeUnit>

const RANGE_KEYS: ReadonlyArray<RangeKey> = ["duration", "cost", "tokens", "llmCalls", "toolCalls"]

/** The drafts the inputs show for a search: the canonical text of each bound. */
const draftsOf = (search: Search): Model["rangeDrafts"] =>
	Object.fromEntries(
		RANGE_KEYS.map((range) => {
			const [minKey, maxKey] = RANGE_PARAMS[range]
			const unit = RANGE_UNITS[range]
			const min = search[minKey]
			const max = search[maxKey]
			return [
				range,
				{
					min: formatCompact(typeof min === "number" ? min : undefined, unit),
					max: formatCompact(typeof max === "number" ? max : undefined, unit),
				},
			]
		}),
	)

/** `Some(next)` writes the slot and returns its fetch (S6). */
const keyed = <A, E>(
	slot: Keyed.Keyed<A, E>,
	key: string,
	mode: Keyed.RequestMode,
	fetch: (key: string) => Command.Command<Message, never, Resources>,
): readonly [Keyed.Keyed<A, E>, Commands] =>
	Option.match(Keyed.request(slot, key, mode), {
		onNone: () => [slot, []] as const,
		onSome: (next) => [next, [fetch(key)]] as const,
	})

// REQUESTS

/**
 * Every read for the current search over the held window. Only the first page follows Reload
 * (`useRefreshableAtomValue`); the facets, distributions and tab counts re-read when the window rolls.
 */
const requestAll = (model: Model, context: PageContext, mode: RequestMode): Return => {
	const { window, tabWindow } = model
	if (window === null || tabWindow === null) return { model }
	const org = context.orgId
	const inputs = filterInputs(model.search, window)
	const filterKey = filterKeyOf(inputs)
	const detailsKey = detailsKeyOf(inputs)
	const [firstPage, pageCommands] = keyed(
		model.firstPage,
		requestKey(org, "listAiSessions", { data: { ...inputs, limit: PAGE_SIZE, offset: 0 } }),
		mode,
		(key) => FetchFirstPage({ key, search: model.search, window }),
	)
	const [facets, facetCommands] = keyed(
		model.facets,
		requestKey(org, "getAiSessionsFacets", { data: window }),
		"Load",
		(key) => FetchFacets({ key, window }),
	)
	const [distributions, distributionCommands] = keyed(
		model.distributions,
		requestKey(org, "getAiSessionsDistributions", { data: window }),
		"Load",
		(key) => FetchDistributions({ key, window }),
	)
	const [tabSessions, sessionsCommands] = keyed(
		model.tabSessions,
		requestKey(org, "getAiToolTotals", { data: tabWindow }),
		"Load",
		(key) => FetchTabSessions({ key, window: tabWindow }),
	)
	const [tabTools, toolsCommands] = keyed(
		model.tabTools,
		requestKey(org, "getAiToolBreakdowns", { data: tabWindow }),
		"Load",
		(key) => FetchTabTools({ key, window: tabWindow }),
	)
	const isNewFilter = model.morePages.filterKey !== filterKey
	const next: Model = {
		...model,
		firstPage,
		facets,
		distributions,
		tabSessions,
		tabTools,
		morePages: isNewFilter ? { filterKey, pages: [] } : model.morePages,
		isFetchingNextPage: isNewFilter ? false : model.isFetchingNextPage,
		isPaginationStopped: isNewFilter ? false : model.isPaginationStopped,
		details:
			model.details.detailsKey === detailsKey
				? model.details
				: { detailsKey, bySession: {}, requested: [] },
	}
	return follow({
		model: next,
		commands: [
			...pageCommands,
			...facetCommands,
			...distributionCommands,
			...sessionsCommands,
			...toolsCommands,
		],
	})
}

/** The model sets each call site renders: the rail's (facets + selected) and the list's rows. */
const railModels = (model: Model): ReadonlyArray<string> => [
	...Option.match(AsyncData.getData(model.facets.data), {
		onNone: () => [],
		onSome: (facets) => facets.models.map((option) => option.name),
	}),
	...(Option.isSome(AsyncData.getData(model.facets.data)) ? (model.search.models ?? []) : []),
]

/** The rail's own detection, sent as it mounts (before the window resolves). */
const followRail = (result: Return): Return =>
	Option.match(missingDetection(result.model.detections, railModels(result.model)), {
		onNone: () => result,
		onSome: (key) => ({
			...result,
			model: { ...result.model, detections: { ...result.model.detections, [key]: null } },
			commands: [...(result.commands ?? []), DetectModels({ key })],
		}),
	})

const detectionSets = (model: Model, filterKey: string): ReadonlyArray<ReadonlyArray<string>> => [
	...(model.isFilterRailMounted ? [railModels(model)] : []),
	...(Option.isSome(AsyncData.getData(model.firstPage.data))
		? [pageRows(model, filterKey).flatMap((row) => row.models)]
		: []),
]

/** Requests that follow what is on screen: model detection, and the painted rows' details. */
const follow = (result: Return): Return => {
	const { model } = result
	const { window } = model
	if (window === null) return result
	const inputs = filterInputs(model.search, window)
	const filterKey = filterKeyOf(inputs)
	const detectKeys = Arr.dedupe(
		detectionSets(model, filterKey).flatMap((models) =>
			Option.toArray(missingDetection(model.detections, models)),
		),
	)
	const detections = {
		...model.detections,
		...Object.fromEntries(detectKeys.map((key) => [key, null])),
	}
	const isWaiting = AsyncData.isRefreshing(model.firstPage.data)
	const undetailed =
		model.hasPaintedTable && !isWaiting
			? pageRows(model, filterKey).filter((row) => !model.details.requested.includes(row.sessionId))
			: []
	const chunks = Arr.chunksOf(undetailed, DETAILS_CHUNK)
	return {
		...result,
		model: {
			...model,
			detections,
			details: {
				...model.details,
				requested: [...model.details.requested, ...undetailed.map((row) => row.sessionId)],
			},
		},
		commands: [
			...(result.commands ?? []),
			...detectKeys.map((key) => DetectModels({ key })),
			...chunks.map((rows) =>
				FetchDetails({
					detailsKey: model.details.detailsKey,
					search: model.search,
					window,
					rows: rows.map((row) => ({
						sessionId: row.sessionId,
						startTime: row.startTime,
						endTime: row.endTime,
					})),
				}),
			),
		],
	}
}

// NAVIGATION

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.AgentSessions({ search })),
		isReplace: false,
	}),
})

const toggled = (
	values: ReadonlyArray<string> | undefined,
	name: string,
): ReadonlyArray<string> | undefined => {
	const current = values ?? []
	const next = current.includes(name) ? current.filter((value) => value !== name) : [...current, name]
	return next.length > 0 ? next : undefined
}

/** `emit`: a reversed pair is a typo, so it is swapped rather than committed as-is. */
const withRange = (
	search: Search,
	range: RangeKey,
	min: number | undefined,
	max: number | undefined,
): Search => {
	const [minKey, maxKey] = RANGE_PARAMS[range]
	const isReversed = min !== undefined && max !== undefined && min > max
	return { ...search, [minKey]: isReversed ? max : min, [maxKey]: isReversed ? min : max }
}

const rangeOf = (search: Search, range: RangeKey) => {
	const [minKey, maxKey] = RANGE_PARAMS[range]
	const min = search[minKey]
	const max = search[maxKey]
	return { min: typeof min === "number" ? min : undefined, max: typeof max === "number" ? max : undefined }
}

const commitRange = (model: Model, range: RangeKey, canonical: boolean): Return => {
	const unit = RANGE_UNITS[range]
	const draft = model.rangeDrafts[range] ?? { min: "", max: "" }
	const min = parseRange(draft.min, unit)
	const max = parseRange(draft.max, unit)
	const current = rangeOf(model.search, range)
	const next: Model = {
		...model,
		rangeDraftVersion: model.rangeDraftVersion + 1,
		rangeDrafts: canonical
			? {
					...model.rangeDrafts,
					[range]: { min: formatCompact(min, unit), max: formatCompact(max, unit) },
				}
			: model.rangeDrafts,
	}
	return current.min === min && current.max === max
		? { model: next }
		: navigate(next, withRange(model.search, range, min, max))
}

/** `applyRange`: a preset, the histogram or Clear, applied at once with the draft rewritten. */
const applyRange = (
	model: Model,
	range: RangeKey,
	min: number | undefined,
	max: number | undefined,
): Return => {
	const unit = RANGE_UNITS[range]
	const next: Model = {
		...model,
		rangeDraftVersion: model.rangeDraftVersion + 1,
		rangeDrafts: {
			...model.rangeDrafts,
			[range]: { min: formatCompact(min, unit), max: formatCompact(max, unit) },
		},
	}
	return navigate(next, withRange(model.search, range, min, max))
}

// ENTRY

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const model: Model = {
		search: route.search,
		window: null,
		tabWindow: null,
		nowMs: 0,
		firstPage: Keyed.idle(),
		morePages: { filterKey: "", pages: [] },
		isFetchingNextPage: false,
		isPaginationStopped: false,
		details: { detailsKey: "", bySession: {}, requested: [] },
		facets: Keyed.idle(),
		distributions: Keyed.idle(),
		tabSessions: Keyed.idle(),
		tabTools: Keyed.idle(),
		// The rail detects its (still empty) model set as it mounts.
		detections: {},
		hasPaintedTable: false,
		isFilterRailMounted: false,
		presence: SignalPresenceData.Loading(),
		filterSections: FilterSections.init(),
		rangeDrafts: draftsOf(route.search),
		rangeDraftVersion: 0,
		histogramHover: {},
		histogramDrag: {},
		searchInput: route.search.q ?? "",
		searchVersion: 0,
		lastSentQuery: route.search.q ?? "",
		refreshVersion: 0,
		isReloading: false,
		listWindow: emptyWindow,
	}
	return {
		model,
		commands: [
			LoadSignalPresence({ orgId: context.orgId }),
			ResolveWindow({ mode: "Load", timeZone: context.timeZone }),
			Command.mapMessage(FilterSections.ReadRemembered(), (message) =>
				Message.GotFilterSectionsMessage({ message }),
			),
		],
	}
}

const searchHref = (search: Search) => hrefOf(AppRoute.AgentSessions({ search }))

/** A filter or sort change keeps the window: the unfiltered reads keep their keys. */
export const routeChanged = (
	model: Model,
	route: { readonly search: Search },
	context: PageContext,
): Return => {
	if (searchHref(model.search) === searchHref(route.search)) return { model }
	const query = route.search.q ?? ""
	const changedDrafts = Object.fromEntries(
		RANGE_KEYS.filter((range) => {
			const before = rangeOf(model.search, range)
			const after = rangeOf(route.search, range)
			return before.min !== after.min || before.max !== after.max
		}).map((range) => [range, draftsOf(route.search)[range] ?? { min: "", max: "" }]),
	)
	// `ToolbarSearch` resyncs on an outside change, never on its own echo.
	const isOutsideQuery = query !== (model.search.q ?? "") && query !== model.lastSentQuery
	return requestAll(
		{
			...model,
			search: route.search,
			rangeDrafts: { ...model.rangeDrafts, ...changedDrafts },
			searchInput: isOutsideQuery ? query : model.searchInput,
			lastSentQuery: isOutsideQuery ? query : model.lastSentQuery,
		},
		context,
		"Load",
	)
}

/** The week starts at the selected zone's midnight, so a zone change re-resolves it. */
export const contextChanged = (model: Model, context: PageContext): Return => ({
	model,
	commands: [ResolveWindow({ mode: "Load", timeZone: context.timeZone })],
})

const nextPage = (model: Model): Return => {
	const { window } = model
	if (window === null || model.isFetchingNextPage) return { model }
	const filterKey = filterKeyOf(filterInputs(model.search, window))
	return hasNextPage(model, filterKey)
		? {
				model: { ...model, isFetchingNextPage: true },
				commands: [
					FetchNextPage({
						key: filterKey,
						search: model.search,
						window,
						offset: rankedCount(model, filterKey),
					}),
				],
			}
		: { model }
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, tabWindow, nowMs, mode }) =>
			requestAll({ ...model, window, tabWindow, nowMs }, context, mode),
		CompletedFetchFirstPage: ({ key, result }) =>
			follow({ model: { ...model, firstPage: Keyed.accept(model.firstPage, key, result) } }),
		CompletedFetchNextPage: ({ key, offset, result }) => {
			if (key !== model.morePages.filterKey || offset !== rankedCount(model, key)) return { model }
			const settled = { ...model, isFetchingNextPage: false }
			return result._tag === "Success"
				? follow({
						model: {
							...settled,
							morePages: { filterKey: key, pages: [...model.morePages.pages, result.success] },
						},
					})
				: { model: { ...settled, isPaginationStopped: true } }
		},
		CompletedFetchDetails: ({ detailsKey, sessionIds, result }) => {
			if (detailsKey !== model.details.detailsKey) return { model }
			return result._tag === "Success"
				? {
						model: {
							...model,
							details: {
								...model.details,
								bySession: {
									...model.details.bySession,
									...Object.fromEntries(
										result.success.map((item) => [item.sessionId, item]),
									),
								},
							},
						},
					}
				: {
						// The ids go back so the next render that lists them asks again.
						model: {
							...model,
							details: {
								...model.details,
								requested: model.details.requested.filter((id) => !sessionIds.includes(id)),
							},
						},
					}
		},
		CompletedFetchFacets: ({ key, result }) =>
			follow({ model: { ...model, facets: Keyed.accept(model.facets, key, result) } }),
		CompletedFetchDistributions: ({ key, result }) => ({
			model: { ...model, distributions: Keyed.accept(model.distributions, key, result) },
		}),
		CompletedFetchTabSessions: ({ key, result }) => ({
			model: { ...model, tabSessions: Keyed.accept(model.tabSessions, key, result) },
		}),
		CompletedFetchTabTools: ({ key, result }) => ({
			model: { ...model, tabTools: Keyed.accept(model.tabTools, key, result) },
		}),
		CompletedDetectModels: ({ key, models }) => ({
			model: { ...model, detections: { ...model.detections, [key]: models } },
		}),
		ChangedListWindow: ({ window }) => ({ model: { ...model, listWindow: window } }),
		// `useDetectedModels` in the rail: with no facets yet it detects the empty list (`[]`).
		MountedFilterRail: () =>
			model.isFilterRailMounted
				? { model }
				: followRail({ model: { ...model, isFilterRailMounted: true } }),
		PaintedTable: () =>
			model.hasPaintedTable ? { model } : follow({ model: { ...model, hasPaintedTable: true } }),
		CompletedLoadSignalPresence: ({ result }) => ({
			model: { ...model, presence: AsyncData.settle(model.presence, result) },
		}),
		ReachedListEnd: () => nextPage(model),
		ClickedReload: () => {
			const reloaded = { ...model, refreshVersion: model.refreshVersion + 1, isReloading: true }
			return {
				model: reloaded,
				commands: [
					ResolveWindow({ mode: "Refresh", timeZone: context.timeZone }),
					CompleteReloadSpin({ version: reloaded.refreshVersion }),
				],
			}
		},
		CompletedReloadSpin: ({ version }) =>
			version === model.refreshVersion ? { model: { ...model, isReloading: false } } : { model },
		ChangedSearchInput: ({ value }) => {
			const searchVersion = model.searchVersion + 1
			return {
				model: { ...model, searchInput: value, searchVersion },
				commands: [DebounceSearch({ version: searchVersion })],
			}
		},
		ElapsedSearchDebounce: ({ version }) => {
			if (version !== model.searchVersion) return { model }
			const trimmed = model.searchInput.trim()
			const q = trimmed === "" ? undefined : trimmed
			return navigate({ ...model, lastSentQuery: q ?? "" }, { ...model.search, q })
		},
		ToggledErrorsOnly: () =>
			navigate(model, {
				...model.search,
				hasErrors: model.search.hasErrors === true ? undefined : true,
			}),
		ClickedSort: ({ key }) => navigate(model, { ...model.search, ...sortPatch(model.search, key) }),
		ClickedSessionRow: ({ url }) => ({
			model,
			outMessage: PageOutMessage.RequestedNavigation({ url, isReplace: false }),
		}),
		ClickedClearFilters: () =>
			navigate(model, { sortBy: model.search.sortBy, sortDir: model.search.sortDir }),
		ClickedClearAllFilters: () =>
			navigate(model, {
				...model.search,
				...Object.fromEntries(FILTER_KEYS.map((key) => [key, undefined])),
			}),
		ToggledFacetOption: ({ facet, name }) => navigate(model, toggledFacet(model.search, facet, name)),
		ToggledGrouped: () =>
			navigate(model, { ...model.search, grouped: model.search.grouped === true ? undefined : true }),
		ChangedRangeDraft: ({ range, min, max }) => {
			const rangeDraftVersion = model.rangeDraftVersion + 1
			return {
				model: {
					...model,
					rangeDrafts: { ...model.rangeDrafts, [range]: { min, max } },
					rangeDraftVersion,
				},
				commands: [DebounceRange({ range, version: rangeDraftVersion })],
			}
		},
		ElapsedRangeDebounce: ({ range, version }) =>
			version === model.rangeDraftVersion ? commitRange(model, range, false) : { model },
		CommittedRangeDraft: ({ range }) => commitRange(model, range, true),
		AppliedRange: ({ range, min, max }) => applyRange(model, range, min, max),
		GotHistogramMessage: ({ range, message: inner }) =>
			HistogramMessage.match<Return>(inner, {
				PointedHistogramBar: ({ index, dragStart }) => ({
					model: {
						...model,
						histogramHover: { ...model.histogramHover, [range]: index },
						histogramDrag:
							dragStart === undefined
								? withoutKey(model.histogramDrag, range)
								: { ...model.histogramDrag, [range]: dragStart },
					},
				}),
				LeftHistogram: () => ({
					model: {
						...model,
						histogramHover: Object.fromEntries(
							Object.entries(model.histogramHover).filter(([key]) => key !== range),
						),
					},
				}),
				SelectedHistogramRange: ({ min, max }) =>
					applyRange({ ...model, histogramDrag: withoutKey(model.histogramDrag, range) }, range, min, max),
			}),
		GotFilterSectionsMessage: ({ message: inner }) => {
			const next = FilterSections.update(model.filterSections, inner)
			return {
				model: { ...model, filterSections: next.model },
				commands: Command.mapMessages(next.commands, (message) =>
					Message.GotFilterSectionsMessage({ message }),
				),
			}
		},
	})

const toggledFacet = (search: Search, facet: ListFacet, name: string): Search => ({
	...search,
	[facet]: toggled(search[facet], name),
})
