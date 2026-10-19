import { Command } from "foldkit"
import * as Keyed from "../../../../data/keyed"
import { requestKey } from "../../../../data/request-key"
import type { TimeWindow } from "../../../../data/time-range"
import { AppRoute, hrefOf } from "../../../../route"
import * as FilterSections from "../../../../ui/filters/filter-sections"
import { type PageContext, PageOutMessage, type PageReturn } from "../../../contract"
import { toggledValue } from "../../kit/facets"
import * as Frame from "../../kit/frame"
import { liftFrame, resolveFrame, routeFrame } from "../../kit/frame-step"
import * as InstallModal from "../../kit/install-modal"
import { applySteps, keyed, type Step } from "../../kit/requests"
import { nextSort } from "../../../kit/table-sort"
import { pickTimeSearch } from "../../kit/view-tabs"
import { FetchFacets, FetchNodes, type NodesInput } from "./command"
import { Message } from "./message"
import { type Model, NODE_LIST_LIMIT } from "./model"

type Return = PageReturn<Model, Message>
export type Search = Model["search"]

export const DEFAULT_PRESET = "12h"

const toFrame = (message: Frame.Message) => Message.GotFrameMessage({ message })
const scopeOf = (model: Model, context: PageContext): Frame.Scope => ({
	search: model.search,
	defaultPreset: DEFAULT_PRESET,
	timeZone: context.timeZone,
})

export const filtersOf = (search: Search) => ({
	nodeNames: search.nodeNames,
	clusters: search.clusters,
	environments: search.environments,
})

type RequestStep = (model: Model, context: PageContext, window: TimeWindow, mode: Frame.RequestMode) => Step<Model, Message>

const nodesStep: RequestStep = (model, context, window, mode) => {
	const input: NodesInput = { ...window, ...filtersOf(model.search), limit: NODE_LIST_LIMIT }
	return keyed(
		model.nodes,
		requestKey(context.orgId, "listNodes", { data: input }),
		mode,
		(nodes) => ({ nodes }),
		(key) => FetchNodes({ key, input }),
	)
}

const requestAll = (model: Model, context: PageContext, mode: Frame.RequestMode): Return => {
	const window = model.frame.window
	if (window === null) return { model }
	return applySteps<Model, Message>(model, [
		nodesStep(model, context, window, mode),
		keyed(
			model.facets,
			requestKey(context.orgId, "nodeFacets", { data: window }),
			mode,
			(facets) => ({ facets }),
			(key) => FetchFacets({ key, window }),
		),
	])
}

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.InfraKubernetesNodes({ search })),
		isReplace: false,
	}),
})

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const model: Model = {
		search: route.search,
		frame: Frame.init("infra-nodes-time-range"),
		nodes: Keyed.idle(),
		facets: Keyed.idle(),
		sort: { key: "cpuUtilization", dir: "desc" },
		filterSections: FilterSections.init(),
		install: InstallModal.init("infra-nodes-install", "kubernetes"),
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

/** `q` and `status` filter the loaded list; the facets and the window re-request. */
export const routeChanged = (model: Model, route: { readonly search: Search }, context: PageContext): Return => {
	const href = (search: Search) => hrefOf(AppRoute.InfraKubernetesNodes({ search }))
	if (href(model.search) === href(route.search)) return { model }
	const next = { ...model, search: route.search }
	return routeFrame(model.search, next, scopeOf(next, context), toFrame, (moved, mode) => requestAll(moved, context, mode))
}

export const contextChanged = (model: Model, context: PageContext): Return => requestAll(model, context, "Load")

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedFetchNodes: ({ key, result }) => ({ model: { ...model, nodes: Keyed.accept(model.nodes, key, result) } }),
		CompletedFetchFacets: ({ key, result }) => ({
			model: { ...model, facets: Keyed.accept(model.facets, key, result) },
		}),
		ChangedQuery: ({ value }) => navigate(model, { ...model.search, q: value === "" ? undefined : value }),
		ChangedStatus: ({ status }) => navigate(model, { ...model.search, status }),
		ClickedClearSearch: () => navigate(model, { ...model.search, q: undefined, status: undefined }),
		ClickedSort: ({ key }) => ({ model: { ...model, sort: nextSort(model.sort, key, { stringKeys: ["nodeName"] }) } }),
		ToggledFacetOption: ({ facet, name }) =>
			navigate(model, {
				...model.search,
				[facet]: toggledValue({ selected: model.search[facet], excluded: undefined }, name).selected,
			}),
		ClickedClearFilters: () => navigate(model, pickTimeSearch(model.search)),
		ClickedRetryNodes: () =>
			model.frame.window === null
				? { model }
				: applySteps<Model, Message>(model, [nodesStep(model, context, model.frame.window, "Refresh")]),
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
		GotInstallMessage: ({ message: inner }) => {
			const next = InstallModal.update(model.install, inner)
			return {
				model: { ...model, install: next.model },
				commands: Command.mapMessages(next.commands ?? [], (m) => Message.GotInstallMessage({ message: m })),
			}
		},
	})
