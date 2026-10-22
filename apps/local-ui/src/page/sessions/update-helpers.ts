import type { Resources } from "../../platform/resources"
import { Option } from "effect"
import { AsyncData, type Update } from "foldkit"
import { type PageContext, PageOutMessage, replaceParams, withParams } from "../contract"
import { FetchNextPage } from "./command"
import { nextCursor } from "./fetch"
import { canExtend } from "../../data/slot"
import { boundsOf } from "./load"
import type { Message } from "./message"
import type { Model, SessionRow } from "./model"

export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, PageOutMessage, Resources>

export const navigate = (
	model: Model,
	context: PageContext,
	updates: Record<string, string | null>,
): UpdateReturn => ({
	model,
	outMessage: replaceParams(context.location, updates),
})

/** `setRange`: remember it for pages opened without one, then put it in the hash. */
export const setRange = (model: Model, context: PageContext, range: string): UpdateReturn => ({
	model,
	outMessage: PageOutMessage.RememberedRange({ range, hash: withParams(context.location, { range }) }),
})

/** The refresh spinner stops once nothing the refresh started is still loading. */
export const settleRefresh = (model: Model): Model => {
	const isLoading = (data: AsyncData.AsyncData<unknown, unknown>) =>
		AsyncData.isLoading(data) || AsyncData.isRefreshing(data)
	return model.isRefreshing && !isLoading(model.sessions.data) && !isLoading(model.facets.data)
		? { ...model, isRefreshing: false }
		: model
}

/** `fetchNextPage`: the cursor after the last loaded page. */
export const loadMore = (model: Model, context: PageContext): UpdateReturn => {
	const maybeNext = Option.flatMap(AsyncData.getData(model.sessions.data), (data) =>
		Option.fromNullishOr(
			data.hasNextPage ? nextCursor(data.pages[data.pages.length - 1] ?? []) : undefined,
		),
	)
	const maybeBounds = boundsOf(model, context)
	if (
		model.isFetchingNextPage ||
		!canExtend(model.sessions) ||
		model.sessions.key === null ||
		Option.isNone(maybeNext) ||
		Option.isNone(maybeBounds)
	)
		return { model }
	return {
		model: { ...model, isFetchingNextPage: true },
		commands: [
			FetchNextPage({
				key: model.sessions.key,
				generation: model.pageGeneration,
				search: context.location.search,
				...maybeBounds.value,
				apiBase: context.env.apiBase,
				cursorStartTime: maybeNext.value.startTime,
				cursorSessionId: maybeNext.value.sessionId,
				pages: Option.match(AsyncData.getData(model.sessions.data), {
					onNone: () => [],
					onSome: (data) => data.pages,
				}),
			}),
		],
	}
}

/** `fetchNextPage` landed: the page joins the list if it is still the same query. */
export const appendPage = (model: Model, key: string, page: ReadonlyArray<SessionRow>): Model => {
	if (model.sessions.key !== key) return model
	return Option.match(AsyncData.getData(model.sessions.data), {
		onNone: () => ({ ...model, isFetchingNextPage: false }),
		onSome: (current) => ({
			...model,
			isFetchingNextPage: false,
			sessions: {
				...model.sessions,
				key,
				data: AsyncData.Success({
					data: { pages: [...current.pages, page], hasNextPage: nextCursor(page) !== undefined },
				}),
				isPlaceholder: false,
			},
		}),
	})
}
