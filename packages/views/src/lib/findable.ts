import { Array as Arr, Option, Order, Schema } from "effect"
import { createKeyedLazy, type Html, type HtmlBuilder } from "foldkit/html"
import type { Instance } from "./virtualizer"

// Find in page (Cmd+F) for a virtualized list, after ui-sdk.dev's `findable`: rows outside the
// window get `hidden="until-found"` stand-ins before and after it, in list order. On `beforematch`
// the stand-in moves to its row's offset, so the browser's own scroll brings the row on screen.

export const FindableSide = Schema.Literals(["before", "after"])
export type FindableSide = typeof FindableSide.Type

/** The row the browser matched, and the layer its stand-in is in. */
export const FindableMatch = Schema.Struct({ index: Schema.Number, side: FindableSide })
export type FindableMatch = typeof FindableMatch.Type

/** The found row; `isRendered` once a window held it, so the next window without it ends the find. */
export const Found = Schema.Struct({ ...FindableMatch.fields, isRendered: Schema.Boolean })
export type Found = typeof Found.Type

export const foundOf = (match: FindableMatch): Found => ({ ...match, isRendered: false })

/** The found row after a new window: kept until its row has rendered and then left the window. */
export const foundAfterWindow = (
	found: Option.Option<Found>,
	rendered: ReadonlyArray<number>,
): Option.Option<Found> =>
	Option.flatMap(found, (row) => {
		const isRendered = rendered.includes(row.index)
		if (isRendered === row.isRendered) return found
		return isRendered ? Option.some({ ...row, isRendered }) : Option.none()
	})

const INDEX_ATTRIBUTE = "findable-index"
const SIDE_ATTRIBUTE = "findable-side"
/** Stand-ins are grouped so the browser skips style and layout for a group until it matches. */
const CHUNK = 64

// Zero-size and invisible: the stand-in only has to be found, its row shows the text.
const LAYER_STYLE = {
	position: "absolute",
	top: "0px",
	left: "0px",
	width: "100%",
	height: "0px",
	overflow: "clip",
	opacity: "0",
	"pointer-events": "none",
	contain: "strict",
} as const
const STAND_IN_STYLE = { position: "absolute", left: "0px", width: "100%" } as const

export interface FindableLayers<A> {
	readonly items: ReadonlyArray<A>
	/** The row's searchable text: what it shows, not timestamps. Module-level, so groups memoize. */
	readonly textOf: (item: A, variant: string) => ReadonlyArray<string>
	/** Anything `textOf` reads besides the item (wrap mode, columns); a change rebuilds the groups. */
	readonly variant: string
	/** The rendered rows' indices: their own text is what the browser finds. */
	readonly rendered: ReadonlyArray<number>
	readonly found: Option.Option<Found>
}

// Keyed by side and chunk: bounded by the row count / CHUNK.
const lazyGroup = createKeyedLazy()

const standIn = <A, Message>(
	h: HtmlBuilder<Message>,
	index: number,
	isFound: boolean,
	item: A,
	textOf: (item: A, variant: string) => ReadonlyArray<string>,
	variant: string,
): Html =>
	h.keyed("div")(
		String(index),
		[
			h.DataAttribute(INDEX_ATTRIBUTE, String(index)),
			h.Style(STAND_IN_STYLE),
			...(isFound ? [] : [h.Attribute("hidden", "until-found")]),
		],
		// One text node per row: a stand-in costs two DOM nodes.
		[Arr.join(textOf(item, variant), " ")],
	)

const group = <A, Message>(
	h: HtmlBuilder<Message>,
	side: FindableSide,
	chunk: number,
	from: number,
	to: number,
	found: number,
	items: ReadonlyArray<A>,
	textOf: (item: A, variant: string) => ReadonlyArray<string>,
	variant: string,
): Html =>
	h.keyed("div")(
		`${side}-${chunk}`,
		found >= 0 ? [] : [h.Attribute("hidden", "until-found")],
		Arr.flatMap(Arr.range(chunk * CHUNK, chunk * CHUNK + CHUNK - 1), (index) => {
			const item = items[index]
			if (item === undefined || ((index < from || index > to) && index !== found)) return []
			return [standIn(h, index, index === found, item, textOf, variant)]
		}),
	)

const layer = <A, Message>(
	h: HtmlBuilder<Message>,
	side: FindableSide,
	from: number,
	to: number,
	input: FindableLayers<A>,
): Html => {
	const found = Option.match(input.found, {
		onNone: () => -1,
		onSome: (match) => (match.side === side ? match.index : -1),
	})
	const rangeChunks = from <= to ? Arr.range(Math.floor(from / CHUNK), Math.floor(to / CHUNK)) : []
	const chunks = Arr.sort(
		Arr.dedupe(found < 0 ? rangeChunks : [...rangeChunks, Math.floor(found / CHUNK)]),
		Order.Number,
	)
	return h.keyed("div")(
		side,
		[h.DataAttribute(SIDE_ATTRIBUTE, side), h.Style(LAYER_STYLE)],
		Arr.flatMap(chunks, (chunk) => {
			const first = chunk * CHUNK
			const last = first + CHUNK - 1
			// Only the part of the range inside this chunk is a lazy argument, so moving the window
			// rebuilds the one or two chunks at its edges.
			const clippedFrom = Math.max(from, first)
			const clippedTo = Math.min(to, last)
			const foundHere = found >= first && found <= last ? found : -1
			const vnode = lazyGroup(`${side}-${chunk}`, group, [
				h,
				side,
				chunk,
				clippedFrom,
				clippedTo,
				foundHere,
				input.items,
				input.textOf,
				input.variant,
			])
			return vnode === null ? [] : [vnode]
		}),
	)
}

/**
 * The two stand-in layers, placed in the list container (positioned, as tall as the list): the
 * `before` layer ahead of the rendered rows, the `after` layer behind them.
 */
export const findableLayers = <A, Message>(
	h: HtmlBuilder<Message>,
	input: FindableLayers<A>,
): Readonly<{ before: Html; after: Html }> => {
	const first = Arr.match(input.rendered, {
		onEmpty: () => input.items.length,
		onNonEmpty: (r) => Math.min(...r),
	})
	const last = Arr.match(input.rendered, {
		onEmpty: () => input.items.length - 1,
		onNonEmpty: (r) => Math.max(...r),
	})
	return {
		before: layer(h, "before", 0, first - 1, input),
		after: layer(h, "after", last + 1, input.items.length - 1, input),
	}
}

/**
 * Listens for the browser's `beforematch` under `scroller`: the matched stand-in moves to its row's
 * offset (in the list container's coordinates, `start - scrollMargin`), and the match is reported.
 */
export const bindFindable = (
	scroller: HTMLElement,
	virtualizer: Instance,
	onMatch: (match: FindableMatch) => void,
): (() => void) => {
	const onBeforeMatch = (event: Event) => {
		const target = event.target
		if (!(target instanceof HTMLElement)) return
		const index = Number(target.dataset.findableIndex)
		if (target.dataset.findableIndex === undefined || !Number.isInteger(index)) return
		const side = target.closest<HTMLElement>(`[data-${SIDE_ATTRIBUTE}]`)?.dataset.findableSide
		if (side !== "before" && side !== "after") return
		// A row the virtualizer has not counted yet has no offset to scroll to.
		const item = virtualizer.measurementsCache[index]
		if (item === undefined) return
		target.style.top = `${item.start - virtualizer.options.scrollMargin}px`
		target.style.height = `${item.size}px`
		onMatch({ index, side })
	}
	scroller.addEventListener("beforematch", onBeforeMatch)
	return () => scroller.removeEventListener("beforematch", onBeforeMatch)
}
