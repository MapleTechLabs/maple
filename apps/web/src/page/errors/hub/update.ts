import { HUB_SORTS, HUB_VIEWS, SEVERITY_FILTERS } from "../../../lib/errors/hub-params"
import type { IssueKind } from "@maple/domain/http"
import { sparkFingerprintHashes } from "../../../lib/models/error-signal"
import { Option } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { TimeWindow } from "../../../data/time-range"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import * as FilterSections from "../../../ui/filters/filter-sections"
import * as ContextMenu from "../../../ui/context-menu"
import * as Menu from "../../../ui/menu"
import * as Select from "../../../ui/select"
import * as Tabs from "../../../ui/tabs"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { SignalPresenceData } from "../../kit/signal-presence"
import {
	FetchEnvironments,
	FetchInvestigations,
	FetchPage,
	FetchRanking,
	FetchServiceCounts,
	FetchSpark,
	FetchSummary,
	FetchVolume,
	CompleteReloadSpin,
	LoadSignalPresence,
	WaitSearchDebounce,
	ResolveWindow,
} from "./command"
import {
	bucketSecondsOf,
	INVESTIGATIONS_LIMIT,
	issuesOf,
	listQueryOf,
	rankingFailed,
	type Search,
	severityOf,
	signalsOf,
	sortOf,
	viewOf,
	VOLUME_RANK_LIMIT,
	warehouseFiltersOf,
} from "./derive"
import { type FilterParam, Message, type RequestMode } from "./message"
import { pressedRowPointer, rowMenuStep } from "./row-menu"
import { copyToast } from "../../kit/clipboard"
import {
	bulkMenuStep,
	bulkWrite,
	completedHubWrite,
	openedPicker,
	pickerStep,
	pressedListKey,
	toggledSelection,
} from "./selection"
import { SOURCES } from "../kit/source"
import type { IssuePage, Model, PageSlot } from "./model"
import type { LoadFailure } from "../../../data/load-failure"

export type Return = PageReturn<Model, Message>
type Cmd = Command.Command<Message, never, Resources>

/** `ERRORS_WINDOW`: the trend, count and totals look back a fixed day. */
export const ERRORS_WINDOW = "24h"

export const resolveCommand = (context: PageContext, mode: RequestMode) =>
	ResolveWindow({ mode, preset: ERRORS_WINDOW, timeZone: context.timeZone })

type Step = Readonly<{ patch: Partial<Model>; commands: ReadonlyArray<Cmd> }>

const NO_STEP: Step = { patch: {}, commands: [] }

/** One `Keyed.request`: `Some` writes the slot and returns its fetch (S6). */
const keyed = <A, E>(
	slot: Keyed.Keyed<A, E>,
	key: string,
	mode: Keyed.RequestMode,
	write: (next: Keyed.Keyed<A, E>) => Partial<Model>,
	fetch: (key: string) => Cmd,
): Step =>
	Option.match(Keyed.request(slot, key, mode), {
		onNone: () => NO_STEP,
		onSome: (next) => ({ patch: write(next), commands: [fetch(next.key)] }),
	})

/** Applies steps in order, each seeing the Model the previous one left. */
const applySteps = (model: Model, steps: ReadonlyArray<(model: Model) => Step>): Return =>
	steps.reduce<{ model: Model; commands: ReadonlyArray<Cmd> }>(
		(acc, step) => {
			const next = step(acc.model)
			return { model: { ...acc.model, ...next.patch }, commands: [...acc.commands, ...next.commands] }
		},
		{ model, commands: [] },
	)

// REQUESTS

const summaryStep =
	(context: PageContext, window: TimeWindow, mode: RequestMode) =>
	(model: Model): Step => {
		const filters = warehouseFiltersOf(model.search, window)
		return keyed(
			model.summary,
			requestKey(context.orgId, "getErrorsSummary", { data: filters }),
			mode,
			(summary) => ({ summary }),
			(key) => FetchSummary({ key, filters }),
		)
	}

const environmentsStep =
	(context: PageContext, window: TimeWindow, mode: RequestMode) =>
	(model: Model): Step =>
		keyed(
			model.environments,
			requestKey(context.orgId, "getErrorsFacets", { data: window }),
			mode,
			(environments) => ({ environments }),
			(key) => FetchEnvironments({ key, window }),
		)

/** `useAtomValue(retainedQueryV2(...))`: not on the page's Reload. */
const serviceCountsStep =
	(context: PageContext) =>
	(model: Model): Step =>
		keyed(
			model.serviceCounts,
			requestKey(context.orgId, "errorIssues.serviceCounts", {}),
			"Load",
			(serviceCounts) => ({ serviceCounts }),
			(key) => FetchServiceCounts({ key }),
		)

const investigationsStep =
	(context: PageContext) =>
	(model: Model): Step =>
		keyed(
			model.investigations,
			requestKey(context.orgId, "investigations.list", { limit: INVESTIGATIONS_LIMIT }),
			"Load",
			(investigations) => ({ investigations }),
			(key) => FetchInvestigations({ key, limit: INVESTIGATIONS_LIMIT }),
		)

/** The volume sort ranks first; every other sort sends nothing (an empty list is "rank nothing"). */
const rankingStep =
	(context: PageContext, window: TimeWindow, mode: RequestMode) =>
	(model: Model): Step => {
		if (sortOf(model.search) !== "volume") return NO_STEP
		const filters = warehouseFiltersOf(model.search, window)
		return keyed(
			model.ranking,
			requestKey(context.orgId, "getErrorsByType", { data: { ...filters, limit: VOLUME_RANK_LIMIT } }),
			mode,
			(ranking) => ({ ranking }),
			(key) => FetchRanking({ key, filters, limit: VOLUME_RANK_LIMIT }),
		)
	}

/** The ranking's filters without its window: a new window alone keeps the ranked rows usable. */
const rankingFiltersOf = (search: Model["search"]): string =>
	JSON.stringify([search.service ? search.service : null, search.env ? search.env : null])

/** The ranked hashes the list waits for: `Some(null)` when not ranking, `None` until ready. */
const rankedHashes = (model: Model): Option.Option<ReadonlyArray<string> | null> => {
	if (sortOf(model.search) !== "volume") return Option.some(null)
	// A ranking retained from other filters ranks the wrong issues: wait for the current one.
	if (model.ranking.retained === true && model.rankedFilters !== rankingFiltersOf(model.search)) {
		return Option.none()
	}
	return AsyncData.getData(model.ranking.data)
}

/** Page one of the current list query; a new query drops the pages loaded for the old one. */
const listStep =
	(context: PageContext) =>
	(model: Model): Step =>
		Option.match(rankedHashes(model), {
			// No page is asked for until the ranking is ready, so none is on screen either.
			onNone: () =>
				model.listKey === null ? NO_STEP : { patch: { listKey: null, pages: [] }, commands: [] },
			onSome: (hashes) => {
				const query = listQueryOf(model.search, hashes)
				const listKey = JSON.stringify(query)
				if (listKey === model.listKey) return NO_STEP
				// A new query is a new page atom: Initial, so the rows give way to the skeleton.
				const first = Keyed.idle<IssuePage, LoadFailure>()
				return keyed(
					first,
					requestKey(context.orgId, "errorIssues.list", query),
					"Load",
					(page): Partial<Model> => ({
						listKey,
						pages: [{ cursor: null, page }],
						// The list remounts under its skeleton: selection and focus start over.
						selectedIds: [],
						selectionAnchor: null,
						focusedId: null,
					}),
					(key) => FetchPage({ key, query }),
				)
			},
		})

/** Volume and trend for the rows on screen, by fingerprint; nothing to ask while there are none. */
const followStep =
	(context: PageContext, mode: RequestMode) =>
	(model: Model): Step => {
		const window = model.window
		if (window === null) return NO_STEP
		const fingerprintHashes = sparkFingerprintHashes(issuesOf(model))
		if (fingerprintHashes.length === 0) return NO_STEP
		const filters = warehouseFiltersOf(model.search, window)
		const bucketSeconds = bucketSecondsOf(window)
		const volume = keyed(
			model.volume,
			requestKey(context.orgId, "getErrorsByType", { data: { ...filters, fingerprintHashes } }),
			mode,
			(next) => ({ volume: next }),
			(key) => FetchVolume({ key, filters, fingerprintHashes }),
		)
		const spark = keyed(
			model.spark,
			requestKey(context.orgId, "getErrorsSpark", {
				data: { ...filters, fingerprintHashes, bucketSeconds },
			}),
			mode,
			(next) => ({ spark: next }),
			(key) => FetchSpark({ key, filters, fingerprintHashes, bucketSeconds }),
		)
		return {
			patch: { ...volume.patch, ...spark.patch },
			commands: [...volume.commands, ...spark.commands],
		}
	}

/** Every request the page makes for the resolved window. */
export const requestAll = (
	model: Model,
	context: PageContext,
	window: TimeWindow,
	mode: RequestMode,
): Return =>
	applySteps({ ...model, window }, [
		summaryStep(context, window, mode),
		...(model.isFilterRailMounted ? [serviceCountsStep(context), environmentsStep(context, window, mode)] : []),
		investigationsStep(context),
		rankingStep(context, window, mode),
		listStep(context),
		followStep(context, mode),
	])

/** After a slot settled: the list may now be ready to ask, and its rows' volume and trend. */
export const follow = (model: Model, context: PageContext): Return =>
	applySteps(model, [listStep(context), followStep(context, "Load")])

/** "Load more": the next cursor's page, or a retry of a failed one. In-flight guarded. */
export const loadMore = (model: Model, context: PageContext): Return => {
	const last = model.pages[model.pages.length - 1]
	if (last === undefined || last.page.key === null) return { model }
	const lastData = last.page.data
	if (model.pages.length > 1 && (AsyncData.isFailure(lastData) || AsyncData.isStale(lastData))) {
		const lastKey = last.page.key
		return Option.match(Keyed.request(last.page, lastKey, "Refresh"), {
			onNone: () => ({ model }),
			onSome: (page) => ({
				model: { ...model, pages: [...model.pages.slice(0, -1), { cursor: last.cursor, page }] },
				commands: [FetchPage({ key: lastKey, query: pageQuery(model, last.cursor) })],
			}),
		})
	}
	return Option.match(AsyncData.getData(lastData), {
		onNone: () => ({ model }),
		onSome: ({ hasMore, nextCursor }) => {
			if (!hasMore || nextCursor === null) return { model }
			if (model.pages.some((slot) => slot.cursor === nextCursor)) return { model }
			const query = pageQuery(model, nextCursor)
			const key = requestKey(context.orgId, "errorIssues.list", query)
			const slot: PageSlot = { cursor: nextCursor, page: { key, data: AsyncData.Loading() } }
			return {
				model: { ...model, pages: [...model.pages, slot] },
				commands: [FetchPage({ key, query })],
			}
		},
	})
}

/** The list query (as keyed by `listKey`) extended by a cursor. */
const pageQuery = (model: Model, cursor: string | null) => {
	const base = listQueryOf(model.search, Option.getOrNull(rankedHashes(model)))
	return cursor === null ? base : { ...base, cursor }
}

// NAVIGATION

/** `navigate({ to: "/errors", search: (prev) => ({ ...prev, ...patch }) })`. */
export const navigate = (model: Model, patch: Partial<Search>): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.Errors({ search: { ...model.search, ...patch } })),
		isReplace: false,
	}),
})

const asView = (value: string) => HUB_VIEWS.find((view) => view === value)
const asSort = (value: string) => HUB_SORTS.find((sort) => sort === value)
const asSeverity = (value: string) => SEVERITY_FILTERS.find((severity) => severity === value)

/** The toolbar's controls: the default value of each leaves the URL. */
export const navigateView = (model: Model, value: string): Return =>
	Option.match(Option.fromNullishOr(asView(value)), {
		onNone: () => ({ model }),
		onSome: (view) => navigate(model, { view: view === "open" ? undefined : view }),
	})

export const navigateSort = (model: Model, value: string): Return =>
	Option.match(Option.fromNullishOr(asSort(value)), {
		onNone: () => ({ model }),
		onSome: (sort) => navigate(model, { sort: sort === "last_seen" ? undefined : sort }),
	})

export const navigateSeverity = (model: Model, value: string): Return =>
	Option.match(Option.fromNullishOr(asSeverity(value)), {
		onNone: () => ({ model }),
		onSome: (severity) => navigate(model, { severity: severity === "all" ? undefined : severity }),
	})

// ENTRY POINTS

const sortIndex = (search: Search) => HUB_SORTS.indexOf(sortOf(search))
const severityIndex = (search: Search) => SEVERITY_FILTERS.indexOf(severityOf(search))

/** The search the toolbar search would send for its draft (trimmed, empty leaves the URL). */
const draftQuery = (draft: string): string | undefined => draft.trim() || undefined

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const search = route.search
	const model: Model = {
		search,
		window: null,
		nowMs: 0,
		summary: Keyed.idle(),
		serviceCounts: Keyed.idle(),
		environments: Keyed.idle(),
		isFilterRailMounted: false,
		ranking: Keyed.idle(),
		rankedFilters: null,
		listKey: null,
		pages: [],
		volume: Keyed.idle(),
		spark: Keyed.idle(),
		investigations: Keyed.idle(),
		presence: SignalPresenceData.Loading(),
		selectedIds: [],
		selectionAnchor: null,
		focusedId: null,
		bulkSeverityMenu: Menu.init("errors-bulk-severity"),
		bulkMoveMenu: Menu.init("errors-bulk-move"),
		writingIds: [],
		rowMenu: ContextMenu.init("errors-row-menu"),
		rowMenuTarget: null,
		picker: null,
		searchDraft: search.q ?? "",
		searchGeneration: 0,
		tabs: Tabs.init({ idBase: 0, values: HUB_VIEWS, selected: viewOf(search) }),
		sortSelect: Select.init("errors-sort", { value: sortOf(search), selectedIndex: sortIndex(search) }),
		severitySelect: Select.init("errors-severity", {
			value: severityOf(search),
			selectedIndex: severityIndex(search),
		}),
		filterSections: FilterSections.init(),
		refreshVersion: 0,
		isReloading: false,
	}
	return {
		model,
		commands: [
			LoadSignalPresence({ orgId: context.orgId }),
			resolveCommand(context, "Load"),
			Command.mapMessage(FilterSections.ReadRemembered(), (message) =>
				Message.GotFilterSectionsMessage({ message }),
			),
		],
	}
}

const searchHref = (search: Search) => hrefOf(AppRoute.Errors({ search }))

/** A filter, tab, sort or search changed: the controls follow the URL, then re-request. */
export const routeChanged = (
	model: Model,
	route: { readonly search: Search },
	context: PageContext,
): Return => {
	const search = route.search
	if (searchHref(model.search) === searchHref(search)) return { model }
	const next: Model = {
		...model,
		search,
		// `ToolbarSearch` resyncs only for a change it did not send itself.
		searchDraft: draftQuery(model.searchDraft) === search.q ? model.searchDraft : (search.q ?? ""),
		tabs: {
			...model.tabs,
			selected: viewOf(search),
			highlightedIndex: HUB_VIEWS.indexOf(viewOf(search)),
		},
		sortSelect: { ...model.sortSelect, value: sortOf(search) },
		severitySelect: { ...model.severitySelect, value: severityOf(search) },
	}
	return next.window === null ? { model: next } : requestAll(next, context, next.window, "Load")
}

export const contextChanged = (model: Model, context: PageContext): Return =>
	model.window === null ? { model } : requestAll(model, context, model.window, "Load")

// EVENTS

const isIssueKind = (value: string): value is IssueKind => SOURCES.some((kind) => kind === value)

/** Checkbox lists are single-select: the newest tick replaces the current one, re-ticking clears. */
const toggledFilter = (model: Model, param: FilterParam, name: string): Partial<Search> => {
	switch (param) {
		case "regressed":
			return { regressed: model.search.regressed === true ? undefined : true }
		case "kind":
			return { kind: name === model.search.kind || !isIssueKind(name) ? undefined : name }
		case "service":
			return { service: name === model.search.service ? undefined : name }
		case "env":
			return { env: name === model.search.env ? undefined : name }
	}
}

export const CLEARED_ERROR_FILTERS = {
	service: undefined,
	env: undefined,
	kind: undefined,
	regressed: undefined,
} satisfies Partial<Search>

/** The header checkbox: every visible row, or none once they all are. */
const toggledAllRows = (model: Model): Partial<Model> => {
	const ids = signalsOf(model).map((signal) => signal.id)
	const isAll = ids.length > 0 && ids.every((id) => model.selectedIds.includes(id))
	return isAll
		? { selectedIds: [], selectionAnchor: null }
		: { selectedIds: [...new Set([...model.selectedIds, ...ids])], selectionAnchor: null }
}

/** A Select submodel step: its OutMessage becomes the page's navigation. */
const selectStep = (
	model: Model,
	select: Select.Model,
	message: Select.Message,
	write: (select: Select.Model) => Partial<Model>,
	wrap: (message: Select.Message) => Message,
	onChange: (model: Model, value: string) => Return,
): Return => {
	const next = Select.update(select, message)
	const updated = { ...model, ...write(next.model) }
	const commands = Command.mapMessages(next.commands ?? [], wrap)
	if (next.outMessage === undefined) return { model: updated, commands }
	const navigation = onChange(updated, next.outMessage.value)
	return { ...navigation, commands: [...commands, ...(navigation.commands ?? [])] }
}

/** The view tabs: a click is the navigation to that view. */
const tabsStep = (model: Model, message: Tabs.Message): Return => {
	const next = Tabs.update(model.tabs, message)
	const updated = { ...model, tabs: next.model }
	const commands = Command.mapMessages(next.commands ?? [], (tabs) =>
		Message.GotTabsMessage({ message: tabs }),
	)
	if (message._tag !== "ClickedTab") return { model: updated, commands }
	const value = model.tabs.values[message.index]
	if (value === undefined || value === model.tabs.selected) return { model: updated, commands }
	const navigation = navigateView(updated, value)
	return { ...navigation, commands }
}

/** The failed first page, asked again. */
const retryFirstPage = (model: Model): Return => {
	const first = model.pages[0]
	if (first === undefined || first.page.key === null) return { model }
	const key = first.page.key
	return Option.match(Keyed.request(first.page, key, "Refresh"), {
		onNone: () => ({ model }),
		onSome: (page) => ({
			model: { ...model, pages: [{ cursor: null, page }, ...model.pages.slice(1)] },
			commands: [FetchPage({ key, query: pageQuery(model, null) })],
		}),
	})
}

/** The failed volume ranking, asked again; its answer requests the list (`follow`). */
const retryRanking = (model: Model, context: PageContext): Return =>
	model.window === null ? { model } : applySteps(model, [rankingStep(context, model.window, "Refresh")])

const settled = <
	K extends "summary" | "serviceCounts" | "environments" | "volume" | "spark" | "investigations",
>(
	model: Model,
	field: K,
	next: Model[K],
): Model => ({ ...model, [field]: next })

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, mode }) =>
			requestAll({ ...model, nowMs }, context, window, mode),
		CompletedFetchSummary: ({ key, result }) => ({
			model: settled(model, "summary", Keyed.accept(model.summary, key, result)),
		}),
		CompletedFetchServiceCounts: ({ key, result }) => ({
			model: settled(model, "serviceCounts", Keyed.accept(model.serviceCounts, key, result)),
		}),
		CompletedFetchEnvironments: ({ key, result }) => ({
			model: settled(model, "environments", Keyed.accept(model.environments, key, result)),
		}),
		CompletedFetchRanking: ({ key, result }) =>
			follow(
				{
					...model,
					ranking: Keyed.accept(model.ranking, key, result),
					rankedFilters: key === model.ranking.key ? rankingFiltersOf(model.search) : model.rankedFilters,
				},
				context,
			),
		CompletedFetchPage: ({ key, result }) =>
			follow(
				{
					...model,
					pages: model.pages.map((slot) =>
						slot.page.key === key
							? { ...slot, page: Keyed.accept(slot.page, key, result) }
							: slot,
					),
				},
				context,
			),
		CompletedFetchVolume: ({ key, result }) => ({
			model: settled(model, "volume", Keyed.accept(model.volume, key, result)),
		}),
		CompletedFetchSpark: ({ key, result }) => ({
			model: settled(model, "spark", Keyed.accept(model.spark, key, result)),
		}),
		CompletedFetchInvestigations: ({ key, result }) => ({
			model: settled(model, "investigations", Keyed.accept(model.investigations, key, result)),
		}),
		MountedFilterRail: () => {
			if (model.isFilterRailMounted) return { model }
			const mounted = { ...model, isFilterRailMounted: true }
			return mounted.window === null ? { model: mounted } : requestAll(mounted, context, mounted.window, "Load")
		},
		CompletedLoadSignalPresence: ({ result }) => ({
			model: { ...model, presence: AsyncData.settle(model.presence, result) },
		}),
		ClickedReload: () => {
			const reloaded = { ...model, refreshVersion: model.refreshVersion + 1, isReloading: true }
			return {
				model: reloaded,
				commands: [
					resolveCommand(context, "Refresh"),
					CompleteReloadSpin({ version: reloaded.refreshVersion }),
				],
			}
		},
		CompletedReloadSpin: ({ version }) =>
			version === model.refreshVersion ? { model: { ...model, isReloading: false } } : { model },
		// TODO(retry): this should reload the whole window; it refetches page one instead.
		ClickedRetry: () => (rankingFailed(model) ? retryRanking(model, context) : retryFirstPage(model)),
		ClickedLoadMore: () => loadMore(model, context),
		ToggledFilterOption: ({ param, name }) => navigate(model, toggledFilter(model, param, name)),
		ClickedClearFilters: () => navigate(model, CLEARED_ERROR_FILTERS),
		RemovedFilterChip: ({ param }) => navigate(model, { [param]: undefined }),
		ChangedSearchDraft: ({ value }) => {
			const searchGeneration = model.searchGeneration + 1
			return {
				model: { ...model, searchDraft: value, searchGeneration },
				commands: [WaitSearchDebounce({ generation: searchGeneration })],
			}
		},
		ElapsedSearchDebounce: ({ generation }) =>
			generation === model.searchGeneration && draftQuery(model.searchDraft) !== model.search.q
				? navigate(model, { q: draftQuery(model.searchDraft) })
				: { model },
		ClickedViewAll: () => navigate(model, { view: "all" }),
		ClickedClearSearch: () => navigate(model, { q: undefined }),
		ClickedShowAllSeverities: () => navigate(model, { severity: undefined }),
		ToggledRow: ({ id }) => ({ model: toggledSelection(model, id, false) }),
		ClickedRowSelect: ({ id, isShift }) => ({ model: toggledSelection(model, id, isShift) }),
		PressedListKey: ({ key, isShift }) => pressedListKey(model, key, isShift, openedPicker),
		ClickedPickerTrigger: ({ id, kind }) => openedPicker(model, id, kind),
		PressedRowPointer: ({ id, point }) => pressedRowPointer(model, id, point),
		OpenedRowMenu: ({ id }) =>
			rowMenuStep(
				model.rowMenuTarget === id ? model : pressedRowPointer(model, id, model.rowMenu.point).model,
				ContextMenu.Message.OpenedContextMenu(),
			),
		GotRowMenuMessage: ({ message: inner }) => rowMenuStep(model, inner),
		CompletedCopy: ({ label, isOk }) => ({
			model,
			outMessage: copyToast(
				label,
				isOk,
				label === "Agent prompt" ? "Agent prompt copied — paste it into your MCP agent" : undefined,
			),
		}),
		CompletedOpenInNewTab: () => ({ model }),
		GotPickerMessage: ({ message: inner }) => pickerStep(model, inner),
		ClickedBulkClaim: () => bulkWrite(model, { _tag: "Claim" }),
		ClickedClearSelection: () => ({ model: { ...model, selectedIds: [], selectionAnchor: null } }),
		GotBulkSeverityMenuMessage: ({ message: inner }) => bulkMenuStep(model, "bulkSeverityMenu", inner),
		GotBulkMoveMenuMessage: ({ message: inner }) => bulkMenuStep(model, "bulkMoveMenu", inner),
		CompletedHubWrite: ({ ids, write, isBulk, outcome }) =>
			completedHubWrite(model, context, ids, write, isBulk, outcome, pageQuery),
		ToggledAllRows: () => ({ model: { ...model, ...toggledAllRows(model) } }),
		HoveredRow: ({ id }) => (model.focusedId === id ? { model } : { model: { ...model, focusedId: id } }),
		ClickedInvestigation: ({ id }) => ({
			model,
			outMessage: PageOutMessage.RequestedNavigation({
				url: hrefOf(AppRoute.Investigation({ id, search: {} })),
				isReplace: false,
			}),
		}),
		GotTabsMessage: ({ message: inner }) => tabsStep(model, inner),
		GotSortSelectMessage: ({ message: inner }) =>
			selectStep(
				model,
				model.sortSelect,
				inner,
				(sortSelect) => ({ sortSelect }),
				(next) => Message.GotSortSelectMessage({ message: next }),
				navigateSort,
			),
		GotSeveritySelectMessage: ({ message: inner }) =>
			selectStep(
				model,
				model.severitySelect,
				inner,
				(severitySelect) => ({ severitySelect }),
				(next) => Message.GotSeveritySelectMessage({ message: next }),
				navigateSeverity,
			),
		GotFilterSectionsMessage: ({ message: inner }) => {
			const next = FilterSections.update(model.filterSections, inner)
			return {
				model: { ...model, filterSections: next.model },
				commands: Command.mapMessages(next.commands ?? [], (sections) =>
					Message.GotFilterSectionsMessage({ message: sections }),
				),
			}
		},
	})
