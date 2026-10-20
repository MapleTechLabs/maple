import * as Animation from "@foldkit/ui/animation"
import { Array, Duration, Effect, Number, Option, Schema, Stream } from "effect"
import { Command, Dom, Mount, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { anchoredPopup } from "./overlay/anchored"
import { initPopup, makeTransition, PopupState, popupId, triggerId } from "./overlay/popup-state"
import { Align, positionDefaults, Side } from "./overlay/position"
import { isRovingKey, nextIndex } from "./overlay/roving"
import * as Tooltip from "./tooltip"

/**
 * Base UI `Menu` (`@maple/ui/dropdown-menu`): the trigger toggles it; arrows move the highlight,
 * Enter or a click picks an item, a checkbox or radio item stays open, a submenu opens on
 * hover (100 ms) or ArrowRight and closes on ArrowLeft; Escape and a press outside close it.
 * `menu-view.ts` renders it from the `dropdown-menu.ts` parts.
 */

// ENTRIES

/** What the update needs to know about a highlightable entry: what it does, and its value. */
export const ItemKind = Schema.Literals(["Item", "Submenu", "Checkbox", "Radio"])
export type ItemKind = typeof ItemKind.Type

/** A disabled item stays reachable by arrows (Base UI's empty `disabledIndices`) but never runs. */
export const ItemRef = Schema.Struct({
	kind: ItemKind,
	value: Schema.String,
	isDisabled: Schema.optionalKey(Schema.Boolean),
})
export type ItemRef = typeof ItemRef.Type

// MODEL

export const Submenu = Schema.Struct({
	/** The root index of its trigger. */
	index: Schema.Number,
	value: Schema.String,
	side: Side,
	align: Align,
	highlighted: Schema.NullOr(Schema.Number),
})
export type Submenu = typeof Submenu.Type

export const Model = Schema.Struct({
	...PopupState.fields,
	highlighted: Schema.NullOr(Schema.Number),
	submenu: Schema.NullOr(Submenu),
	submenuGeneration: Schema.Number,
	/** The one tooltip a disabled item can carry (a `<TooltipTrigger render={<div />}>` around it). */
	itemTooltip: Tooltip.Model,
})
export type Model = typeof Model.Type

export const SUBMENU_DELAY = Duration.millis(100)

export const itemId = (id: string, index: number): string => `${id}-item-${index}`
export const subItemId = (id: string, index: number): string => `${id}-sub-item-${index}`
export const subPopupId = (id: string): string => `${id}-sub-popup`
export const subPortalId = (id: string): string => `${id}-sub-portal`
export const itemTooltipId = (id: string): string => `${id}-item-tooltip`
export const itemTooltipTriggerId = (id: string, index: number): string => `${id}-item-${index}-tooltip`

/** `<DropdownMenuContent>`'s defaults: below the trigger, start-aligned. */
export const init = (id: string, options: Readonly<{ isOpen?: boolean }> = {}): Model => ({
	...initPopup(id, { isOpen: options.isOpen ?? false, side: "bottom", align: "start" }),
	highlighted: null,
	submenu: null,
	submenuGeneration: 0,
	itemTooltip: Tooltip.init(itemTooltipId(id), { side: "left" }),
})

// MESSAGE

export const Message = defineMessageUnion({
	ClickedTrigger: {},
	PressedTriggerKey: { key: Schema.String, count: Schema.Number },
	PressedOutside: {},
	PressedMenuKey: { key: Schema.String, items: Schema.Array(ItemRef) },
	HoveredItem: { index: Schema.Number, item: ItemRef },
	ClickedItem: { index: Schema.Number, item: ItemRef },
	LeftMenu: {},
	ElapsedSubmenuDelay: { generation: Schema.Number, index: Schema.Number, value: Schema.String },
	/** `null` marks a disabled item: reachable, never selected. */
	PressedSubmenuKey: { key: Schema.String, values: Schema.Array(Schema.NullOr(Schema.String)) },
	HoveredSubmenuItem: { index: Schema.Number },
	ClickedSubmenuItem: { value: Schema.String },
	CompletedFocusMenuItem: {},
	CompletedMountMenu: {},
	CompletedMountSubmenu: {},
	ChangedPlacement: { side: Side, align: Align },
	ChangedSubmenuPlacement: { side: Side, align: Align },
	GotAnimationMessage: { message: Animation.Message },
	GotItemTooltipMessage: { message: Tooltip.Message, side: Side },
})
export type Message = typeof Message.Type

/** What was picked, by the entry's value; a submenu item also names its submenu. */
export const OutMessage = defineMessageUnion({
	SelectedItem: { value: Schema.String },
	ToggledCheckbox: { value: Schema.String },
	SelectedRadio: { value: Schema.String },
	SelectedSubmenuItem: { submenu: Schema.String, value: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

// UPDATE

/** A highlight moves focus to the item, as Base UI's menu does. */
export const FocusMenuItem = Command.define("FocusMenuItem", {
	args: { id: Schema.String },
	messages: [Message.CompletedFocusMenuItem],
	execute: ({ id }) =>
		Dom.focus(`#${CSS.escape(id)}`).pipe(Effect.ignore, Effect.as(Message.CompletedFocusMenuItem())),
})

/** The submenu trigger's hover delay; a newer hover bumps the generation and drops this one. */
export const WaitSubmenuDelay = Command.define("WaitSubmenuDelay", {
	args: { generation: Schema.Number, index: Schema.Number, value: Schema.String },
	messages: [Message.ElapsedSubmenuDelay],
	execute: (args) => Effect.sleep(SUBMENU_DELAY).pipe(Effect.as(Message.ElapsedSubmenuDelay(args))),
})

const transition = makeTransition<Model, Message>(
	(message) => Message.GotAnimationMessage({ message }),
	"WaitForMenuExit",
)
export const WaitForMenuExit = transition.WaitForExit

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>

const close = (model: Model): UpdateReturn =>
	transition.close({
		...model,
		itemTooltip: Tooltip.init(itemTooltipId(model.id), { side: model.itemTooltip.requestedSide }),
		highlighted: null,
		submenu: null,
		submenuGeneration: Number.increment(model.submenuGeneration),
	})

const closeWith = (model: Model, outMessage: OutMessage): UpdateReturn => ({
	...close(model),
	outMessage,
})

/** The highlight moves in `update`, from the current Model, so fast keystrokes never reuse a stale one. */
const highlight = (model: Model, index: number): UpdateReturn => ({
	model: { ...model, highlighted: index },
	commands: [FocusMenuItem({ id: itemId(model.id, index) })],
})

const openSubmenu = (model: Model, index: number, value: string, isKeyboard: boolean): UpdateReturn => ({
	model: {
		...model,
		highlighted: index,
		submenu: { index, value, side: "right", align: "start", highlighted: isKeyboard ? 0 : null },
		submenuGeneration: Number.increment(model.submenuGeneration),
	},
	commands: isKeyboard ? [FocusMenuItem({ id: subItemId(model.id, 0) })] : [],
})

const activate = (model: Model, index: number, item: ItemRef, isKeyboard: boolean): UpdateReturn => {
	if (item.isDisabled === true) return { model }
	switch (item.kind) {
		case "Item":
			return closeWith(model, OutMessage.SelectedItem({ value: item.value }))
		case "Submenu":
			return openSubmenu(model, index, item.value, isKeyboard)
		case "Checkbox":
			return { model, outMessage: OutMessage.ToggledCheckbox({ value: item.value }) }
		case "Radio":
			return { model, outMessage: OutMessage.SelectedRadio({ value: item.value }) }
	}
}

const allEnabled = (count: number): ReadonlyArray<boolean> => Array.makeBy(count, () => true)

/** Opens with a highlight (keyboard) or none (pointer); the Mount focuses the highlighted item. */
const open = (model: Model, highlighted: number | null): UpdateReturn =>
	transition.open({ ...model, highlighted, submenu: null })

const pressMenuKey = (model: Model, key: string, items: ReadonlyArray<ItemRef>): UpdateReturn => {
	if (key === "Escape") return close(model)
	if (isRovingKey(key)) {
		return Option.match(nextIndex(allEnabled(items.length), model.highlighted, key), {
			onNone: () => ({ model }),
			onSome: (index) => highlight({ ...model, submenu: null }, index),
		})
	}
	const current = model.highlighted === null ? undefined : items[model.highlighted]
	if (model.highlighted === null || current === undefined) return { model }
	if (key === "ArrowRight") {
		return current.kind === "Submenu"
			? openSubmenu(model, model.highlighted, current.value, true)
			: { model }
	}
	return key === "Enter" || key === " " ? activate(model, model.highlighted, current, true) : { model }
}

const pressSubmenuKey = (model: Model, key: string, values: ReadonlyArray<string | null>): UpdateReturn => {
	const submenu = model.submenu
	if (submenu === null) return { model }
	if (key === "Escape") return close(model)
	if (key === "ArrowLeft") return highlight({ ...model, submenu: null }, submenu.index)
	if (isRovingKey(key)) {
		return Option.match(nextIndex(allEnabled(values.length), submenu.highlighted, key), {
			onNone: () => ({ model }),
			onSome: (index) => ({
				model: { ...model, submenu: { ...submenu, highlighted: index } },
				commands: [FocusMenuItem({ id: subItemId(model.id, index) })],
			}),
		})
	}
	const value = submenu.highlighted === null ? undefined : values[submenu.highlighted]
	return (key === "Enter" || key === " ") && value !== undefined && value !== null
		? closeWith(model, OutMessage.SelectedSubmenuItem({ submenu: submenu.value, value }))
		: { model }
}

/** Hovering a submenu trigger schedules its submenu; hovering any other item closes it. */
const hoverItem = (model: Model, index: number, item: ItemRef): UpdateReturn => {
	if (model.highlighted === index && (item.kind !== "Submenu" || model.submenu !== null)) return { model }
	const generation = Number.increment(model.submenuGeneration)
	const isOwnSubmenuOpen = model.submenu !== null && model.submenu.index === index
	const next = highlight(
		{ ...model, submenu: isOwnSubmenuOpen ? model.submenu : null, submenuGeneration: generation },
		index,
	)
	return item.kind === "Submenu" && !isOwnSubmenuOpen
		? {
				...next,
				commands: [
					...(next.commands ?? []),
					WaitSubmenuDelay({ generation, index, value: item.value }),
				],
			}
		: next
}

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		ClickedTrigger: () => (model.isOpen ? close(model) : open(model, null)),
		PressedTriggerKey: ({ key, count }) =>
			key === "ArrowDown" ? open(model, 0) : key === "ArrowUp" ? open(model, count - 1) : { model },
		PressedOutside: () => close(model),
		PressedMenuKey: ({ key, items }) => pressMenuKey(model, key, items),
		HoveredItem: ({ index, item }) => hoverItem(model, index, item),
		ClickedItem: ({ index, item }) => activate(model, index, item, false),
		LeftMenu: () => (model.submenu === null ? { model: { ...model, highlighted: null } } : { model }),
		ElapsedSubmenuDelay: ({ generation, index, value }) =>
			generation === model.submenuGeneration && model.isOpen
				? openSubmenu(model, index, value, false)
				: { model },
		PressedSubmenuKey: ({ key, values }) => pressSubmenuKey(model, key, values),
		HoveredSubmenuItem: ({ index }) =>
			model.submenu === null || model.submenu.highlighted === index
				? { model }
				: {
						model: { ...model, submenu: { ...model.submenu, highlighted: index } },
						commands: [FocusMenuItem({ id: subItemId(model.id, index) })],
					},
		ClickedSubmenuItem: ({ value }) =>
			model.submenu === null
				? { model }
				: closeWith(model, OutMessage.SelectedSubmenuItem({ submenu: model.submenu.value, value })),
		CompletedFocusMenuItem: () => ({ model }),
		CompletedMountMenu: () => ({ model }),
		CompletedMountSubmenu: () => ({ model }),
		ChangedPlacement: ({ side, align }) => ({ model: { ...model, side, align } }),
		ChangedSubmenuPlacement: ({ side, align }) => ({
			model: model.submenu === null ? model : { ...model, submenu: { ...model.submenu, side, align } },
		}),
		GotAnimationMessage: ({ message: animationMessage }) =>
			transition.foldAnimation(model, animationMessage),
		GotItemTooltipMessage: ({ message: inner, side }) => {
			const next = Tooltip.update({ ...model.itemTooltip, requestedSide: side }, inner)
			return {
				model: { ...model, itemTooltip: next.model },
				commands: Command.mapMessages(next.commands ?? [], (tooltipMessage) =>
					Message.GotItemTooltipMessage({ message: tooltipMessage, side }),
				),
			}
		},
	})

// MOUNT

/** The modal backdrop leaves the trigger uncovered, so the trigger keeps its hover state. */
const cutOutTrigger = (positioner: HTMLElement, anchorId: string): void => {
	const backdrop = positioner.previousElementSibling
	const anchor = positioner.ownerDocument.getElementById(anchorId)
	if (!(backdrop instanceof HTMLElement) || anchor === null) return
	const { left, top, right, bottom } = anchor.getBoundingClientRect()
	backdrop.style.clipPath = `polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%, ${left}px ${top}px, ${left}px ${bottom}px, ${right}px ${bottom}px, ${right}px ${top}px, ${left}px ${top}px)`
}

/** Portal, scroll lock, focus on the menu (or its highlighted item), placement under the trigger. */
export const MountMenu = Mount.defineStream("MountMenu", {
	args: { id: Schema.String, side: Side, align: Align, sideOffset: Schema.Number },
	messages: [Message.CompletedMountMenu, Message.ChangedPlacement, Message.PressedOutside],
	execute: ({ element, id, side, align, sideOffset }) =>
		anchoredPopup(element, {
			positionerSelector: ":scope > [data-side]",
			popupSelector: `#${CSS.escape(popupId(id))}`,
			config: {
				...positionDefaults,
				anchor: { _tag: "Element", id: triggerId(id) },
				side,
				align,
				sideOffset,
				fallbackAxisSide: "none",
			},
			insideSelectors: [`#${CSS.escape(triggerId(id))}`, `#${CSS.escape(subPortalId(id))}`],
			markOutside: Option.some({ mark: true, ariaHidden: false }),
			lockScroll: true,
			focus: Option.some({ returnFocusId: Option.some(triggerId(id)), initialFocus: "highlighted" }),
			afterPlace: (positioner) => cutOutTrigger(positioner, triggerId(id)),
		}).pipe(
			Stream.map((event) =>
				event._tag === "Mounted"
					? Message.CompletedMountMenu()
					: event._tag === "Placed"
						? Message.ChangedPlacement({ side: event.placed.side, align: event.placed.align })
						: Message.PressedOutside(),
			),
		),
})

/** `<DropdownMenuSubContent>`: beside its trigger item (offset 0, -3), free to flip to any side. */
export const MountSubmenu = Mount.defineStream("MountSubmenu", {
	args: { id: Schema.String, index: Schema.Number },
	messages: [Message.CompletedMountSubmenu, Message.ChangedSubmenuPlacement],
	execute: ({ element, id, index }) =>
		anchoredPopup(element, {
			positionerSelector: ":scope > [data-side]",
			popupSelector: `#${CSS.escape(subPopupId(id))}`,
			config: {
				...positionDefaults,
				anchor: { _tag: "Element", id: itemId(id, index) },
				side: "right",
				align: "start",
				alignOffset: -3,
			},
			insideSelectors: [],
			markOutside: Option.none(),
			lockScroll: false,
			focus: Option.none(),
		}).pipe(
			Stream.filter((event) => event._tag !== "PressedOutside"),
			Stream.map((event) =>
				event._tag === "Placed"
					? Message.ChangedSubmenuPlacement({ side: event.placed.side, align: event.placed.align })
					: Message.CompletedMountSubmenu(),
			),
		),
})
