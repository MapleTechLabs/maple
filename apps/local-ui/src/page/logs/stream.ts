import { Option } from "effect"
import { AsyncData } from "foldkit"
import { canExtend } from "../../data/slot"
import type { PageContext } from "../contract"
import { FetchNextPage } from "./command"
import { nextCursor } from "./fetch"
import { boundsOf } from "./load"
import type { LocalLog, Model } from "./model"
import type { StepReturn } from "./update"
import { reachesEnd } from "./virtualize"

/** Every loaded row, newest first (`logs.data?.pages.flat()`). */
export const rowsOf = (model: Model): ReadonlyArray<LocalLog> =>
	Option.match(AsyncData.getData(model.logs.data), { onNone: () => [], onSome: (data) => data.pages.flat() })

/** The virtualizer's `onChange`: the last rendered row is the last loaded, so fetch the next page. */
export const loadMoreIfAtEnd = (model: Model, context: PageContext): StepReturn => {
	const data = Option.getOrNull(AsyncData.getData(model.logs.data))
	const maybeBounds = boundsOf(model, context)
	if (data === null || !data.hasNextPage || model.isFetchingNextPage || !canExtend(model.logs) || model.logs.key === null) return { model }
	if (Option.isNone(maybeBounds) || !reachesEnd(rowsOf(model).length, model.viewport)) return { model }
	const cursor = nextCursor(data.pages[data.pages.length - 1] ?? [])
	if (cursor === undefined) return { model }
	return {
		model: { ...model, isFetchingNextPage: true },
		commands: [
			FetchNextPage({
				key: model.logs.key,
				generation: model.pageGeneration,
				search: context.location.search,
				...maybeBounds.value,
				apiBase: context.env.apiBase,
				cursorTimestamp: cursor.timestamp,
				cursorServiceName: cursor.serviceName,
				cursorTraceId: cursor.traceId,
				cursorSpanId: cursor.spanId,
				cursorRecordIdentity: cursor.recordIdentity,
				pages: data.pages,
			}),
		],
	}
}

/** `fetchNextPage` landed: the page joins the list if it is still the same query. */
export const appendPage = (model: Model, key: string, page: ReadonlyArray<LocalLog>): Model => {
	if (model.logs.key !== key) return { ...model, isFetchingNextPage: false }
	return Option.match(AsyncData.getData(model.logs.data), {
		onNone: () => ({ ...model, isFetchingNextPage: false }),
		onSome: (current) => ({
			...model,
			isFetchingNextPage: false,
			logs: {
				...model.logs,
				key,
				data: AsyncData.Success({ data: { pages: [...current.pages, page], hasNextPage: nextCursor(page) !== undefined } }),
				isPlaceholder: false,
			},
		}),
	})
}

export { logKey } from "../kit/log-sheet/model"
