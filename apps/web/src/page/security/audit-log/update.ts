import * as Policy from "@maple/domain/policy"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import { Array as Arr, String as Str } from "effect"
import { isClerkAuthEnabled } from "../../../platform/auth-mode"
import { AppRoute, hrefOf } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { appendedPage, fetchingNext, freshLaterPages } from "../../kit/infinite-pages"
import { chain, slotStep } from "../../kit/keyed-step"
import { acceptGrants } from "../../kit/session-grants"
import { FetchFirstPage, FetchNextPage, ReadAuditLogClock, ReadAuditLogGrants } from "./command"
import { nextCursorOf } from "./derive"
import { accessOf, type LaterPages, Message, type Model, type Search } from "./model"

type Return = PageReturn<Model, Message>

export type SecurityAuditLogRoute = Extract<AppRoute, { readonly _tag: "SecurityAuditLog" }>

const keyOf = (context: PageContext, search: Search) => requestKey(context.orgId, "auditTrail.list", search)

const freshPages = (key: string | null, generation: number): LaterPages => ({
	key,
	...freshLaterPages(generation),
})

/**
 * The first page under the URL's filters, unless the session said the viewer may not read it.
 * New filters, or a refresh, start the later pages over.
 */
const readFirstPage = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return => {
	if (accessOf(model) !== "ask") return { model }
	const key = keyOf(context, model.search)
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

const fetchNext = (model: Model): Return => {
	const cursor = nextCursorOf(model)
	const { laterPages } = model
	// While another first page is on its way the cursor belongs to rows about to be replaced.
	if (
		cursor === null ||
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
				cursor,
			}),
		],
	}
}

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.SecurityAuditLog({ search })),
		isReplace: false,
	}),
})

/** `search` with one filter set, or dropped when the value is empty. */
const withFilter = (search: Search, filter: keyof Search, value: string): Search => {
	const { [filter]: _dropped, ...rest } = search
	return value === "" ? rest : { ...rest, [filter]: value }
}

/**
 * Entering the page. `sessionDecides`: the hosted product, where the session says what the viewer
 * may read and nothing is asked before it answers. Self-hosted has one role and reads at once.
 */
export const enter = (
	route: SecurityAuditLogRoute,
	context: PageContext,
	sessionDecides: boolean,
): Return => {
	const model: Model = {
		search: route.search,
		nowMs: 0,
		grants: sessionDecides ? [] : Policy.allPermissions,
		isGrantsRead: !sessionDecides,
		firstPage: Keyed.idle(),
		laterPages: freshPages(null, 0),
		expanded: [],
		actorText: route.search.actor ?? "",
	}
	const entered: Return = {
		model,
		commands: [
			ReadAuditLogClock(),
			...(sessionDecides ? [ReadAuditLogGrants({ orgId: context.orgId })] : []),
		],
	}
	return chain(entered, (next) => readFirstPage(next, context, "Load"))
}

export const init = (route: SecurityAuditLogRoute, context: PageContext): Return =>
	enter(route, context, isClerkAuthEnabled)

/**
 * Same instance, other filters: the URL is the filter state, so the list follows it. The actor
 * field follows it too, unless it holds text that was typed and not yet applied.
 */
export const routeChanged = (model: Model, route: SecurityAuditLogRoute, context: PageContext): Return => {
	const hasDraft = model.actorText !== (model.search.actor ?? "")
	return readFirstPage(
		{
			...model,
			search: route.search,
			actorText: hasDraft ? model.actorText : (route.search.actor ?? ""),
			expanded: [],
		},
		context,
		"Load",
	)
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedReadGrants: (answer) =>
			readFirstPage(
				acceptGrants(model, context.orgId, answer, { isGrantsRead: true }),
				context,
				"Load",
			),
		CompletedFetchFirstPage: ({ key, result }) => ({
			model: { ...model, firstPage: Keyed.accept(model.firstPage, key, result) },
		}),
		CompletedFetchNextPage: ({ key, generation, cursor, result }) =>
			key !== model.laterPages.key ||
			generation !== model.laterPages.generation ||
			cursor !== nextCursorOf(model) ||
			!model.laterPages.isFetching
				? { model }
				: { model: { ...model, laterPages: appendedPage(model.laterPages, result) } },
		ClickedRetry: () =>
			chain({ model, commands: [ReadAuditLogClock()] }, (next) =>
				readFirstPage(next, context, "Refresh"),
			),
		ClickedLoadMore: () => fetchNext(model),
		ChangedFilter: ({ filter, value }) => navigate(model, withFilter(model.search, filter, value)),
		ChangedActorText: ({ value }) => ({ model: { ...model, actorText: value } }),
		SubmittedActor: () => navigate(model, withFilter(model.search, "actor", Str.trim(model.actorText))),
		ClearedActor: () =>
			model.search.actor === undefined
				? { model: { ...model, actorText: "" } }
				: navigate({ ...model, actorText: "" }, withFilter(model.search, "actor", "")),
		ClickedClearFilters: () => navigate({ ...model, actorText: "" }, {}),
		ToggledEvent: ({ id }) => ({
			model: {
				...model,
				expanded: Arr.contains(model.expanded, id)
					? Arr.filter(model.expanded, (open) => open !== id)
					: [...model.expanded, id],
			},
		}),
	})
