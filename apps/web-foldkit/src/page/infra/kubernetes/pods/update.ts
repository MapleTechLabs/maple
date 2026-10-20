import { podKey } from "../../../../components/infra/pod-restarts"
import { AsyncData, Command } from "foldkit"
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
import { pickTimeSearch } from "../../kit/view-tabs"
import * as PeekMessage from "../peek/message"
import * as PeekUpdate from "../peek/update"
import { PAGE_RESTARTS_LIMIT, type PodsInput } from "../pod-data"
import type { PodSortKey } from "../pod-table"
import { DebounceSearch, FetchFacets, FetchPods, FetchRestarts, FetchSummary, PAGE_SIZE } from "./command"
import { type Facet, Message } from "./message"
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
	namespaces: "excludedNamespaces",
	podNames: "excludedPodNames",
	nodeNames: "excludedNodeNames",
	clusters: "excludedClusters",
	deployments: "excludedDeployments",
	statefulsets: "excludedStatefulsets",
	daemonsets: "excludedDaemonsets",
	jobs: "excludedJobs",
	environments: "excludedEnvironments",
	computeTypes: "excludedComputeTypes",
} as const satisfies Record<Facet, string>

export const filtersOf = (search: Search) => ({
	podNames: search.podNames,
	namespaces: search.namespaces,
	nodeNames: search.nodeNames,
	clusters: search.clusters,
	deployments: search.deployments,
	statefulsets: search.statefulsets,
	daemonsets: search.daemonsets,
	jobs: search.jobs,
	environments: search.environments,
	computeTypes: search.computeTypes,
	excludedPodNames: search.excludedPodNames,
	excludedNamespaces: search.excludedNamespaces,
	excludedNodeNames: search.excludedNodeNames,
	excludedClusters: search.excludedClusters,
	excludedDeployments: search.excludedDeployments,
	excludedStatefulsets: search.excludedStatefulsets,
	excludedDaemonsets: search.excludedDaemonsets,
	excludedJobs: search.excludedJobs,
	excludedEnvironments: search.excludedEnvironments,
	excludedComputeTypes: search.excludedComputeTypes,
})

export const sortOf = (search: Search) => {
	const sortBy: PodSortKey = search.sortBy ?? "saturation"
	const sortDir: SortDir = search.sortDir ?? (sortBy === "podName" ? "asc" : "desc")
	return { sortBy, sortDir }
}

const resetKeyOf = (model: Model) =>
	JSON.stringify({
		filters: filtersOf(model.search),
		q: model.debouncedQuery.trim(),
		scope: model.search.scope,
		...sortOf(model.search),
	})

export const pageIndexOf = (model: Model) => (model.page.resetKey === resetKeyOf(model) ? model.page.index : 0)

/** "Ended" swaps the fleet on screen (lifecycle); the other scopes narrow the live one. */
export const podsInput = (model: Model, window: TimeWindow): PodsInput => {
	const scope = model.search.scope
	const query = model.debouncedQuery.trim()
	return {
		startTime: window.startTime,
		endTime: window.endTime,
		...filtersOf(model.search),
		search: query === "" ? undefined : query,
		scope: scope === "ended" ? undefined : scope,
		lifecycle: scope === "ended" ? "ended" : "live",
		...sortOf(model.search),
		limit: PAGE_SIZE,
		offset: pageIndexOf(model) * PAGE_SIZE,
	}
}

type RequestStep = (model: Model, context: PageContext, window: TimeWindow, mode: Frame.RequestMode) => Step<Model, Message>

const podsStep: RequestStep = (model, context, window, mode) => {
	const input = podsInput(model, window)
	return keyed(
		model.pods,
		requestKey(context.orgId, "listPods", { data: input }),
		mode,
		(pods) => ({ pods }),
		(key) => FetchPods({ key, input }),
	)
}

const facetsStep: RequestStep = (model, context, window, mode) =>
	keyed(
		model.facets,
		requestKey(context.orgId, "podFacets", { data: window }),
		mode,
		(facets) => ({ facets }),
		(key) => FetchFacets({ key, window }),
	)

const toPeek = (message: PeekMessage.Message) => Message.GotPeekMessage({ message })

/** The peek resolves against the page on screen. */
export const peekOf = (model: Model) =>
	PeekUpdate.resolvePeek(AsyncData.getOrElse(model.pods.data, () => null)?.data ?? [], model.search.peek)

const syncPeek = (context: PageContext, result: Return): Return => {
	const synced = PeekUpdate.sync(result.model.peek, context, result.model.frame.window, peekOf(result.model))
	return {
		...result,
		model: { ...result.model, peek: synced.model },
		commands: [...(result.commands ?? []), ...Command.mapMessages(synced.commands ?? [], toPeek)],
	}
}

/** The restarts of the page on screen, once it has rows (`PodTableWithRestarts` mounts with them). */
const followPods =
	(context: PageContext) =>
	(result: Return): Return =>
		syncPeek(context, followRestarts(context, result))

const followRestarts = (context: PageContext, result: Return): Return => {
	const { model } = result
	const window = model.frame.window
	const pods = AsyncData.getOrElse(model.pods.data, () => null)
	if (window === null || pods === null || pods.data.length === 0) return result
	const input = {
		startTime: window.startTime,
		endTime: window.endTime,
		podNames: pods.data.map((pod) => pod.podName),
		limit: PAGE_RESTARTS_LIMIT,
	}
	const step: Step<Model, Message> = keyed(
		model.restarts,
		requestKey(context.orgId, "podRestarts", { data: input }),
		"Load",
		(restarts) => ({ restarts }),
		(key) => FetchRestarts({ key, input }),
	)
	return {
		...result,
		model: { ...model, ...step.patch },
		commands: [...(result.commands ?? []), ...step.commands],
	}
}

const requestAll = (model: Model, context: PageContext, mode: Frame.RequestMode): Return => {
	const window = model.frame.window
	if (window === null) return { model }
	const summaryInput = {
		startTime: window.startTime,
		endTime: window.endTime,
		clusters: model.search.clusters,
		environments: model.search.environments,
		namespaces: model.search.namespaces,
	}
	return followPods(context)(
		applySteps<Model, Message>(model, [
			podsStep(model, context, window, mode),
			keyed(
				model.summary,
				requestKey(context.orgId, "podsSummary", { data: summaryInput }),
				mode,
				(summary) => ({ summary }),
				(key) => FetchSummary({ key, input: summaryInput }),
			),
			facetsStep(model, context, window, mode),
		]),
	)
}

const navigate = (model: Model, search: Search, isReplace = false): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.InfraKubernetesPods({ search })),
		isReplace,
	}),
})

const withFacet = (search: Search, facet: Facet, lists: FacetLists): Search => ({
	...search,
	[facet]: lists.selected,
	[EXCLUDED_OF[facet]]: lists.excluded,
})

const listsOf = (search: Search, facet: Facet): FacetLists => ({
	selected: search[facet],
	excluded: search[EXCLUDED_OF[facet]],
})

const liftInstall = (model: Model, result: InstallModal.Return): Return => ({
	model: { ...model, install: result.model },
	commands: Command.mapMessages(result.commands ?? [], (message) => Message.GotInstallMessage({ message })),
})

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const model: Model = {
		search: route.search,
		frame: Frame.init("infra-pods-time-range"),
		debouncedQuery: route.search.q ?? "",
		page: { resetKey: "", index: 0 },
		pods: Keyed.idle(),
		restarts: Keyed.idle(),
		summary: Keyed.idle(),
		facets: Keyed.idle(),
		filterSections: FilterSections.init(),
		install: InstallModal.init("infra-pods-install", "kubernetes"),
		peek: PeekUpdate.init("infra-pods-peek"),
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
	const href = (search: Search) => hrefOf(AppRoute.InfraKubernetesPods({ search }))
	if (href(model.search) === href(route.search)) return { model }
	const next = { ...model, search: route.search }
	const debounce =
		(model.search.q ?? "") === (route.search.q ?? "") ? [] : [DebounceSearch({ query: route.search.q ?? "" })]
	const requested = routeFrame(model.search, next, scopeOf(next, context), toFrame, (moved, mode) => requestAll(moved, context, mode))
	return { ...requested, commands: [...(requested.commands ?? []), ...debounce] }
}

export const contextChanged = (model: Model, context: PageContext): Return => requestAll(model, context, "Load")

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedFetchPods: ({ key, result }) =>
			followPods(context)({ model: { ...model, pods: Keyed.accept(model.pods, key, result) } }),
		CompletedFetchRestarts: ({ key, result }) => ({
			model: { ...model, restarts: Keyed.accept(model.restarts, key, result) },
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
		ChangedScope: ({ scope }) => navigate(model, { ...model.search, scope, peek: undefined }),
		ClickedShowEnded: () => navigate(model, { ...model.search, scope: "ended" }),
		ClickedSort: ({ key }) => {
			const { sortBy, sortDir } = sortOf(model.search)
			return key === sortBy
				? navigate(model, { ...model.search, sortDir: sortDir === "desc" ? "asc" : "desc" })
				: navigate(model, { ...model.search, sortBy: key, sortDir: key === "podName" ? "asc" : "desc" })
		},
		ToggledFacetOption: ({ facet, name }) =>
			navigate(model, withFacet(model.search, facet, toggledValue(listsOf(model.search, facet), name))),
		ClickedOnlyFacetOption: ({ facet, name }) => navigate(model, withFacet(model.search, facet, onlyValue(name))),
		ClickedExcludeFacetOption: ({ facet, name }) =>
			navigate(model, withFacet(model.search, facet, excludedValue(listsOf(model.search, facet), name))),
		ClickedClearFilters: () => navigate(model, pickTimeSearch(model.search)),
		RemovedFilterChip: ({ param }) => navigate(model, { ...model.search, [param]: undefined }),
		ClickedPage: ({ direction }) =>
			requestAll(
				{ ...model, page: { resetKey: resetKeyOf(model), index: Math.max(0, pageIndexOf(model) + direction) } },
				context,
				"Load",
			),
		ClickedRetryPods: () =>
			model.frame.window === null
				? { model }
				: followPods(context)(
						applySteps<Model, Message>(model, [podsStep(model, context, model.frame.window, "Refresh")]),
					),
		ClickedPeekRow: ({ key }) => navigate(model, { ...model.search, peek: key }),
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
		GotPeekMessage: ({ message: inner }) => updatePeek(model, inner, context),
	})

/** Stepping and closing replace history: walking fifty rows must not leave fifty entries. */
const updatePeek = (model: Model, message: PeekMessage.Message, context: PageContext): Return => {
	const peek = peekOf(model)
	const result = PeekUpdate.update(model.peek, message, context, model.frame.window, peek)
	const lifted = { ...model, peek: result.model }
	const commands = Command.mapMessages(result.commands ?? [], toPeek)
	const out = result.outMessage
	if (out === undefined) return { model: lifted, commands }
	if (out._tag === "Closed") return { ...navigate(lifted, { ...model.search, peek: undefined }, true), commands }
	const pods = AsyncData.getOrElse(model.pods.data, () => null)?.data ?? []
	const next = peek === null ? undefined : pods[peek.index + out.step]
	return next === undefined
		? { model: lifted, commands }
		: { ...navigate(lifted, { ...model.search, peek: podKey(next) }, true), commands }
}
