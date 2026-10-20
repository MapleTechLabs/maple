import { Command } from "foldkit"
import * as Keyed from "../../../../data/keyed"
import { requestKey } from "../../../../data/request-key"
import type { TimeWindow } from "../../../../data/time-range"
import { AppRoute, hrefOf } from "../../../../route"
import * as FilterSections from "../../../../ui/filters/filter-sections"
import { type PageContext, PageOutMessage, type PageReturn } from "../../../contract"
import type { SortDir } from "../../../kit/table-sort"
import { excludedValue, type FacetLists, onlyValue, toggledValue } from "../../kit/facets"
import * as Frame from "../../kit/frame"
import { liftFrame, resolveFrame, routeFrame } from "../../kit/frame-step"
import * as InstallModal from "../../kit/install-modal"
import { applySteps, keyed, type Step } from "../../kit/requests"
import { type ContainersInput, DebounceSearch, FetchContainers, FetchFacets, FetchSummary, PAGE_SIZE } from "./command"
import { type ContainerSortKey, type Facet, Message } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
export type Search = Model["search"]

export const DEFAULT_PRESET = "12h"

const toFrame = (message: Frame.Message) => Message.GotFrameMessage({ message })
const scopeOf = (model: Model, context: PageContext): Frame.Scope => ({
	search: model.search,
	defaultPreset: DEFAULT_PRESET,
	timeZone: context.timeZone,
})

export const EXCLUDED_OF = {
	containerNames: "excludedContainerNames",
	images: "excludedImages",
	hostNames: "excludedHostNames",
	composeProjects: "excludedComposeProjects",
	composeServices: "excludedComposeServices",
	environments: "excludedEnvironments",
} as const satisfies Record<Facet, string>

/** The `ContainerFilters` the URL carries. */
export const filtersOf = (search: Search) => ({
	containerNames: search.containerNames,
	hostNames: search.hostNames,
	images: search.images,
	composeProjects: search.composeProjects,
	composeServices: search.composeServices,
	environments: search.environments,
	excludedContainerNames: search.excludedContainerNames,
	excludedHostNames: search.excludedHostNames,
	excludedImages: search.excludedImages,
	excludedComposeProjects: search.excludedComposeProjects,
	excludedComposeServices: search.excludedComposeServices,
	excludedEnvironments: search.excludedEnvironments,
})

export const sortOf = (search: Search) => {
	const sortBy: ContainerSortKey = search.sortBy ?? "saturation"
	const sortDir: SortDir = search.sortDir ?? (sortBy === "containerName" ? "asc" : "desc")
	return { sortBy, sortDir }
}

/** `useResettingPage`'s key: the page index survives only while this is unchanged. */
const resetKeyOf = (model: Model) =>
	JSON.stringify({
		filters: filtersOf(model.search),
		q: model.debouncedQuery.trim(),
		scope: model.search.scope,
		...sortOf(model.search),
	})

export const pageIndexOf = (model: Model) => (model.page.resetKey === resetKeyOf(model) ? model.page.index : 0)

export const containersInput = (model: Model, window: TimeWindow): ContainersInput => ({
	startTime: window.startTime,
	endTime: window.endTime,
	...filtersOf(model.search),
	search: model.debouncedQuery.trim() === "" ? undefined : model.debouncedQuery.trim(),
	scope: model.search.scope,
	...sortOf(model.search),
	limit: PAGE_SIZE,
	offset: pageIndexOf(model) * PAGE_SIZE,
})

type RequestStep = (model: Model, context: PageContext, window: TimeWindow, mode: Frame.RequestMode) => Step<Model, Message>

const containersStep: RequestStep = (model, context, window, mode) => {
	const input = containersInput(model, window)
	return keyed(
		model.containers,
		requestKey(context.orgId, "listContainers", { data: input }),
		mode,
		(containers) => ({ containers }),
		(key) => FetchContainers({ key, input }),
	)
}

const facetsStep: RequestStep = (model, context, window, mode) =>
	keyed(
		model.facets,
		requestKey(context.orgId, "containerFacets", { data: window }),
		mode,
		(facets) => ({ facets }),
		(key) => FetchFacets({ key, window }),
	)

/** Every query the page reads, for the resolved window. */
const requestAll = (model: Model, context: PageContext, mode: Frame.RequestMode): Return => {
	const window = model.frame.window
	if (window === null) return { model }
	const summaryInput = {
		startTime: window.startTime,
		endTime: window.endTime,
		hostNames: model.search.hostNames,
		environments: model.search.environments,
	}
	return applySteps<Model, Message>(model, [
		containersStep(model, context, window, mode),
		keyed(
			model.summary,
			requestKey(context.orgId, "containersSummary", { data: summaryInput }),
			mode,
			(summary) => ({ summary }),
			(key) => FetchSummary({ key, input: summaryInput }),
		),
		facetsStep(model, context, window, mode),
	])
}

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.InfraContainers({ search })),
		isReplace: false,
	}),
})

/** `onFilterChange` for one facet, both polarities. */
const withFacet = (search: Search, facet: Facet, lists: FacetLists): Search => ({
	...search,
	[facet]: lists.selected,
	[EXCLUDED_OF[facet]]: lists.excluded,
})

const listsOf = (search: Search, facet: Facet): FacetLists => ({
	selected: search[facet],
	excluded: search[EXCLUDED_OF[facet]],
})

const windowOnly = (search: Search): Search => ({
	startTime: search.startTime,
	endTime: search.endTime,
	timePreset: search.timePreset,
})

const liftInstall = (model: Model, result: InstallModal.Return): Return => ({
	model: { ...model, install: result.model },
	commands: Command.mapMessages(result.commands ?? [], (message) => Message.GotInstallMessage({ message })),
})

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const model: Model = {
		search: route.search,
		frame: Frame.init("infra-containers-time-range"),
		debouncedQuery: route.search.q ?? "",
		page: { resetKey: "", index: 0 },
		containers: Keyed.idle(),
		summary: Keyed.idle(),
		facets: Keyed.idle(),
		filterSections: FilterSections.init(),
		install: InstallModal.init("infra-containers-install", "docker"),
	}
	return {
		model,
		commands: [
			resolveFrame(model.frame, scopeOf(model, context), toFrame, "Load"),
			Command.mapMessage(FilterSections.ReadRemembered(), (message) =>
				Message.GotFilterSectionsMessage({ message }),
			),
		],
	}
}

export const routeChanged = (model: Model, route: { readonly search: Search }, context: PageContext): Return => {
	const href = (search: Search) => hrefOf(AppRoute.InfraContainers({ search }))
	if (href(model.search) === href(route.search)) return { model }
	const next = { ...model, search: route.search }
	const debounce =
		(model.search.q ?? "") === (route.search.q ?? "") ? [] : [DebounceSearch({ query: route.search.q ?? "" })]
	const requested = routeFrame(model.search, next, scopeOf(next, context), toFrame, (moved, mode) => requestAll(moved, context, mode))
	return { ...requested, commands: [...(requested.commands ?? []), ...debounce] }
}

export const contextChanged = (model: Model, context: PageContext): Return => requestAll(model, context, "Load")

const retry = (model: Model, context: PageContext, step: RequestStep): Return =>
	model.frame.window === null
		? { model }
		: applySteps<Model, Message>(model, [step(model, context, model.frame.window, "Refresh")])

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedFetchContainers: ({ key, result }) => ({
			model: { ...model, containers: Keyed.accept(model.containers, key, result) },
		}),
		CompletedFetchSummary: ({ key, result }) => ({
			model: { ...model, summary: Keyed.accept(model.summary, key, result) },
		}),
		CompletedFetchFacets: ({ key, result }) => ({
			model: { ...model, facets: Keyed.accept(model.facets, key, result) },
		}),
		ElapsedSearchDebounce: ({ query }) =>
			query !== (model.search.q ?? "") || query === model.debouncedQuery
				? { model }
				: requestAll({ ...model, debouncedQuery: query }, context, "Load"),
		ChangedQuery: ({ value }) => navigate(model, { ...model.search, q: value === "" ? undefined : value }),
		ChangedScope: ({ scope }) => navigate(model, { ...model.search, scope }),
		// A header cycles desc and asc on its key; a new key starts where the interesting rows are.
		ClickedSort: ({ key }) => {
			const { sortBy, sortDir } = sortOf(model.search)
			return key === sortBy
				? navigate(model, { ...model.search, sortDir: sortDir === "desc" ? "asc" : "desc" })
				: navigate(model, { ...model.search, sortBy: key, sortDir: key === "containerName" ? "asc" : "desc" })
		},
		ToggledFacetOption: ({ facet, name }) =>
			navigate(model, withFacet(model.search, facet, toggledValue(listsOf(model.search, facet), name))),
		ClickedOnlyFacetOption: ({ facet, name }) => navigate(model, withFacet(model.search, facet, onlyValue(name))),
		ClickedExcludeFacetOption: ({ facet, name }) =>
			navigate(model, withFacet(model.search, facet, excludedValue(listsOf(model.search, facet), name))),
		ClickedClearFilters: () => navigate(model, windowOnly(model.search)),
		RemovedFilterChip: ({ param }) => navigate(model, { ...model.search, [param]: undefined }),
		ClickedPage: ({ direction }) =>
			requestAll(
				{ ...model, page: { resetKey: resetKeyOf(model), index: Math.max(0, pageIndexOf(model) + direction) } },
				context,
				"Load",
			),
		ClickedRetryContainers: () => retry(model, context, containersStep),
		GotFilterSectionsMessage: ({ message: inner }) => {
			const next = FilterSections.update(model.filterSections, inner)
			return {
				model: { ...model, filterSections: next.model },
				commands: Command.mapMessages(next.commands, (m) => Message.GotFilterSectionsMessage({ message: m })),
			}
		},
		GotFrameMessage: ({ message: inner }) =>
			liftFrame(model, inner, scopeOf(model, context), toFrame, {
				onResolved: (next, mode) => requestAll(next, context, mode),
				onTimeSearch: (next, search) => navigate(next, { ...next.search, ...search }),
			}),
		GotInstallMessage: ({ message: inner }) => liftInstall(model, InstallModal.update(model.install, inner)),
	})
