import { Array, Effect, Option, Queue, Stream } from "effect"
import { anchorPosition, type Placed, type PositionConfig, type Side } from "./position"
import { lockBodyScroll, manageFocus, markOutside, portalToBody } from "./portal"

/**
 * The Mount body every anchored popup shares (popover, hover card, menus, select, combobox):
 * portal to `<body>`, Base UI's outside marking, optional scroll lock and focus moves, the
 * positioner placed by `anchorPosition`, and presses outside the popup and its trigger.
 */
export type AnchoredEvent =
	| Readonly<{ _tag: "Mounted" }>
	| Readonly<{ _tag: "Placed"; placed: Placed }>
	| Readonly<{ _tag: "PressedOutside" }>

export type AnchoredOptions = Readonly<{
	positionerSelector: string
	popupSelector: string
	config: PositionConfig
	/** Selectors of elements whose presses do not count as outside (the trigger, an input group). */
	insideSelectors: ReadonlyArray<string>
	markOutside: Option.Option<Readonly<{ mark: boolean; ariaHidden: boolean; keep?: ReadonlyArray<string> }>>
	lockScroll: boolean
	focus: Option.Option<
		Readonly<{
			returnFocusId: Option.Option<string>
			initialFocus: "first-tabbable" | "popup" | "highlighted" | "none"
		}>
	>
	/** Run after each placement: variables a component's positioner adds (Popover's size). */
	afterPlace?: (positioner: HTMLElement, popup: HTMLElement, side: Side) => void
	/** Places the popup itself (Select aligned with its trigger); true skips the anchored coordinates. */
	placeInstead?: (positioner: HTMLElement, popup: HTMLElement) => boolean
}>

const MOUNTED: AnchoredEvent = { _tag: "Mounted" }

/** Pointer presses anywhere outside `inside` and the `insideSelectors` elements (`outsidePress`). */
export const outsidePresses = (
	root: Element,
	insideSelectors: ReadonlyArray<string>,
	/** Presses this accepts are not outside either (a popup nested in a dialog). */
	isAlsoInside: (target: Node) => boolean = () => false,
): Stream.Stream<AnchoredEvent> =>
	Stream.callback<AnchoredEvent>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const onPointerDown = (event: PointerEvent) => {
					const target = event.target
					if (!(target instanceof Node) || root.contains(target)) return
					const isInside = Array.some(
						insideSelectors,
						(selector) => document.querySelector(selector)?.contains(target) ?? false,
					)
					if (!isInside && !isAlsoInside(target)) Queue.offerUnsafe(queue, { _tag: "PressedOutside" })
				}
				document.addEventListener("pointerdown", onPointerDown, true)
				return onPointerDown
			}),
			(onPointerDown) =>
				Effect.sync(() => document.removeEventListener("pointerdown", onPointerDown, true)),
		).pipe(Effect.andThen(Effect.never)),
	)

export const anchoredPopup = (root: Element, options: AnchoredOptions): Stream.Stream<AnchoredEvent> =>
	Stream.unwrap(
		Effect.gen(function* () {
			yield* portalToBody(root)
			if (Option.isSome(options.markOutside)) yield* markOutside(root, options.markOutside.value)
			if (options.lockScroll) yield* lockBodyScroll
			const positioner = root.querySelector(options.positionerSelector)
			const popup = root.querySelector(options.popupSelector)
			if (!(positioner instanceof HTMLElement) || !(popup instanceof HTMLElement)) {
				return Stream.make(MOUNTED)
			}
			if (Option.isSome(options.focus)) yield* manageFocus(popup, options.focus.value)
			const { afterPlace, placeInstead } = options
			const placements = anchorPosition(
				positioner,
				options.config,
				(placed, side) => afterPlace?.(placed, popup, side),
				(placed) => placeInstead?.(placed, popup) ?? false,
			).pipe(Stream.map((placed): AnchoredEvent => ({ _tag: "Placed", placed })))
			return Stream.concat(
				Stream.make(MOUNTED),
				Stream.merge(placements, outsidePresses(root, options.insideSelectors)),
			)
		}),
	)
