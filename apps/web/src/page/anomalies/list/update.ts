import type { AnomalyIncidentDocument } from "@maple/domain/http"
import { Option, Result } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import * as FilterSections from "../../../ui/filters/filter-sections"
import * as Tabs from "../../../ui/tabs"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { SignalPresenceData } from "../../kit/signal-presence"
import {
	FetchFirstPage,
	listQueryOf,
	LoadMoreIncidents,
	LoadSignalPresence,
	ReadAnomaliesClock,
	ScrollIncidentIntoView,
} from "./command"
import {
	allIncidentsOf,
	anomalyFilterChips,
	facetsOf,
	filteredOf,
	filtersOf,
	groupIncidents,
	isLiveOf,
	nextCursorOf,
	type Search,
	statusOf,
} from "./derive"
import { type Facet, Message } from "./message"
import type { Model, StatusTab } from "./model"
import { anomalyHref } from "../kit/row"

type Return = PageReturn<Model, Message>
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>

export const STATUS_TABS: ReadonlyArray<StatusTab> = ["open", "resolved", "all"]

const EXCLUDED_OF = {
	severity: "excludedSeverity",
	signals: "excludedSignals",
	services: "excludedServices",
	envs: "excludedEnvs",
} as const satisfies Record<Facet, keyof Search>

/** Requests the tab's first page under `mode`; a refresh drops the "Load more" pages. */
const loadFirstPage = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const status = statusOf(model.search)
	const key = requestKey(context.orgId, "anomalies.listIncidents", { query: listQueryOf(status) })
	const base = mode === "Refresh" ? { ...model, loadedPages: null } : model
	return Option.match(Keyed.request(model.firstPage, key, mode), {
		onNone: () => ({ model: base }),
		onSome: (firstPage) => ({ model: { ...base, firstPage }, commands: [FetchFirstPage({ key, status })] }),
	})
}

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const model: Model = {
		search: route.search,
		nowMs: 0,
		firstPage: Keyed.idle(),
		loadedPages: null,
		isLoadingMore: false,
		presence: SignalPresenceData.Loading(),
		tabs: Tabs.init({ idBase: 0, values: STATUS_TABS, selected: statusOf(route.search) }),
		filterSections: FilterSections.init(),
		collapsedGroups: [],
		focusedId: null,
	}
	const loaded = loadFirstPage(model, context, "Load")
	return {
		model: loaded.model,
		commands: [
			LoadSignalPresence({ orgId: context.orgId }),
			ReadAnomaliesClock(),
			...(loaded.commands ?? []),
			Command.mapMessage(FilterSections.ReadRemembered(), (message) => Message.GotFilterSectionsMessage({ message })),
		],
	}
}

export const routeChanged = (model: Model, route: { readonly search: Search }, context: PageContext): Return => {
	const status = statusOf(route.search)
	const next: Model = {
		...model,
		search: route.search,
		tabs: { ...model.tabs, selected: status, highlightedIndex: STATUS_TABS.indexOf(status) },
	}
	return loadFirstPage(next, context, "Load")
}

const navigate = (search: Search): Return["outMessage"] =>
	PageOutMessage.RequestedNavigation({ url: hrefOf(AppRoute.Anomalies({ search })), isReplace: false })

const toNavigation = (model: Model, search: Search): Return => ({ model, outMessage: navigate(search) })

const listOrUndefined = <A>(values: ReadonlyArray<A>) => (values.length === 0 ? undefined : values)

/** Severity and signal keep the sidebar's order and drop values the tab has no rows for. */
const inFacetOrder = <A extends string>(entries: ReadonlyArray<readonly [A, number]>, values: ReadonlyArray<string>) =>
	listOrUndefined(entries.map(([name]) => name).filter((name) => values.includes(name)))

const withFacet = (model: Model, facet: Facet, selected: ReadonlyArray<string>, excluded: ReadonlyArray<string>): Search => {
	const facets = facetsOf(allIncidentsOf(model))
	switch (facet) {
		case "severity":
			return {
				...model.search,
				severity: inFacetOrder(facets.severity, selected),
				excludedSeverity: inFacetOrder(facets.severity, excluded),
			}
		case "signals":
			return {
				...model.search,
				signals: inFacetOrder(facets.signals, selected),
				excludedSignals: inFacetOrder(facets.signals, excluded),
			}
		case "services":
			return { ...model.search, services: listOrUndefined(selected), excludedServices: listOrUndefined(excluded) }
		case "envs":
			return { ...model.search, envs: listOrUndefined(selected), excludedEnvs: listOrUndefined(excluded) }
	}
}

const facetValues = (model: Model, facet: Facet) => {
	const selected: ReadonlyArray<string> = model.search[facet] ?? []
	const excluded: ReadonlyArray<string> = model.search[EXCLUDED_OF[facet]] ?? []
	return { selected, excluded }
}

const toggledFacet = (model: Model, facet: Facet, name: string): Search => {
	const { selected, excluded } = facetValues(model, facet)
	return withFacet(
		model,
		facet,
		selected.includes(name) ? selected.filter((value) => value !== name) : [...selected, name],
		excluded.filter((value) => value !== name),
	)
}

const excludedFacet = (model: Model, facet: Facet, name: string): Search => {
	const { selected, excluded } = facetValues(model, facet)
	return withFacet(
		model,
		facet,
		selected.filter((value) => value !== name),
		excluded.includes(name) ? excluded.filter((value) => value !== name) : [...excluded, name],
	)
}

const tabsStep = (model: Model, message: Tabs.Message): Return => {
	const next = Tabs.update(model.tabs, message)
	const updated = { ...model, tabs: next.model }
	const commands: Commands = Command.mapMessages(next.commands ?? [], (tabs) => Message.GotTabsMessage({ message: tabs }))
	if (message._tag !== "ClickedTab") return { model: updated, commands }
	const value = model.tabs.values[message.index]
	if (value === undefined || value === model.tabs.selected) return { model: updated, commands }
	const status = value === "resolved" || value === "all" ? value : undefined
	return { model: updated, commands, outMessage: navigate({ ...model.search, status }) }
}

/** The rows in reading order: every visible group's incidents, collapsed groups included. */
const rowsInOrder = (model: Model): ReadonlyArray<AnomalyIncidentDocument> =>
	groupIncidents(filteredOf(model, allIncidentsOf(model))).flatMap(([, incidents]) => incidents)

/** `useListNavigation` over the incident rows. */
const pressedListKey = (model: Model, key: "Next" | "Previous" | "Open" | "Escape"): Return => {
	if (key === "Escape") return model.focusedId === null ? { model } : { model: { ...model, focusedId: null } }
	const incidents = rowsInOrder(model)
	if (key === "Open") {
		const focused = incidents.find((incident) => incident.id === model.focusedId)
		return focused === undefined
			? { model }
			: {
					model,
					outMessage: PageOutMessage.RequestedNavigation({ url: anomalyHref(focused.id), isReplace: false }),
				}
	}
	if (incidents.length === 0) return { model }
	const current = model.focusedId === null ? -1 : incidents.findIndex((incident) => incident.id === model.focusedId)
	const next =
		key === "Next"
			? current < 0
				? 0
				: Math.min(current + 1, incidents.length - 1)
			: current <= 0
				? 0
				: current - 1
	const target = incidents[next]
	if (target === undefined) return { model }
	return {
		model: { ...model, focusedId: target.id },
		commands: [ScrollIncidentIntoView({ incidentId: target.id })],
	}
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedFetchFirstPage: ({ key, result }) => ({
			model: { ...model, firstPage: Keyed.accept(model.firstPage, key, result) },
		}),
		ClickedLoadMore: () => {
			const cursor = nextCursorOf(model)
			return cursor === null || model.isLoadingMore
				? { model }
				: {
						model: { ...model, isLoadingMore: true },
						commands: [LoadMoreIncidents({ status: statusOf(model.search), cursor })],
					}
		},
		CompletedLoadMore: ({ status, cursor, result }) =>
			status !== statusOf(model.search) || cursor !== nextCursorOf(model)
				? { model: { ...model, isLoadingMore: false } }
				: Result.match(result, {
						onFailure: () => ({
							model: { ...model, isLoadingMore: false },
							outMessage: PageOutMessage.RequestedToast({
								type: "error",
								title: "Couldn't load more anomalies",
								description: "",
							}),
						}),
						onSuccess: (page) => ({
							model: {
								...model,
								isLoadingMore: false,
								loadedPages: {
									key: status,
									rows: [...(model.loadedPages?.key === status ? model.loadedPages.rows : []), ...page.data],
									nextCursor: page.nextCursor,
								},
							},
						}),
					}),
		ClickedRetry: () => loadFirstPage(model, context, "Refresh"),
		TickedLiveRefresh: ({ nowMs }) => loadFirstPage({ ...model, nowMs }, context, "Refresh"),
		ToggledLive: () => {
			const next = !isLiveOf(model.search)
			return toNavigation(model, {
				...model.search,
				live: next === (statusOf(model.search) === "open") ? undefined : next,
			})
		},
		ToggledFacetOption: ({ facet, name }) => toNavigation(model, toggledFacet(model, facet, name)),
		ClickedOnlyFacetOption: ({ facet, name }) =>
			toNavigation(model, withFacet(model, facet, [name], [])),
		ClickedExcludeFacetOption: ({ facet, name }) => toNavigation(model, excludedFacet(model, facet, name)),
		RemovedFilterChip: ({ param }) => toNavigation(model, { ...model.search, [param]: undefined }),
		ClickedClearFilters: () =>
			toNavigation(model, { status: model.search.status, live: model.search.live }),
		ClickedClearExclusions: () =>
			toNavigation(model, {
				...model.search,
				...Object.fromEntries(
					anomalyFilterChips(filtersOf(model.search))
						.filter((chip) => chip.negated)
						.map((chip) => [chip.param, undefined]),
				),
			}),
		ToggledGroup: ({ group }) => ({
			model: {
				...model,
				collapsedGroups: model.collapsedGroups.includes(group)
					? model.collapsedGroups.filter((key) => key !== group)
					: [...model.collapsedGroups, group],
			},
		}),
		HoveredRow: ({ id }) => (model.focusedId === id ? { model } : { model: { ...model, focusedId: id } }),
		PressedListKey: ({ key }) => pressedListKey(model, key),
		CompletedScrollRow: () => ({ model }),
		CompletedLoadSignalPresence: ({ result }) => ({
			model: { ...model, presence: AsyncData.settle(model.presence, result) },
		}),
		GotTabsMessage: ({ message: inner }) => tabsStep(model, inner),
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
