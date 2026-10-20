import {
	autoUpdate,
	computePosition,
	flip,
	limitShift,
	type Middleware,
	offset,
	type Placement,
	shift,
	size,
	type VirtualElement,
} from "@floating-ui/dom"
import { Effect, Queue, Schema, Stream } from "effect"

/**
 * Base UI's `useAnchorPositioning` (internals/useAnchorPositioning.mjs, @base-ui/react 1.8) on
 * `@floating-ui/dom`: the same middleware order, collision padding bias, CSS variables and styles.
 */
export const Side = Schema.Literals(["top", "right", "bottom", "left"])
export type Side = typeof Side.Type
export const Align = Schema.Literals(["start", "center", "end"])
export type Align = typeof Align.Type

/** What the popup is placed against: a trigger element by id, or a point (a context menu). */
export const Anchor = Schema.Union([
	/** `fallbackSelector`: placed against it instead while the element has no client rects (hidden). */
	Schema.TaggedStruct("Element", { id: Schema.String, fallbackSelector: Schema.optional(Schema.String) }),
	Schema.TaggedStruct("Selector", { selector: Schema.String }),
	Schema.TaggedStruct("Point", { x: Schema.Number, y: Schema.Number }),
])
export type Anchor = typeof Anchor.Type

export const PositionConfig = Schema.Struct({
	anchor: Anchor,
	side: Side,
	align: Align,
	sideOffset: Schema.Number,
	alignOffset: Schema.Number,
	collisionPadding: Schema.Number,
	positionMethod: Schema.Literals(["absolute", "fixed"]),
	/** `POPUP_COLLISION_AVOIDANCE` ("end") or `DROPDOWN_COLLISION_AVOIDANCE` ("none"). */
	fallbackAxisSide: Schema.Literals(["end", "none"]),
	/** Popover's viewport turns this on: `top`/`left` instead of a `translate`. */
	adaptiveOrigin: Schema.Boolean,
	/** A context menu shifts along the cross axis instead of flipping (`shift.crossAxis`). */
	shiftCrossAxis: Schema.Boolean,
	/** `lazyFlip` (Combobox): once flipped, the rendered side becomes the preferred one for this open. */
	lazyFlip: Schema.Boolean,
})
export type PositionConfig = typeof PositionConfig.Type

export const positionDefaults = {
	sideOffset: 0,
	alignOffset: 0,
	collisionPadding: 5,
	positionMethod: "absolute",
	fallbackAxisSide: "end",
	adaptiveOrigin: false,
	shiftCrossAxis: false,
	lazyFlip: false,
} as const satisfies Partial<PositionConfig>

/** Where the popup rendered; `isPlacedInstead` when a `placeInstead` hook placed it. */
export type Placed = Readonly<{ side: Side; align: Align; isPlacedInstead: boolean }>

const SIDES: ReadonlyArray<Side> = ["top", "right", "bottom", "left"]
const sideOf = (placement: Placement): Side => SIDES.find((side) => placement.startsWith(side)) ?? "bottom"
const alignOf = (placement: Placement): Align =>
	placement.endsWith("-start") ? "start" : placement.endsWith("-end") ? "end" : "center"
const placementOf = (side: Side, align: Align): Placement => (align === "center" ? side : `${side}-${align}`)

type Rects = Readonly<{ getClientRects: () => Readonly<{ length: number }> }>

/** Base UI's `anchor` callback with a fallback: the trigger while on screen, else the fallback. */
export const onScreenOr = <E extends Rects>(trigger: E | null, fallback: () => E | null): E | null =>
	trigger !== null && trigger.getClientRects().length > 0 ? trigger : fallback()

const resolveAnchor = (element: HTMLElement, anchor: Anchor): Element | VirtualElement | null => {
	if (anchor._tag === "Element") {
		const trigger = element.ownerDocument.getElementById(anchor.id)
		const { fallbackSelector } = anchor
		return fallbackSelector === undefined
			? trigger
			: onScreenOr(trigger, () => element.ownerDocument.querySelector(fallbackSelector))
	}
	if (anchor._tag === "Selector") return element.ownerDocument.querySelector(anchor.selector)
	const rect = { x: anchor.x, y: anchor.y, width: 0, height: 0 }
	return {
		getBoundingClientRect: () => ({
			...rect,
			top: anchor.y,
			left: anchor.x,
			right: anchor.x,
			bottom: anchor.y,
		}),
	}
}

/** Base UI's fork of `arrow` with a detached 0x0 element: only the anchor-centre offset matters. */
const fakeArrow: Middleware = {
	name: "arrow",
	fn: ({ x, y, placement, rects, elements }) => {
		const isYAxis = sideOf(placement) === "left" || sideOf(placement) === "right"
		const axis = isYAxis ? "y" : "x"
		const length = isYAxis ? "height" : "width"
		const coord = isYAxis ? y : x
		const endDiff = rects.reference[length] + rects.reference[axis] - coord - rects.floating[length]
		const startDiff = coord - rects.reference[axis]
		const clientSize =
			(isYAxis ? elements.floating.clientHeight : elements.floating.clientWidth) ||
			rects.floating[length]
		const center = clientSize / 2 + (endDiff / 2 - startDiff / 2)
		const clamped = Math.min(Math.max(0, center), clientSize)
		return { data: { [axis]: clamped, centerOffset: center - clamped } }
	},
}

/** The `transformOrigin` middleware: grow from the aligned edge, else from the (fake) arrow. */
const transformOrigin = (config: PositionConfig): Middleware => ({
	name: "transformOrigin",
	fn: ({ elements, middlewareData, placement }) => {
		const side = sideOf(placement)
		const align = alignOf(placement)
		const isVertical = side === "top" || side === "bottom"
		const shiftCross = isVertical ? (middlewareData.shift?.x ?? 0) : (middlewareData.shift?.y ?? 0)
		const arrowOffset = isVertical ? (middlewareData.arrow?.x ?? 0) : (middlewareData.arrow?.y ?? 0)
		const crossOrigin =
			align !== "center" && Math.abs(shiftCross) <= 1
				? align === "start"
					? "0%"
					: "100%"
				: `${arrowOffset}px`
		const sideOrigin =
			side === "top" || side === "left"
				? `calc(100% + ${config.sideOffset}px)`
				: `${-config.sideOffset}px`
		elements.floating.style.setProperty(
			"--transform-origin",
			isVertical ? `${crossOrigin} ${sideOrigin}` : `${sideOrigin} ${crossOrigin}`,
		)
		return {}
	},
})

const middlewareFor = (floating: HTMLElement, config: PositionConfig): Array<Middleware> => {
	const pad = config.collisionPadding
	const padding = { top: pad, right: pad, bottom: pad, left: pad }
	const flipMiddleware = flip({
		padding: {
			top: pad + 1 + (config.side === "bottom" ? 1 : 0),
			right: pad + 1 + (config.side === "left" ? 1 : 0),
			bottom: pad + 1 + (config.side === "top" ? 1 : 0),
			left: pad + 1 + (config.side === "right" ? 1 : 0),
		},
		mainAxis: !config.shiftCrossAxis,
		crossAxis: "alignment",
		fallbackAxisSideDirection: config.fallbackAxisSide,
	})
	const shiftMiddleware = shift({
		padding,
		mainAxis: true,
		crossAxis: config.shiftCrossAxis,
		limiter: config.shiftCrossAxis ? undefined : limitShift(),
	})
	return [
		offset({
			mainAxis: config.sideOffset,
			crossAxis: config.alignOffset,
			alignmentAxis: config.alignOffset,
		}),
		...(config.align === "center"
			? [shiftMiddleware, flipMiddleware]
			: [flipMiddleware, shiftMiddleware]),
		size({
			padding,
			apply: ({ availableWidth, availableHeight, rects }) => {
				floating.style.setProperty("--available-width", `${availableWidth}px`)
				floating.style.setProperty("--available-height", `${availableHeight}px`)
				const { x, y, width, height } = rects.reference
				const dpr = window.devicePixelRatio || 1
				const snap = (start: number, extent: number) =>
					(Math.round((start + extent) * dpr) - Math.round(start * dpr)) / dpr
				floating.style.setProperty("--anchor-width", `${snap(x, width)}px`)
				floating.style.setProperty("--anchor-height", `${snap(y, height)}px`)
			},
		}),
		fakeArrow,
		transformOrigin(config),
	]
}

/** `floatingStyles`: a DPR-rounded translate, or raw `top`/`left` for an adaptive-origin popup. */
const applyCoordinates = (floating: HTMLElement, config: PositionConfig, x: number, y: number): void => {
	floating.style.position = config.positionMethod
	if (config.adaptiveOrigin) {
		floating.style.top = `${y}px`
		floating.style.left = `${x}px`
		return
	}
	const dpr = window.devicePixelRatio || 1
	const round = (value: number) => Math.round(value * dpr) / dpr
	floating.style.top = "0px"
	floating.style.left = "0px"
	floating.style.transform = `translate(${round(x)}px, ${round(y)}px)`
}

/**
 * Positions `floating` against the anchor and keeps it there (`autoUpdate`: scroll, resize,
 * layout shift). Emits the rendered side and alignment whenever a flip changes them.
 */
export const anchorPosition = (
	floating: HTMLElement,
	config: PositionConfig,
	afterPlace: (floating: HTMLElement, side: Side) => void = () => undefined,
	/** Places the popup itself instead (Select aligned with its trigger); true skips the coordinates. */
	placeInstead: (floating: HTMLElement) => boolean = () => false,
): Stream.Stream<Placed> =>
	Stream.callback<Placed>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const reference = resolveAnchor(floating, config.anchor)
				if (reference === null) return () => undefined
				const state = {
					isActive: true,
					side: config.side,
					align: config.align,
					isPlacedInstead: false,
					/** Base UI's `mountSide`: the placement asked for; the flip padding keeps `config.side`. */
					preferredSide: config.side,
				}
				floating.style.position = config.positionMethod
				floating.style.top = "0px"
				floating.style.left = "0px"
				const update = () => {
					computePosition(reference, floating, {
						placement: placementOf(state.preferredSide, config.align),
						strategy: config.positionMethod,
						middleware: middlewareFor(floating, config),
					}).then(({ x, y, placement }) => {
						if (!state.isActive) return
						const isPlacedInstead = placeInstead(floating)
						if (!isPlacedInstead) applyCoordinates(floating, config, x, y)
						const side = sideOf(placement)
						afterPlace(floating, side)
						const align = alignOf(placement)
						if (config.lazyFlip && side !== state.preferredSide) state.preferredSide = side
						const isSame =
							side === state.side &&
							align === state.align &&
							isPlacedInstead === state.isPlacedInstead
						if (isSame) return
						state.side = side
						state.align = align
						state.isPlacedInstead = isPlacedInstead
						Queue.offerUnsafe(queue, { side, align, isPlacedInstead })
					})
				}
				const stop = autoUpdate(reference, floating, update)
				return () => {
					state.isActive = false
					stop()
				}
			}),
			(stop) => Effect.sync(stop),
		).pipe(Effect.andThen(Effect.never)),
	)
