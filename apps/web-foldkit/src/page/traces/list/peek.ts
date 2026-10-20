import { Command, type Update } from "foldkit"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import * as Dialog from "../../../ui/dialog"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import * as TraceDetail from "../detail/update"
import type { Message as DetailMessage } from "../detail/message"
import { Message } from "./message"
import type { Model, TraceRow } from "./model"
import { allRows } from "./update"

// The trace peek sheet's wiring: the URL's
// `peek*` params pick the trace; the trace page's Model runs inside the sheet.

type Return = PageReturn<Model, Message>
type Search = Model["search"]
type Cmd = Command.Command<Message, never, Resources>

const PEEK_CLEARED = { peek: undefined, peekRow: undefined, peekT: undefined, peekSpan: undefined }

/** `peekParamsFor` + `deepLinkSpanId`: a row's trace, its time and (per-span lists) its span. */
export const peekSearchFor = (search: Search, row: TraceRow): Search => ({
	...search,
	peek: row.traceId,
	peekT: row.startTime,
	peekRow: row.isRootSpan ? undefined : row.spanId,
	peekSpan: row.isRootSpan ? undefined : row.spanId,
})

/** `resolvePeek`: the row `peekRow` names among the trace's rows, else the trace's first row. */
const peekIndex = (model: Model, rows: ReadonlyArray<TraceRow>): number => {
	const peek = model.search.peek
	if (peek === undefined) return -1
	const exact =
		model.search.peekRow === undefined
			? -1
			: rows.findIndex((row) => row.traceId === peek && row.spanId === model.search.peekRow)
	return exact >= 0 ? exact : rows.findIndex((row) => row.traceId === peek)
}

export const peekPosition = (model: Model): { readonly index: number; readonly count: number } | null => {
	const rows = allRows(model)
	const index = peekIndex(model, rows)
	return index < 0 ? null : { index, count: rows.length }
}

const navigate = (model: Model, search: Search, isReplace = false): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url: hrefOf(AppRoute.Traces({ search })), isReplace }),
})

/** A trace page link that keeps the list's search (`search: (prev) => ({ ...prev, t, spanId })`). */
export const traceHrefFrom = (
	search: Search,
	traceId: string,
	t: string | undefined,
	spanId: string | undefined,
) => {
	const list = hrefOf(AppRoute.Traces({ search: { ...search, ...PEEK_CLEARED } }))
	const page = hrefOf(AppRoute.Trace({ traceId, search: { t, spanId } }))
	const listQuery = list.includes("?") ? list.slice(list.indexOf("?") + 1) : ""
	const [path = page, pageQuery = ""] = page.split("?")
	const query = [listQuery, pageQuery].filter((part) => part !== "").join("&")
	return query === "" ? path : `${path}?${query}`
}

const liftDialog = (
	model: Model,
	step: Update.ReturnWithOutMessage<Dialog.Model, Dialog.Message, Dialog.OutMessage>,
): { readonly model: Model; readonly commands: ReadonlyArray<Cmd> } => ({
	model: { ...model, peekDialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotPeekDialogMessage({ message }),
	),
})

const liftDetail = (
	model: Model,
	step: ReturnType<typeof TraceDetail.update>,
	context: PageContext,
): Return => {
	const commands = Command.mapMessages(step.commands ?? [], (message: DetailMessage) =>
		Message.GotPeekMessage({ message }),
	)
	const next = { ...model, peek: step.model }
	const out = step.outMessage
	if (out === undefined) return { model: next, commands }
	// The page writes its `spanId`/`view` to its own URL; in the sheet the span is `peekSpan` and
	// the view stays local, as `TraceViewTabs` keeps it in the sheet.
	if (out._tag === "RequestedNavigation" && out.url.startsWith(`/traces/${step.model.traceId}`)) {
		const params = new URLSearchParams(out.url.split("?")[1] ?? "")
		const spanId = params.get("spanId") ?? undefined
		if (spanId !== next.search.peekSpan)
			return { ...navigate(next, { ...next.search, peekSpan: spanId }, true), commands }
		const view = params.get("view")
		const local = TraceDetail.routeChanged(
			step.model,
			{
				traceId: step.model.traceId,
				search: {
					...step.model.search,
					view: view === "waterfall" || view === "timeline" || view === "flow" ? view : undefined,
				},
			},
			context,
		)
		const routed = liftDetail(next, local, context)
		return { ...routed, commands: [...commands, ...(routed.commands ?? [])] }
	}
	return { model: next, commands, outMessage: out }
}

/** The same trace at a new time keeps its time-independent reads, as their atoms are keyed alike. */
const carried = (
	step: ReturnType<typeof TraceDetail.init>,
	previous: Model["peek"],
	traceId: string,
): ReturnType<typeof TraceDetail.init> =>
	previous === null || previous.traceId !== traceId
		? step
		: {
				...step,
				model: {
					...step.model,
					logsCount: previous.logsCount,
					replaySessionId: previous.replaySessionId,
				},
			}

/** The search's peek, applied: a new trace starts the page over, a new span re-routes it. */
export const syncPeek = (model: Model, context: PageContext): Return => {
	const traceId = model.search.peek
	if (traceId === undefined) {
		if (model.peek === null && !model.peekDialog.isOpen) return { model }
		const closed = liftDialog({ ...model, peek: null }, Dialog.close(model.peekDialog))
		return closed
	}
	const rows = allRows(model)
	const row = rows[peekIndex(model, rows)]
	const t = row?.startTime ?? model.search.peekT
	const search = { t, spanId: model.search.peekSpan }
	const opened = model.peekDialog.isOpen
		? { model, commands: [] }
		: liftDialog(model, Dialog.open(model.peekDialog))
	const current = opened.model.peek
	const step =
		current === null || current.traceId !== traceId || current.search.t !== t
			? carried(TraceDetail.init({ traceId, search }, context, true), current, traceId)
			: TraceDetail.routeChanged(
					current,
					{ traceId, search: { ...current.search, spanId: search.spanId } },
					context,
				)
	const lifted = liftDetail(opened.model, step, context)
	return { ...lifted, commands: [...opened.commands, ...(lifted.commands ?? [])] }
}

export const peekStep = (model: Model, message: DetailMessage, context: PageContext): Return =>
	model.peek === null
		? { model }
		: liftDetail(model, TraceDetail.update(model.peek, message, context), context)

/** Escape, the backdrop or the close button: the peek params leave the URL, replacing history. */
export const peekDialogStep = (model: Model, message: Dialog.Message): Return => {
	const step = Dialog.update(model.peekDialog, message)
	const lifted = liftDialog(model, step)
	if (step.outMessage?._tag !== "Closed" || model.search.peek === undefined) return lifted
	return {
		...navigate(lifted.model, { ...model.search, ...PEEK_CLEARED }, true),
		commands: lifted.commands,
	}
}

/** ↑/↓ walk the loaded list from the peeked row, replacing history as `closePeek` does. */
export const steppedPeek = (model: Model, delta: 1 | -1): Return => {
	const position = peekPosition(model)
	const next = position === null ? undefined : allRows(model)[position.index + delta]
	return next === undefined ? { model } : navigate(model, peekSearchFor(model.search, next), true)
}

/** The plain click on a row (or Enter on the focused one): peek it. */
export const peekRow = (model: Model, index: number): Return => {
	const row = allRows(model)[index]
	return row === undefined
		? { model }
		: navigate({ ...model, focusedIndex: index }, peekSearchFor(model.search, row))
}

/** "Open trace": the page, with the peek's span selected, keeping the list's search. */
export const openPeekedTrace = (model: Model): Return => {
	const peek = model.peek
	if (peek === null) return { model }
	return {
		model,
		outMessage: PageOutMessage.RequestedNavigation({
			url: traceHrefFrom(model.search, peek.traceId, peek.search.t, model.search.peekSpan),
			isReplace: false,
		}),
	}
}
