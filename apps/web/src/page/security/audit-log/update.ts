import * as Policy from "@maple/domain/policy"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import { Array as Arr, Option, String as Str } from "effect"
import { AsyncData } from "foldkit"
import { isClerkAuthEnabled } from "../../../platform/auth-mode"
import { AppRoute, hrefOf } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { appendedPage, fetchingNext, freshLaterPages } from "../../kit/infinite-pages"
import { chain, slotStep } from "../../kit/keyed-step"
import { acceptGrants } from "../../kit/session-grants"
import { FetchFirstPage, FetchNextPage, ReadAuditLogClock, ReadAuditLogGrants } from "./command"
import { canRead, type LaterPages, Message, type Model, type Search } from "./model"

type Return = PageReturn<Model, Message>

export type SecurityAuditLogRoute = Extract<AppRoute, { readonly _tag: "SecurityAuditLog" }>

const keyOf = (context: PageContext, search: Search) => requestKey(context.orgId, "auditTrail.list", search)

const freshPages = (key: string | null, generation: number): LaterPages => ({
	key,
	...freshLaterPages(generation),
})

/**
 * The first page under the URL's filters, once the viewer is known to hold `audit_log:read`.
 * New filters, or a refresh, start the later pages over.
 */
const readFirstPage = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return => {
	if (!canRead(model)) return { model }
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

/** The cursor after everything loaded so far, or null at the end of the list. */
export const nextCursorOf = (model: Pick<Model, "firstPage" | "laterPages">): string | null =>
	Option.match(Arr.last(model.laterPages.pages), {
		onNone: () =>
			AsyncData.matchData(model.firstPage.data, {
				onEmpty: () => null,
				onFailure: () => null,
				onData: (page) => page.nextCursor,
			}),
		onSome: (page) => page.nextCursor,
	})

const fetchNext = (model: Model): Return => {
	const cursor = nextCursorOf(model)
	const { laterPages } = model
	if (cursor === null || laterPages.key === null || laterPages.isFetching) return { model }
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

export const init = (route: SecurityAuditLogRoute, context: PageContext): Return => {
	const model: Model = {
		search: route.search,
		nowMs: 0,
		grants: isClerkAuthEnabled ? [] : Policy.allPermissions,
		isGrantsRead: !isClerkAuthEnabled,
		firstPage: Keyed.idle(),
		laterPages: freshPages(null, 0),
		expanded: [],
		actorText: route.search.actor ?? "",
	}
	const entered: Return = {
		model,
		commands: [
			ReadAuditLogClock(),
			...(isClerkAuthEnabled ? [ReadAuditLogGrants({ orgId: context.orgId })] : []),
		],
	}
	return chain(entered, (next) => readFirstPage(next, context, "Load"))
}

/** Same instance, other filters: the URL is the filter state, so the list follows it. */
export const routeChanged = (model: Model, route: SecurityAuditLogRoute, context: PageContext): Return =>
	readFirstPage(
		{ ...model, search: route.search, actorText: route.search.actor ?? "", expanded: [] },
		context,
		"Load",
	)

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
		CompletedFetchNextPage: ({ key, generation, result }) =>
			key !== model.laterPages.key ||
			generation !== model.laterPages.generation ||
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
