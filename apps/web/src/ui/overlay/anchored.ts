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

/** The root's own modal backdrop: it covers the page, so a press on it is a press outside. */
const isOwnBackdrop = (root: Element, target: Node): boolean =>
	target instanceof Element && target.parentElement === root && target.hasAttribute("data-base-ui-inert")

/** Pointer presses anywhere outside `inside` and the `insideSelectors` elements (`outsidePress`). */
export const outsidePresses = (
	root: Element,
	insideSelectors: ReadonlyArray<string>,
): Stream.Stream<AnchoredEvent> =>
	Stream.callback<AnchoredEvent>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const onPointerDown = (event: PointerEvent) => {
					const target = event.target
					if (!(target instanceof Node)) return
					if (root.contains(target) && !isOwnBackdrop(root, target)) return
					const element = target instanceof Element ? target : target.parentElement
					const isInside = Array.some(
						insideSelectors,
						(selector) => element?.closest(selector) != null,
					)
					if (!isInside) Queue.offerUnsafe(queue, { _tag: "PressedOutside" })
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

const isInsidePortal = (target: EventTarget | null): boolean =>
	typeof Element !== "undefined" && target instanceof Element && target.closest("[data-base-ui-portal]") !== null

/**
 * Escape pressed while focus sits outside every portal (on `<body>` after the focused control
 * re-rendered away): Base UI's dismiss listens on the document, so the topmost `root` still closes.
 */
export const strayEscapes = (root: EventTarget): Stream.Stream<void> =>
	Stream.callback<void>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const onKeyDown = (event: KeyboardEvent) => {
					if (event.key !== "Escape" || event.defaultPrevented) return
					if (isInsidePortal(event.target)) return
					const portals = document.querySelectorAll("[data-base-ui-portal]:not([data-slot^=\"toast\"])")
					if (portals[portals.length - 1] !== root) return
					event.preventDefault()
					Queue.offerUnsafe(queue, undefined)
				}
				document.addEventListener("keydown", onKeyDown)
				return onKeyDown
			}),
			(onKeyDown) => Effect.sync(() => document.removeEventListener("keydown", onKeyDown)),
		).pipe(Effect.andThen(Effect.never)),
	)
