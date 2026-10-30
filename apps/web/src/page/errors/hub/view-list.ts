import type { ErrorSignal } from "../../../lib/models/error-signal"
import { Option } from "effect"
import { createKeyedLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { toLoadFailure } from "../../../data/load-failure"
import { errorState } from "../../../ui/error-state"
import { skeletonList } from "../../../ui/skeleton"
import { MountRowSelect } from "./command"
import { listFailureOf, type ListStatus, type PagingState, pagingOf } from "./derive"
import { bulkBar } from "./view-bulk"
import { hubEmpty } from "./view-empty"
import { Message } from "./message"
import type { Model } from "./model"
import { type HeaderSelection, type RowState, signalHeader, signalRow, signalRowSkeleton } from "./view-row"

// `ErrorsHubView`'s body: skeleton rows, the retry card, the rows, the empty states and paging.

type H = HtmlBuilder<Message>

/** The fallback when a failed list carries no error of its own. */
const LIST_FAILURE = toLoadFailure("The errors list couldn't be loaded.")

const SKELETON_ROWS = 8
const LOAD_MORE_SKELETON_ROWS = 3

const loadingBody = (h: H): ReadonlyArray<Html> => [
	signalHeader(h, null),
	skeletonList(h, {
		rows: SKELETON_ROWS,
		renderRow: (index) => signalRowSkeleton(h, index),
		className: "gap-0 divide-y divide-border/60",
	}),
]

/** One compact dashed panel at the top of the list area, as on Services and Traces. */
const failedBody = (h: H, model: Model): ReadonlyArray<Html> => [
	errorState(h, {
		failure: Option.getOrElse(listFailureOf(model), () => LIST_FAILURE),
		title: "Couldn't load errors",
		onRetry: Message.ClickedRetry(),
		className: "mt-4",
	}),
]

/** The bottom of a page that is not the bottom of the list. */
const pagingFooter = (h: H, paging: PagingState): ReadonlyArray<Html> => {
	if (paging === "end") return []
	if (paging === "loading") {
		return [
			skeletonList(h, {
				rows: LOAD_MORE_SKELETON_ROWS,
				renderRow: (index) => signalRowSkeleton(h, index),
				className: "gap-0 divide-y divide-border/60 border-t border-border/60",
			}),
		]
	}
	return [
		h.div(
			[h.Class("flex items-center justify-center gap-3 border-t border-border/60 p-4")],
			[
				...(paging === "failed"
					? [h.span([h.Class("text-xs text-muted-foreground")], ["Couldn't load more errors."])]
					: []),
				loadMoreButton(h, paging === "failed" ? "Retry" : "Load more"),
			],
		),
	]
}

/** `LoadMoreButton`: an outline sm Button. */
const loadMoreButton = (h: H, label: string): Html =>
	button(h, { variant: "outline", size: "sm", attributes: [h.OnClick(Message.ClickedLoadMore())] }, [label])

export type ListInputs = Readonly<{
	status: ListStatus
	signals: ReadonlyArray<ErrorSignal>
	rowState: (signal: ErrorSignal) => RowState
	isNarrowed: boolean
}>

const rowView = (
	h: H,
	signal: ErrorSignal,
	isSelected: RowState["isSelected"],
	isSelecting: RowState["isSelecting"],
	isFocused: RowState["isFocused"],
	timeZone: RowState["timeZone"],
	nowMs: RowState["nowMs"],
	sparkWindow: RowState["sparkWindow"],
	picker: RowState["picker"],
	rowMenu: RowState["rowMenu"],
): Html =>
	signalRow(h, signal, {
		isSelected,
		isSelecting,
		isFocused,
		timeZone,
		nowMs,
		sparkWindow,
		picker,
		rowMenu,
	})

// One slot per list position, `index % 256` so the cache stays bounded: hovering a row (which moves
// `focusedId`) rebuilds the two rows whose state changed, not the whole list.
const lazyRow = createKeyedLazy()
const ROW_SLOTS = 256

const memoRow = (h: H, signal: ErrorSignal, index: number, state: RowState): Html =>
	lazyRow(index % ROW_SLOTS, rowView, [
		h,
		signal,
		state.isSelected,
		state.isSelecting,
		state.isFocused,
		state.timeZone,
		state.nowMs,
		state.sparkWindow,
		state.picker,
		state.rowMenu,
	])

/** The rows, or the empty state, under the column header. */
const readyBody = (h: H, model: Model, inputs: ListInputs): ReadonlyArray<Html> => {
	const { signals } = inputs
	if (signals.length === 0) {
		return [
			h.div([h.Key("empty"), h.Class("contents")], [hubEmpty(h, model, inputs.isNarrowed)]),
			...bulkBar(h, model),
		]
	}
	const ids = signals.map((signal) => signal.id)
	const selection: HeaderSelection =
		model.selectedIds.length === 0
			? "none"
			: ids.every((id) => model.selectedIds.includes(id))
				? "all"
				: "some"
	return [
		h.div(
			[h.Key("rows")],
			[
				signalHeader(h, selection),
				h.div(
					[h.Role("list"), h.Class("divide-y divide-border/60"), h.OnMount(MountRowSelect())],
					signals.map((signal, index) =>
						h.div(
							[h.Key(signal.id), h.Role("listitem")],
							[memoRow(h, signal, index, inputs.rowState(signal))],
						),
					),
				),
				...pagingFooter(h, pagingOf(model)),
			],
		),
		...bulkBar(h, model),
	]
}

export const listBody = (h: H, model: Model, inputs: ListInputs): ReadonlyArray<Html> =>
	inputs.status === "loading"
		? loadingBody(h)
		: inputs.status === "failed"
			? failedBody(h, model)
			: readyBody(h, model, inputs)
