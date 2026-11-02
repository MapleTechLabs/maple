import { addLogAttributeFilter } from "@maple/views/lib/log-attribute-filters"
import * as LogsStream from "@maple/views/ui/logs/logs-stream"
import type { ColumnOption } from "@maple/views/ui/logs/logs-stream-toolbar"
import { Option } from "effect"
import { AsyncData, Command } from "foldkit"
import { canExtend } from "../../data/slot"
import { queryOf } from "../../route"
import { type PageContext, replaceParams } from "../contract"
import * as LogSheet from "../kit/log-sheet/update"
import { FetchNextPage } from "./command"
import { nextCursor } from "./fetch"
import { columnsOf, filtersOf } from "./filters"
import { boundsOf } from "./load"
import { toStreamRows } from "./log-record"
import { Message } from "./message"
import type { LocalLog, Model } from "./model"
import type { UpdateReturn } from "./update"

// The shared logs stream inside the page: rows in from the fetched pages, its intents out.

/** Every loaded row, newest first (`logs.data?.pages.flat()`). */
export const rowsOf = (model: Model): ReadonlyArray<LocalLog> =>
	Option.match(AsyncData.getData(model.logs.data), { onNone: () => [], onSome: (data) => data.pages.flat() })

const toStream = (message: LogsStream.Message) => Message.GotStreamMessage({ message })

/**
 * Hands the stream new rows when the loaded pages or the pinned columns changed. A next page or a
 * pin keeps the rows' expansion (`setRows`); any other new data starts over (`replaceRows`).
 */
export const syncStream = (before: Model, step: UpdateReturn, context: PageContext): UpdateReturn => {
	const after = step.model
	const columns = columnsOf(queryOf(context.location))
	const dataOf = (model: Model) => Option.getOrNull(AsyncData.getData(model.logs.data))
	const isNewData = dataOf(before) !== dataOf(after)
	if (!isNewData && sameColumns(after.columns, columns)) return step
	const rows = toStreamRows(rowsOf(after), columns, context.timeFormat.timeZone)
	const isAppend = isNewData && isNextPage(dataOf(before), dataOf(after))
	const result = isNewData && !isAppend ? LogsStream.replaceRows(after.stream, rows) : LogsStream.setRows(after.stream, rows)
	const columnOptions = isNewData ? columnOptionsOf(rowsOf(after)) : after.columnOptions
	return {
		...step,
		model: { ...after, stream: result.model, columns, columnOptions },
		commands: [...(step.commands ?? []), ...Command.mapMessages(result.commands ?? [], toStream)],
	}
}

/** What the Columns picker offers: every attribute key in the loaded logs, the most common first. */
const columnOptionsOf = (logs: ReadonlyArray<LocalLog>): ReadonlyArray<ColumnOption> => {
	const counts = new Map<string, number>()
	logs.forEach((log) =>
		new Set([...Object.keys(log.logAttributes), ...Object.keys(log.resourceAttributes)]).forEach((key) =>
			counts.set(key, (counts.get(key) ?? 0) + 1),
		),
	)
	return [...counts]
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

const sameColumns = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
	a.length === b.length && a.every((key, index) => key === b[index])

type Pages = Readonly<{ pages: ReadonlyArray<ReadonlyArray<LocalLog>> }>

/** The same pages with more after them: a next page landed. */
const isNextPage = (before: Pages | null, after: Pages | null): boolean =>
	before !== null &&
	after !== null &&
	after.pages.length > before.pages.length &&
	before.pages.every((page, index) => after.pages[index] === page)

/** The stream rendered the last loaded row, so the next page is wanted. */
export const loadMoreIfAtEnd = (model: Model, context: PageContext): UpdateReturn => {
	const data = Option.getOrNull(AsyncData.getData(model.logs.data))
	const maybeBounds = boundsOf(model, context)
	const lastRendered = model.stream.window.at(-1)?.index ?? -1
	if (data === null || !data.hasNextPage || model.isFetchingNextPage || !canExtend(model.logs) || model.logs.key === null) return { model }
	if (Option.isNone(maybeBounds) || lastRendered < rowsOf(model).length - 1) return { model }
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

/** Folds a sheet step into the page. */
export const liftSheet = (model: Model, step: LogSheet.UpdateReturn): UpdateReturn => ({
	model: { ...model, maybeDetail: Option.some(step.model) },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotLogSheetMessage({ message })),
})

const foldStreamOut = (model: Model, out: LogsStream.OutMessage, context: PageContext): UpdateReturn =>
	LogsStream.OutMessage.match<UpdateReturn>(out, {
		OpenedLog: ({ index }) =>
			Option.match(Option.fromNullishOr(rowsOf(model)[index]), {
				onNone: () => ({ model }),
				onSome: (log) => liftSheet(model, LogSheet.openLog(model.maybeDetail, log)),
			}),
		// Local has no auto-refresh to hold while the reader inspects.
		ChangedInspecting: () => ({ model }),
		ChoseAttributeFilter: (filter) => ({
			model,
			outMessage: replaceParams(context.location, {
				attrs: addLogAttributeFilter([...filtersOf(queryOf(context.location)).attrs], filter),
			}),
		}),
	})

export const foldStream = (model: Model, message: LogsStream.Message, context: PageContext): UpdateReturn => {
	const result = LogsStream.update(model.stream, message)
	const streamed = { ...model, stream: result.model }
	const out = result.outMessage === undefined ? { model: streamed } : foldStreamOut(streamed, result.outMessage, context)
	const more = message._tag === "ChangedVirtualWindow" ? loadMoreIfAtEnd(out.model, context) : { model: out.model }
	return {
		model: more.model,
		commands: [...Command.mapMessages(result.commands ?? [], toStream), ...(out.commands ?? []), ...(more.commands ?? [])],
		outMessage: out.outMessage,
	}
}
