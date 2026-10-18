import * as AttributesPanel from "@maple/web-foldkit/ui/attributes/attributes-panel"
import * as Tabs from "@maple/web-foldkit/ui/tabs"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { PageContext } from "../contract"
import { FetchNextPage } from "./command"
import { nextCursor } from "./fetch"
import { boundsOf } from "./load"
import type { Detail, LocalLog, Model } from "./model"
import type { UpdateReturn } from "./update"
import { reachesEnd } from "./virtualize"

/** Every loaded row, newest first (`logs.data?.pages.flat()`). */
export const rowsOf = (model: Model): ReadonlyArray<LocalLog> =>
	Option.match(AsyncData.getData(model.logs.data), { onNone: () => [], onSome: (data) => data.pages.flat() })

/** The virtualizer's `onChange`: the last rendered row is the last loaded, so fetch the next page. */
export const loadMoreIfAtEnd = (model: Model, context: PageContext): UpdateReturn => {
	const data = Option.getOrNull(AsyncData.getData(model.logs.data))
	const maybeBounds = boundsOf(model, context)
	if (data === null || !data.hasNextPage || model.isFetchingNextPage || model.logs.key === null) return { model }
	if (Option.isNone(maybeBounds) || !reachesEnd(rowsOf(model).length, model.viewport)) return { model }
	const cursor = nextCursor(data.pages[data.pages.length - 1] ?? [])
	if (cursor === undefined) return { model }
	return {
		model: { ...model, isFetchingNextPage: true },
		commands: [
			FetchNextPage({
				key: model.logs.key,
				search: context.location.search,
				...maybeBounds.value,
				apiBase: context.env.apiBase,
				cursorTimestamp: cursor.timestamp,
				cursorServiceName: cursor.serviceName,
				cursorTraceId: cursor.traceId,
				cursorSpanId: cursor.spanId,
				cursorRecordIdentity: cursor.recordIdentity,
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
				key,
				data: AsyncData.Success({ data: { pages: [...current.pages, page], hasNextPage: nextCursor(page) !== undefined } }),
				isPlaceholder: false,
			},
		}),
	})
}

export const logKey = (log: LocalLog): string =>
	`${log.timestamp}|${log.serviceName}|${log.traceId}|${log.spanId}|${log.recordIdentity}`

/** The sheet's tabs: Trace only when the log carries a trace id. */
export const detailTabValues = (log: LocalLog): ReadonlyArray<string> =>
	log.traceId ? ["attributes", "trace", "raw"] : ["attributes", "raw"]

/**
 * `openLog`: the clicked log in the sheet. The sheet stays mounted once a log was picked, so its
 * tab and body expansion carry over; the attributes panel is keyed by log and starts over.
 */
export const openDetail = (maybeDetail: Option.Option<Detail>, log: LocalLog): Detail =>
	Option.match(maybeDetail, {
		onNone: () => ({
			log,
			isOpen: true,
			isBodyExpanded: false,
			tabs: Tabs.init({ idBase: 900, values: detailTabValues(log), selected: "attributes" }),
			attributes: AttributesPanel.init("log-detail-attributes"),
		}),
		onSome: (detail) => ({
			...detail,
			log,
			isOpen: true,
			tabs: { ...detail.tabs, values: detailTabValues(log) },
			attributes:
				logKey(detail.log) === logKey(log) ? detail.attributes : AttributesPanel.init("log-detail-attributes"),
		}),
	})
