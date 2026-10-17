import { Schema } from "effect"

/**
 * Base UI's anchor positioning (`internals/useAnchorPositioning.mjs` over Floating UI) for the
 * cases the kit uses: offset, flip, shift with `limitShift`, size and the `transformOrigin`
 * middleware, absolute strategy, collision padding 5, no arrow, left-to-right.
 */

export const Side = Schema.Literals(["top", "right", "bottom", "left"])
export type Side = typeof Side.Type

export const Align = Schema.Literals(["start", "center", "end"])
export type Align = typeof Align.Type

export const Rect = Schema.Struct({
	x: Schema.Number,
	y: Schema.Number,
	width: Schema.Number,
	height: Schema.Number,
})
export type Rect = typeof Rect.Type

/** Everything Base UI writes on the positioner: placement, translate and the CSS variables. */
export const PopupPosition = Schema.Struct({
	side: Side,
	align: Align,
	x: Schema.Number,
	y: Schema.Number,
	availableWidth: Schema.Number,
	availableHeight: Schema.Number,
	anchorWidth: Schema.Number,
	anchorHeight: Schema.Number,
	transformOrigin: Schema.String,
	/** The trigger's box, cut out of the modal backdrop so it keeps its hover state. */
	anchor: Rect,
})
export type PopupPosition = typeof PopupPosition.Type

export type Placement = Readonly<{ side: Side; align: Align; sideOffset: number; alignOffset: number }>

export type PositionInput = Placement &
	Readonly<{
		anchor: Rect
		popup: Readonly<{ width: number; height: number }>
		viewport: Readonly<{ width: number; height: number }>
		dpr: number
	}>

const PADDING = 5

const isVertical = (side: Side) => side === "top" || side === "bottom"

const opposite = (side: Side): Side =>
	side === "top" ? "bottom" : side === "bottom" ? "top" : side === "left" ? "right" : "left"

const clamp = (min: number, value: number, max: number) => Math.max(min, Math.min(value, max))

/** `computeCoordsFromPlacement` plus the offset middleware. */
const coordsFor = (input: PositionInput, side: Side, align: Align) => {
	const { anchor, popup } = input
	const crossStart = isVertical(side) ? anchor.x : anchor.y
	const crossLength = isVertical(side) ? anchor.width : anchor.height
	const popupCross = isVertical(side) ? popup.width : popup.height
	const alignOffset = align === "end" ? -input.alignOffset : input.alignOffset
	const cross =
		(align === "start"
			? crossStart
			: align === "end"
				? crossStart + crossLength - popupCross
				: crossStart + crossLength / 2 - popupCross / 2) + alignOffset
	const main =
		side === "top"
			? anchor.y - popup.height - input.sideOffset
			: side === "bottom"
				? anchor.y + anchor.height + input.sideOffset
				: side === "left"
					? anchor.x - popup.width - input.sideOffset
					: anchor.x + anchor.width + input.sideOffset
	return isVertical(side) ? { x: cross, y: main } : { x: main, y: cross }
}
// POSITION

/** How far the popup crosses the viewport edge `edge`, with that edge's padding. */
const overflow = (input: PositionInput, at: { x: number; y: number }, edge: Side, padding: number) =>
	edge === "top"
		? padding - at.y
		: edge === "bottom"
			? at.y + input.popup.height - (input.viewport.height - padding)
			: edge === "left"
				? padding - at.x
				: at.x + input.popup.width - (input.viewport.width - padding)

/** Flip's padding: collision padding + 1, + 1 more on the edge opposite the requested side. */
const flipPadding = (input: PositionInput, edge: Side) =>
	PADDING + 1 + (edge === opposite(input.side) ? 1 : 0)

const alignEdge = (side: Side, align: Align): Side | undefined =>
	align === "center"
		? undefined
		: isVertical(side)
			? align === "start"
				? "right"
				: "left"
			: align === "start"
				? "bottom"
				: "top"

const flipped = (input: PositionInput): { side: Side; align: Align } => {
	const at = coordsFor(input, input.side, input.align)
	const mainOverflow = overflow(input, at, input.side, flipPadding(input, input.side))
	const otherSide = opposite(input.side)
	const side =
		mainOverflow > 0 &&
		overflow(input, coordsFor(input, otherSide, input.align), otherSide, flipPadding(input, otherSide)) <
			mainOverflow
			? otherSide
			: input.side
	const edge = alignEdge(side, input.align)
	if (edge === undefined) return { side, align: input.align }
	const otherAlign: Align = input.align === "start" ? "end" : "start"
	const alignOverflow = overflow(input, coordsFor(input, side, input.align), edge, flipPadding(input, edge))
	const otherEdge = opposite(edge)
	const otherOverflow = overflow(
		input,
		coordsFor(input, side, otherAlign),
		otherEdge,
		flipPadding(input, otherEdge),
	)
	return { side, align: alignOverflow > 0 && otherOverflow < alignOverflow ? otherAlign : input.align }
}

const roundByDpr = (value: number, dpr: number) => Math.round(value * dpr) / dpr

export const computePosition = (input: PositionInput): PopupPosition => {
	const { side, align } = flipped(input)
	const base = coordsFor(input, side, align)
	const vertical = isVertical(side)
	const cross = vertical ? base.x : base.y
	const popupCross = vertical ? input.popup.width : input.popup.height
	const anchorStart = vertical ? input.anchor.x : input.anchor.y
	const anchorLength = vertical ? input.anchor.width : input.anchor.height
	const viewportCross = vertical ? input.viewport.width : input.viewport.height
	const shiftedCross = clamp(
		anchorStart - popupCross,
		clamp(PADDING, cross, viewportCross - PADDING - popupCross),
		anchorStart + anchorLength,
	)
	const at = vertical ? { x: shiftedCross, y: base.y } : { x: base.x, y: shiftedCross }
	const shift = shiftedCross - cross
	const mainEdgeSpace = (edge: Side) =>
		(vertical ? input.popup.height : input.popup.width) - overflow(input, at, edge, PADDING)
	const availableWidth = vertical ? input.viewport.width - 2 * PADDING : mainEdgeSpace(side)
	const availableHeight = vertical ? mainEdgeSpace(side) : input.viewport.height - 2 * PADDING
	const crossOrigin =
		align !== "center" && Math.abs(shift) <= 1
			? align === "start"
				? "0%"
				: "100%"
			: `${clamp(0, anchorStart + anchorLength / 2 - shiftedCross, popupCross)}px`
	const sideOrigin =
		side === "top" || side === "left" ? `calc(100% + ${input.sideOffset}px)` : `${-input.sideOffset}px`
	const { x, y, width, height } = input.anchor
	return {
		side,
		align,
		x: roundByDpr(at.x, input.dpr),
		y: roundByDpr(at.y, input.dpr),
		availableWidth,
		availableHeight,
		anchorWidth: (Math.round((x + width) * input.dpr) - Math.round(x * input.dpr)) / input.dpr,
		anchorHeight: (Math.round((y + height) * input.dpr) - Math.round(y * input.dpr)) / input.dpr,
		transformOrigin: vertical ? `${crossOrigin} ${sideOrigin}` : `${sideOrigin} ${crossOrigin}`,
		anchor: input.anchor,
	}
}

// MEASURE (Mount-only: reads layout)

const dprRounded = (start: number, length: number, dpr: number) =>
	(Math.round((start + length) * dpr) - Math.round(start * dpr)) / dpr

/**
 * Measures the trigger and the positioner and computes the position. The positioner gets the
 * anchor-size variables first, because the popup's width can follow `--anchor-width`.
 */
export const measurePosition = (
	positioner: Element,
	anchorId: string,
	placement: Placement,
): PopupPosition | undefined => {
	const anchorElement = positioner.ownerDocument.getElementById(anchorId)
	if (anchorElement === null || !(positioner instanceof HTMLElement)) return undefined
	const box = anchorElement.getBoundingClientRect()
	const dpr = window.devicePixelRatio || 1
	positioner.style.setProperty("--anchor-width", `${dprRounded(box.x, box.width, dpr)}px`)
	positioner.style.setProperty("--anchor-height", `${dprRounded(box.y, box.height, dpr)}px`)
	const popupBox = positioner.getBoundingClientRect()
	const root = positioner.ownerDocument.documentElement
	return computePosition({
		...placement,
		anchor: { x: box.x, y: box.y, width: box.width, height: box.height },
		popup: { width: popupBox.width, height: popupBox.height },
		viewport: { width: root.clientWidth, height: root.clientHeight },
		dpr,
	})
}
