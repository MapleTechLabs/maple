import { AsyncData } from "foldkit"
import { emptyWindow } from "../kit/virtualize"
import { sessionData, viewOf } from "./derive"
import type { Model } from "./model"
import { transcriptRows } from "./transcript-rows"
import { waterfallRowsOf } from "./waterfall-rows"

// The waterfall's `useListNavigation` span cursor and the `?span=` landing of the waterfall and
// the transcript: both lists are virtualized, so a scroll is a request their Mount carries out.

export type SpanKey = "Next" | "Previous" | "Open" | "Escape"

/** What a freshly mounted view starts from: no window, no cursor, the landing unspent. */
export const freshLists = {
	waterfallWindow: emptyWindow,
	transcriptWindow: emptyWindow,
	focusedSpanId: null,
	scroll: null,
	landed: false,
} satisfies Pick<Model, "waterfallWindow" | "transcriptWindow" | "focusedSpanId" | "scroll" | "landed">

const scrollTo = (model: Model, index: number, align: "auto" | "center", reveal: boolean): Model["scroll"] => ({
	seq: (model.scroll?.seq ?? 0) + 1,
	index,
	align,
	reveal,
})

/** The span rows of the open waterfall, in order, with their row index. */
const spanRows = (model: Model): ReadonlyArray<Readonly<{ spanId: string; index: number }>> =>
	waterfallRowsOf(model, sessionData(model)).flatMap((row, index) =>
		row.kind === "span" ? [{ spanId: row.span.spanId, index }] : [],
	)

/**
 * A pasted `?span=` (or a span sent across from another view) lands on its row once per mount: the
 * waterfall centres it and puts the cursor there, the transcript centres its block.
 */
export const land = (model: Model): Model => {
	if (model.landed || !AsyncData.hasData(model.firstPage.data)) return model
	const view = viewOf(model.search.view)
	if (view === "trace") {
		const landingId = model.revealedSpanId ?? model.search.span
		if (landingId === undefined) return model
		const target = spanRows(model).find((row) => row.spanId === landingId)
		if (target === undefined) return model
		return { ...model, landed: true, focusedSpanId: landingId, scroll: scrollTo(model, target.index, "center", true) }
	}
	if (view === "transcript") {
		if (model.search.span === undefined) return model
		const index = transcriptRows(model, sessionData(model)).findIndex(
			(row) => "span" in row && row.span.spanId === model.search.span,
		)
		return { ...model, landed: true, scroll: index === -1 ? model.scroll : scrollTo(model, index, "center", false) }
	}
	return model
}

/** j/k and the arrows walk the visible span rows, as `useListNavigation`'s `move` does. */
export const moveCursor = (model: Model, delta: 1 | -1): Model => {
	const rows = spanRows(model)
	if (rows.length === 0) return model
	const current = model.focusedSpanId === null ? -1 : rows.findIndex((row) => row.spanId === model.focusedSpanId)
	const next =
		delta === 1 ? (current < 0 ? 0 : Math.min(current + 1, rows.length - 1)) : current <= 0 ? 0 : current - 1
	const target = rows[next]
	if (target === undefined) return model
	return { ...model, focusedSpanId: target.spanId, scroll: scrollTo(model, target.index, "auto", false) }
}
