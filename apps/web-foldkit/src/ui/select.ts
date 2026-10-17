import * as Animation from "@foldkit/ui/animation"
import { Effect, Option, Schema, Stream } from "effect"
import { Command, Dom, Mount, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { anchoredPopup } from "./overlay/anchored"
import { initPopup, makeTransition, PopupState, triggerId } from "./overlay/popup-state"
import { Align, positionDefaults, Side } from "./overlay/position"
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
})

// MESSAGE

export const Message = defineMessageUnion({
	ClickedTrigger: { selectedIndex: Schema.NullOr(Schema.Number) },
	PressedEscape: {},
	PressedOutside: {},
	HighlightedItem: { index: Schema.Number },
	HoveredItem: { index: Schema.Number },
	SelectedItem: { index: Schema.Number, value: Schema.String },
	CompletedFocusSelectItem: {},
	CompletedMountSelect: {},
	ChangedPlacement: { side: Side, align: Align, isAlignedWithTrigger: Schema.Boolean },
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

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>

const open = (model: Model, selectedIndex: number | null): UpdateReturn =>
	transition.open({ ...model, highlighted: selectedIndex, isAlignedWithTrigger: true })

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		ClickedTrigger: ({ selectedIndex }) =>
			model.isOpen ? transition.close(model) : open(model, selectedIndex),
		PressedEscape: () => transition.close(model),
		PressedOutside: () => transition.close(model),
		HighlightedItem: ({ index }) => ({ model: { ...model, highlighted: index } }),
		HoveredItem: ({ index }) =>
			model.highlighted === index
				? { model }
				: {
						model: { ...model, highlighted: index },
						commands: [FocusSelectItem({ id: itemId(model.id, index) })],
					},
		SelectedItem: ({ value }) => ({
			...transition.close({ ...model, value }),
			outMessage: OutMessage.ChangedValue({ value }),
		}),
		CompletedFocusSelectItem: () => ({ model }),
		CompletedMountSelect: () => ({ model }),
		ChangedPlacement: ({ side, align, isAlignedWithTrigger }) => ({
			model: { ...model, side, align, isAlignedWithTrigger },
		}),
		GotAnimationMessage: ({ message: animationMessage }) =>
			transition.foldAnimation(model, animationMessage),
	})

// MOUNT

const htmlOrNull = (element: Element | null): HTMLElement | null =>
	element instanceof HTMLElement ? element : null

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
	messages: [Message.CompletedMountSelect, Message.ChangedPlacement, Message.PressedOutside],
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
			Stream.map((event) => {
				switch (event._tag) {
					case "Mounted":
						return Message.CompletedMountSelect()
					case "Placed":
						return Message.ChangedPlacement({
							side: event.placed.side,
							align: event.placed.align,
							isAlignedWithTrigger: event.placed.isPlacedInstead,
						})
					case "PressedOutside":
						return Message.PressedOutside()
				}
			}),
		)
	},
})
