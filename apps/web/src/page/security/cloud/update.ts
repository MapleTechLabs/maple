import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import { String as Str } from "effect"
import { AppRoute, hrefOf } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { appendedPage, fetchingNext, freshLaterPages } from "../../kit/infinite-pages"
import { chain, slotStep } from "../../kit/keyed-step"
import { FetchFinding, FetchFirstPage, FetchNextPage, FetchOverview, ReadCloudClock } from "./command"
import { detailQueryOf, nextOffsetOf, SEARCH_MAX_LENGTH } from "./derive"
import { type LaterPages, Message, type Model, type Search, type SelectFilter } from "./model"

type Return = PageReturn<Model, Message>

export type SecurityCloudRoute = Extract<
	AppRoute,
	{ readonly _tag: "SecurityCloud" | "SecurityCloudFinding" }
>

const freshPages = (key: string | null, generation: number): LaterPages => ({
	key,
	...freshLaterPages(generation),
})

const readOverview = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	slotStep(
		model,
		model.overview,
		(overview) => ({ overview }),
		requestKey(context.orgId, "cloudSecurity.overview", {}),
		mode,
		(key) => FetchOverview({ key }),
	)

/** The first page under the URL's filters; new filters, or a refresh, start the later pages over. */
const readFirstPage = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return => {
	const key = requestKey(context.orgId, "cloudSecurity.findings", model.search)
	const laterPages =
		model.laterPages.key === key && mode === "Load"
			? model.laterPages
			: freshPages(key, model.laterPages.generation + 1)
	return slotStep(
		{ ...model, laterPages },
		model.firstPage,
		(firstPage) => ({ firstPage }),
		key,
		mode,
		(next) => FetchFirstPage({ key: next, search: model.search }),
	)
}

const readFinding = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return => {
	const query = detailQueryOf(model.findingSearch)
	return query === null
		? { model }
		: slotStep(
				model,
				model.detail,
				(detail) => ({ detail }),
				requestKey(context.orgId, "cloudSecurity.finding", query),
				mode,
				(key) => FetchFinding({ key, query }),
			)
}

/** The overview always, then the shown screen's own read. */
const readScreen = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	chain(readOverview(model, context, mode), (next) =>
		next.screen === "list" ? readFirstPage(next, context, mode) : readFinding(next, context, mode),
	)

const fetchNext = (model: Model): Return => {
	const offset = nextOffsetOf(model)
	const { laterPages } = model
	if (
		offset === null ||
		laterPages.key === null ||
		laterPages.isFetching ||
		!Keyed.canExtend(model.firstPage)
	)
		return { model }
	return {
		model: { ...model, laterPages: fetchingNext(laterPages) },
		commands: [
			FetchNextPage({
				key: laterPages.key,
				generation: laterPages.generation,
				search: model.search,
				offset,
			}),
		],
	}
}

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.SecurityCloud({ search })),
		isReplace: false,
	}),
})

const FILTER_KEY = {
	status: "status",
	severity: "severity",
	source: "source",
	account: "account",
	region: "region",
} as const satisfies Record<SelectFilter, keyof Search>

/** `search` with one filter set, or dropped when the value is empty. */
const withFilter = (search: Search, filter: keyof Search, value: string): Search => {
	const { [filter]: _dropped, ...rest } = search
	return value === "" ? rest : { ...rest, [filter]: value }
}

const routeFields = (route: SecurityCloudRoute) =>
	route._tag === "SecurityCloud"
		? ({ screen: "list", search: route.search } as const)
		: ({ screen: "finding", findingSearch: route.search } as const)

export const init = (route: SecurityCloudRoute, context: PageContext): Return => {
	const model: Model = {
		search: {},
		findingSearch: {},
		nowMs: 0,
		overview: Keyed.idle(),
		firstPage: Keyed.idle(),
		laterPages: freshPages(null, 0),
		detail: Keyed.idle(),
		searchText: route._tag === "SecurityCloud" ? (route.search.q ?? "") : "",
		...routeFields(route),
	}
	return chain({ model, commands: [ReadCloudClock()] }, (next) => readScreen(next, context, "Load"))
}

/** Same instance, other filters or another finding: the URL is the state, so the reads follow it. */
export const routeChanged = (model: Model, route: SecurityCloudRoute, context: PageContext): Return => {
	const hasDraft = model.searchText !== (model.search.q ?? "")
	const next: Model = { ...model, ...routeFields(route) }
	// A draft survives only while the applied search is the same; otherwise the box shows what applies.
	const keepsDraft = hasDraft && next.search.q === model.search.q
	return readScreen(
		{ ...next, searchText: keepsDraft ? model.searchText : (next.search.q ?? "") },
		context,
		"Load",
	)
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedFetchOverview: ({ key, result }) => ({
			model: { ...model, overview: Keyed.accept(model.overview, key, result) },
		}),
		CompletedFetchFirstPage: ({ key, result }) => ({
			model: { ...model, firstPage: Keyed.accept(model.firstPage, key, result) },
		}),
		CompletedFetchNextPage: ({ key, generation, offset, result }) =>
			key !== model.laterPages.key ||
			generation !== model.laterPages.generation ||
			offset !== nextOffsetOf(model) ||
			!model.laterPages.isFetching
				? { model }
				: { model: { ...model, laterPages: appendedPage(model.laterPages, result) } },
		CompletedFetchFinding: ({ key, result }) => ({
			model: { ...model, detail: Keyed.accept(model.detail, key, result) },
		}),
		ClickedRetry: () =>
			chain({ model, commands: [ReadCloudClock()] }, (next) => readScreen(next, context, "Supersede")),
		ClickedLoadMore: () => fetchNext(model),
		// A filter applies what the URL holds; an unsubmitted draft goes back to the applied search.
		ChangedFilter: ({ filter, value }) =>
			navigate(
				{ ...model, searchText: model.search.q ?? "" },
				withFilter(model.search, FILTER_KEY[filter], value),
			),
		ChangedSearchText: ({ value }) => ({ model: { ...model, searchText: value } }),
		SubmittedSearch: () =>
			navigate(
				model,
				withFilter(model.search, "q", Str.slice(0, SEARCH_MAX_LENGTH)(Str.trim(model.searchText))),
			),
		ClearedSearch: () =>
			model.search.q === undefined
				? { model: { ...model, searchText: "" } }
				: navigate({ ...model, searchText: "" }, withFilter(model.search, "q", "")),
		ClickedClearFilters: () => navigate({ ...model, searchText: "" }, {}),
	})
