import * as Animation from "@foldkit/ui/animation"
import { Effect, Option, Schema, Stream } from "effect"
import { Command, Dom, Mount, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { anchoredPopup } from "./overlay/anchored"
import { initPopup, makeTransition, PopupState, popupId } from "./overlay/popup-state"
import { Align, positionDefaults, Side } from "./overlay/position"
import { isRovingKey, nextIndex } from "./overlay/roving"

/**
 * Base UI `ContextMenu` (`@maple/ui/context-menu`): a right-click on the trigger opens a menu at
 * the pointer (fixed, side right, align start, offset 4); arrows move the highlight, Enter or a
 * click picks an item, Escape and a press outside close it. `context-menu-view.ts` renders it.
 */

// MODEL

export const Point = Schema.Struct({ x: Schema.Number, y: Schema.Number })
export type Point = typeof Point.Type

export const Model = Schema.Struct({
	...PopupState.fields,
	point: Point,
	highlighted: Schema.NullOr(Schema.Number),
})
export type Model = typeof Model.Type

export const itemId = (id: string, index: number): string => `${id}-item-${index}`

/** Closed; `isOpen` starts it open at `point` (a restored menu, or a test). */
export const init = (id: string, options: Readonly<{ isOpen?: boolean; point?: Point }> = {}): Model => ({
	...initPopup(id, { isOpen: options.isOpen ?? false, side: "right", align: "start" }),
	point: options.point ?? { x: 0, y: 0 },
	highlighted: null,
})

// MESSAGE

export const Message = defineMessageUnion({
	PressedTriggerPointer: { point: Point },
	OpenedContextMenu: {},
	PressedOutside: {},
	PressedEscape: {},
	PressedMenuKey: { key: Schema.String, enabled: Schema.Array(Schema.Boolean) },
	LeftMenu: {},
	HoveredItem: { index: Schema.Number },
	ClickedItem: { index: Schema.Number },
	CompletedFocusMenuItem: {},
	CompletedMountContextMenu: {},
	ChangedPlacement: { side: Side, align: Align },
	GotAnimationMessage: { message: Animation.Message },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ SelectedItem: { index: Schema.Number } })
export type OutMessage = typeof OutMessage.Type

// UPDATE

/** Pointer highlight moves focus to the item, as Base UI's menu does. */
export const FocusMenuItem = Command.define("FocusMenuItem", {
	args: { id: Schema.String },
	messages: [Message.CompletedFocusMenuItem],
	execute: ({ id }) =>
		Dom.focus(`#${CSS.escape(id)}`).pipe(Effect.ignore, Effect.as(Message.CompletedFocusMenuItem())),
})

const transition = makeTransition<Model, Message>(
	(message) => Message.GotAnimationMessage({ message }),
	"WaitForContextMenuExit",
)
export const WaitForContextMenuExit = transition.WaitForExit

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>

const close = (model: Model): UpdateReturn => transition.close({ ...model, highlighted: null })

/** The highlight moves in `update`, from the current Model, so fast keystrokes never reuse a stale one. */
const highlight = (model: Model, index: number): UpdateReturn => ({
	model: { ...model, highlighted: index },
	commands: [FocusMenuItem({ id: itemId(model.id, index) })],
})

const pick = (model: Model, index: number): UpdateReturn => ({
	...close(model),
	outMessage: OutMessage.SelectedItem({ index }),
})

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		PressedTriggerPointer: ({ point }) => ({ model: { ...model, point } }),
		OpenedContextMenu: () => transition.open({ ...model, highlighted: null }),
		PressedOutside: () => close(model),
		PressedEscape: () => close(model),
		PressedMenuKey: ({ key, enabled }) => {
			if (key === "Escape") return close(model)
			if (isRovingKey(key)) {
				return Option.match(nextIndex(enabled, model.highlighted, key), {
					onNone: () => ({ model }),
					onSome: (index) => highlight(model, index),
				})
			}
			return model.highlighted === null ? { model } : pick(model, model.highlighted)
		},
		LeftMenu: () => ({ model: { ...model, highlighted: null } }),
		HoveredItem: ({ index }) => (model.highlighted === index ? { model } : highlight(model, index)),
		ClickedItem: ({ index }) => pick(model, index),
		CompletedFocusMenuItem: () => ({ model }),
		CompletedMountContextMenu: () => ({ model }),
		ChangedPlacement: ({ side, align }) => ({ model: { ...model, side, align } }),
		GotAnimationMessage: ({ message: animationMessage }) =>
			transition.foldAnimation(model, animationMessage),
	})

// MOUNT

/** Portal, `aria-hidden` on the page, scroll lock, focus on the menu, placement at the pointer. */
export const MountContextMenu = Mount.defineStream("MountContextMenu", {
	args: { id: Schema.String, point: Point },
	messages: [Message.CompletedMountContextMenu, Message.ChangedPlacement, Message.PressedOutside],
	execute: ({ element, id, point }) =>
		anchoredPopup(element, {
			positionerSelector: ":scope > [data-side]",
			popupSelector: `#${CSS.escape(popupId(id))}`,
			config: {
				...positionDefaults,
				anchor: { _tag: "Point", x: point.x, y: point.y },
				side: "right",
				align: "start",
				alignOffset: 4,
				positionMethod: "fixed",
				fallbackAxisSide: "none",
				shiftCrossAxis: true,
			},
			insideSelectors: [],
			markOutside: Option.some({ mark: true, ariaHidden: true }),
			lockScroll: true,
			focus: Option.some({ returnFocusId: Option.none(), initialFocus: "popup" }),
		}).pipe(
			Stream.map((event) => {
				switch (event._tag) {
					case "Mounted":
						return Message.CompletedMountContextMenu()
					case "Placed":
						return Message.ChangedPlacement({
							side: event.placed.side,
							align: event.placed.align,
						})
					case "PressedOutside":
						return Message.PressedOutside()
				}
			}),
		),
})
