import * as Animation from "@foldkit/ui/animation"
import { Array, Effect, Option, Queue, Schema, Stream } from "effect"
import { Command, Dom, Mount, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { anchoredPopup } from "./overlay/anchored"
import { initPopup, makeTransition, PopupState, triggerId } from "./overlay/popup-state"
import { Align, positionDefaults, Side } from "./overlay/position"
import { isRovingKey, nextIndex } from "./overlay/roving"
import { alignItemWithTrigger } from "./overlay/select-align"

/**
 * Base UI `Select` (`@maple/ui/select`): the popup opens over the trigger with the selected item
 * on the trigger's value (`alignItemWithTrigger`), or below it when that does not fit. Arrows
 * move the highlight, Enter or a click selects, Escape and a press outside close it.
 */

// MODEL

export const Model = Schema.Struct({
	...PopupState.fields,
	value: Schema.String,
	highlighted: Schema.NullOr(Schema.Number),
	isAlignedWithTrigger: Schema.Boolean,
	/** `SelectScrollUpArrow` / `SelectScrollDownArrow`: shown while the list can scroll that way. */
	scrollArrows: Schema.Struct({ up: Schema.Boolean, down: Schema.Boolean }),
})
export type Model = typeof Model.Type

export const listId = (id: string): string => `${id}-list`
export const itemId = (id: string, index: number): string => `${id}-item-${index}`

/** `<Select defaultValue defaultOpen>`; `selectedIndex` is the value's index among the items. */
export const init = (
	id: string,
	options: Readonly<{ value: string; selectedIndex: number | null; isOpen?: boolean }>,
): Model => ({
	...initPopup(id, { isOpen: options.isOpen ?? false, side: "bottom", align: "start" }),
	value: options.value,
	highlighted: options.isOpen === true ? options.selectedIndex : null,
	isAlignedWithTrigger: true,
	scrollArrows: { up: false, down: false },
})

// MESSAGE

export const Message = defineMessageUnion({
	ClickedTrigger: { selectedIndex: Schema.NullOr(Schema.Number) },
	PressedEscape: {},
	PressedOutside: {},
	PressedTriggerKey: { key: Schema.String, selectedIndex: Schema.NullOr(Schema.Number) },
	PressedListKey: { key: Schema.String, values: Schema.Array(Schema.String) },
	HoveredItem: { index: Schema.Number },
	SelectedItem: { index: Schema.Number, value: Schema.String },
	CompletedFocusSelectItem: {},
	CompletedMountSelect: {},
	ChangedPlacement: { side: Side, align: Align, isAlignedWithTrigger: Schema.Boolean },
	ChangedScrollArrows: { up: Schema.Boolean, down: Schema.Boolean },
	GotAnimationMessage: { message: Animation.Message },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ ChangedValue: { value: Schema.String } })
export type OutMessage = typeof OutMessage.Type

// UPDATE

export const FocusSelectItem = Command.define("FocusSelectItem", {
	args: { id: Schema.String },
	messages: [Message.CompletedFocusSelectItem],
	execute: ({ id }) =>
		Dom.focus(`#${CSS.escape(id)}`).pipe(Effect.ignore, Effect.as(Message.CompletedFocusSelectItem())),
})

const transition = makeTransition<Model, Message>(
	(message) => Message.GotAnimationMessage({ message }),
	"WaitForSelectExit",
)
export const WaitForSelectExit = transition.WaitForExit

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>

/** The highlight moves in `update`, from the current Model, with focus following it. */
const highlight = (model: Model, index: number): UpdateReturn => ({
	model: { ...model, highlighted: index },
	commands: [FocusSelectItem({ id: itemId(model.id, index) })],
})

const select = (model: Model, value: string): UpdateReturn => ({
	...transition.close({ ...model, value }),
	outMessage: OutMessage.ChangedValue({ value }),
})

const open = (model: Model, selectedIndex: number | null): UpdateReturn =>
	transition.open({
		...model,
		highlighted: selectedIndex,
		isAlignedWithTrigger: true,
		scrollArrows: { up: false, down: false },
	})

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		// `focusItemOnOpen: "auto"`: a pointer open highlights nothing until an item is hovered.
		ClickedTrigger: () => (model.isOpen ? transition.close(model) : open(model, null)),
		PressedEscape: () => transition.close(model),
		PressedOutside: () => transition.close(model),
		PressedTriggerKey: ({ selectedIndex }) => (model.isOpen ? { model } : open(model, selectedIndex)),
		PressedListKey: ({ key, values }) => {
			if (key === "Escape") return transition.close(model)
			if (isRovingKey(key)) {
				return Option.match(
					nextIndex(
						values.map(() => true),
						model.highlighted,
						key,
					),
					{ onNone: () => ({ model }), onSome: (index) => highlight(model, index) },
				)
			}
			return Option.match(
				Option.flatMap(Option.fromNullishOr(model.highlighted), (index) => Array.get(values, index)),
				{
					onNone: () => ({ model }),
					onSome: (value) => select(model, value),
				},
			)
		},
		HoveredItem: ({ index }) => (model.highlighted === index ? { model } : highlight(model, index)),
		SelectedItem: ({ value }) => select(model, value),
		CompletedFocusSelectItem: () => ({ model }),
		CompletedMountSelect: () => ({ model }),
		ChangedPlacement: ({ side, align, isAlignedWithTrigger }) => ({
			model: { ...model, side, align, isAlignedWithTrigger },
		}),
		ChangedScrollArrows: ({ up, down }) =>
			model.scrollArrows.up === up && model.scrollArrows.down === down
				? { model }
				: { model: { ...model, scrollArrows: { up, down } } },
		GotAnimationMessage: ({ message: animationMessage }) =>
			transition.foldAnimation(model, animationMessage),
	})

// MOUNT

const htmlOrNull = (element: Element | null): HTMLElement | null =>
	element instanceof HTMLElement ? element : null

const SCROLL_EDGE_TOLERANCE_PX = 1

type MountMessage =
	| typeof Message.CompletedMountSelect.Type
	| typeof Message.ChangedPlacement.Type
	| typeof Message.ChangedScrollArrows.Type
	| typeof Message.PressedOutside.Type

/** `handleScrollArrowVisibility`: an arrow per direction the list can still scroll. */
const scrollArrowsOf = (scroller: HTMLElement | null) => {
	if (scroller === null) return Message.ChangedScrollArrows({ up: false, down: false })
	const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
	const top = Math.min(Math.max(scroller.scrollTop, 0), max)
	return Message.ChangedScrollArrows({
		up: top > SCROLL_EDGE_TOLERANCE_PX,
		down: max - top > SCROLL_EDGE_TOLERANCE_PX,
	})
}

/** The list's scroll events, as arrow visibility; resting on an arrow scrolls an item per 40 ms. */
const listScrolls = (root: Element, id: string) =>
	Stream.callback<typeof Message.ChangedScrollArrows.Type>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const scroller = htmlOrNull(document.getElementById(listId(id)))
				const timer = { handle: 0 }
				const stop = () => {
					window.clearInterval(timer.handle)
					timer.handle = 0
				}
				const onScroll = () => Queue.offerUnsafe(queue, scrollArrowsOf(scroller))
				const onMouseMove = (event: Event) => {
					const arrow =
						event.target instanceof Element ? event.target.closest("[data-direction]") : null
					if (arrow === null || scroller === null || timer.handle !== 0) return
					const step = arrow.getAttribute("data-direction") === "up" ? -1 : 1
					timer.handle = window.setInterval(() => {
						const item = scroller.querySelector<HTMLElement>("[role=option]")
						const before = scroller.scrollTop
						scroller.scrollTop = before + step * (item?.offsetHeight ?? 32)
						if (scroller.scrollTop === before) stop()
					}, 40)
				}
				const onMouseOut = (event: Event) => {
					const from =
						event.target instanceof Element ? event.target.closest("[data-direction]") : null
					const to =
						event instanceof MouseEvent && event.relatedTarget instanceof Element
							? event.relatedTarget
							: null
					if (from !== null && (to === null || !from.contains(to))) stop()
				}
				scroller?.addEventListener("scroll", onScroll, { passive: true })
				root.addEventListener("mousemove", onMouseMove)
				root.addEventListener("mouseout", onMouseOut)
				return { scroller, onScroll, onMouseMove, onMouseOut, stop }
			}),
			({ scroller, onScroll, onMouseMove, onMouseOut, stop }) =>
				Effect.sync(() => {
					stop()
					scroller?.removeEventListener("scroll", onScroll)
					root.removeEventListener("mousemove", onMouseMove)
					root.removeEventListener("mouseout", onMouseOut)
				}),
		).pipe(Effect.flatMap(() => Effect.never)),
	)

/** `InternalBackdrop`'s cutout: the backdrop catches outside presses everywhere but the trigger. */
const cutOutTrigger = (backdrop: Element | null, trigger: HTMLElement | null) => {
	if (!(backdrop instanceof HTMLElement) || trigger === null) return
	const { left, top, right, bottom } = trigger.getBoundingClientRect()
	backdrop.style.clipPath = `polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%, ${left}px ${top}px, ${left}px ${bottom}px, ${right}px ${bottom}px, ${right}px ${top}px, ${left}px ${top}px)`
}

/**
 * Portal, inert marker, scroll lock, focus on the selected item, and the first placement over
 * the trigger (`alignItemWithTrigger`); later updates keep it there, or anchor below on fallback.
 */
export const MountSelect = Mount.defineStream("MountSelect", {
	args: { id: Schema.String },
	messages: [
		Message.CompletedMountSelect,
		Message.ChangedPlacement,
		Message.ChangedScrollArrows,
		Message.PressedOutside,
	],
	execute: ({ element, id }) => {
		const alignment = { isFirst: true, isAligned: false }
		return anchoredPopup(element, {
			positionerSelector: "[data-slot=select-positioner]",
			popupSelector: "[data-slot=select-popup]",
			config: {
				...positionDefaults,
				anchor: { _tag: "Element", id: triggerId(id) },
				side: "bottom",
				align: "start",
				sideOffset: 4,
				fallbackAxisSide: "none",
			},
			insideSelectors: [`#${CSS.escape(triggerId(id))}`],
			markOutside: Option.some({ mark: true, ariaHidden: false }),
			lockScroll: true,
			focus: Option.some({ returnFocusId: Option.some(triggerId(id)), initialFocus: "first-tabbable" }),
			afterPlace: () =>
				cutOutTrigger(element.firstElementChild, document.getElementById(triggerId(id))),
			placeInstead: (positioner, popup) => {
				if (alignment.isFirst) {
					alignment.isFirst = false
					const trigger = document.getElementById(triggerId(id))
					const scroller = document.getElementById(listId(id))
					positioner.style.position = "fixed"
					alignment.isAligned =
						trigger !== null &&
						scroller !== null &&
						alignItemWithTrigger({
							trigger,
							positioner,
							popup,
							scroller,
							value: htmlOrNull(trigger.querySelector("[data-slot=select-value]")),
							text: htmlOrNull(
								popup.querySelector("[role=option][data-selected]")?.lastElementChild ?? null,
							),
						})
					if (!alignment.isAligned) positioner.style.position = "absolute"
				}
				return alignment.isAligned
			},
		}).pipe(
			Stream.flatMap((event): Stream.Stream<MountMessage> => {
				switch (event._tag) {
					case "Mounted":
						return Stream.make(Message.CompletedMountSelect())
					case "Placed":
						return Stream.make(
							Message.ChangedPlacement({
								side: event.placed.side,
								align: event.placed.align,
								isAlignedWithTrigger: event.placed.isPlacedInstead,
							}),
							scrollArrowsOf(htmlOrNull(document.getElementById(listId(id)))),
						)
					case "PressedOutside":
						return Stream.make(Message.PressedOutside())
				}
			}),
			Stream.merge(listScrolls(element, id)),
		)
	},
})
