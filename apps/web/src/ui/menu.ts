import { Array, Duration, Effect, Function, Layer, Number, Option, Schema, Stream } from "effect"
import { Block, Dom, Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { anchoredPopup } from "./overlay/anchored"
import { initPopup, PopupState, PopupTransitionBlock, popupId, triggerId } from "./overlay/popup-state"
import { Align, positionDefaults, Side } from "./overlay/position"
import { isRovingKey, nextIndex } from "./overlay/roving"
import * as Tooltip from "./tooltip"

/**
 * Base UI `Menu` (`@maple/ui/dropdown-menu`): the trigger toggles it; arrows move the highlight,
 * Enter or a click picks an item, a checkbox or radio item stays open, a submenu opens on
 * hover (100 ms) or ArrowRight and closes on ArrowLeft; Escape and a press outside close it.
 * `menu-view.ts` renders it from the `dropdown-menu.ts` parts and completes `MenuBlock`.
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
	itemTooltip: Tooltip.TooltipBlock.Model,
})
export type Model = typeof Model.Type

export const SUBMENU_DELAY = Duration.millis(100)

export const itemId = (id: string, index: number): string => `${id}-item-${index}`
export const subItemId = (id: string, index: number): string => `${id}-sub-item-${index}`
export const subPopupId = (id: string): string => `${id}-sub-popup`
export const subPortalId = (id: string): string => `${id}-sub-portal`
export const itemTooltipId = (id: string): string => `${id}-item-tooltip`
export const itemTooltipTriggerId = (id: string, index: number): string => `${id}-item-${index}-tooltip`

export type InitOptions = Readonly<{ isOpen?: boolean }>

/** `<DropdownMenuContent>`'s defaults: below the trigger, start-aligned. */
const initialModel = (id: string, options: InitOptions = {}): Model => ({
	...initPopup(id, { isOpen: options.isOpen ?? false, side: "bottom", align: "start" }),
	highlighted: null,
	submenu: null,
	submenuGeneration: 0,
	itemTooltip: Tooltip.TooltipBlock.init(itemTooltipId(id), { side: "left" }).model,
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
	/** A parent closes the menu (a radio pick that should not keep it open). */
	RequestedClose: {},
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

// DEFINITION

export const MenuDefinition = Block.makeDefinition("Menu", { Model, Message, OutMessage })
const { makeStep, makeNoopStep, makeFieldsStep, makeOutMessageStep } = MenuDefinition

// The exit wait runs inside PopupTransitionBlock; `initialModel` builds the animation field.
const AnimationBinding = MenuDefinition.makeBinding(PopupTransitionBlock, { field: "animation", init: false })

/** The disabled-item tooltip; `initialModel` builds it, a close resets it. */
export const ItemTooltipBinding = MenuDefinition.makeBinding(Tooltip.TooltipBlock, {
	field: "itemTooltip",
	init: false,
})

// COMMAND

/** A highlight moves focus to the item, as Base UI's menu does. */
export const FocusMenuItem = MenuDefinition.makeCommand("FocusMenuItem", {
	args: { id: Schema.String },
	messages: [Message.CompletedFocusMenuItem],
	handler: function* () {
		return ({ id }) =>
			Dom.focus(`#${CSS.escape(id)}`).pipe(Effect.ignore, Effect.as(Message.CompletedFocusMenuItem()))
	},
})

/** The submenu trigger's hover delay; a newer hover bumps the generation and drops this one. */
export const WaitSubmenuDelay = MenuDefinition.makeCommand("WaitSubmenuDelay", {
	args: { generation: Schema.Number, index: Schema.Number, value: Schema.String },
	messages: [Message.ElapsedSubmenuDelay],
	handler: function* () {
		return (args) => Effect.sleep(SUBMENU_DELAY).pipe(Effect.as(Message.ElapsedSubmenuDelay(args)))
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
export const MountMenu = MenuDefinition.makeMountStream("MountMenu", {
	args: { id: Schema.String, side: Side, align: Align, sideOffset: Schema.Number },
	messages: [Message.CompletedMountMenu, Message.ChangedPlacement, Message.PressedOutside],
	handler: function* () {
		return ({ element, id, side, align, sideOffset }) =>
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
				focus: Option.some({
					returnFocusId: Option.some(triggerId(id)),
					initialFocus: "highlighted",
				}),
				afterPlace: (positioner) => cutOutTrigger(positioner, triggerId(id)),
			}).pipe(
				Stream.map((event) =>
					event._tag === "Mounted"
						? Message.CompletedMountMenu()
						: event._tag === "Placed"
							? Message.ChangedPlacement({ side: event.placed.side, align: event.placed.align })
							: Message.PressedOutside(),
				),
			)
	},
})

/** `<DropdownMenuSubContent>`: beside its trigger item (offset 0, -3), free to flip to any side. */
export const MountSubmenu = MenuDefinition.makeMountStream("MountSubmenu", {
	args: { id: Schema.String, index: Schema.Number },
	messages: [Message.CompletedMountSubmenu, Message.ChangedSubmenuPlacement],
	handler: function* () {
		return ({ element, id, index }) =>
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
						? Message.ChangedSubmenuPlacement({
								side: event.placed.side,
								align: event.placed.align,
							})
						: Message.CompletedMountSubmenu(),
				),
			)
	},
})

/** The handlers this Block owns (the Bindings bring their own); pass to `prepareBlock`. */
export const EffectsLayer = Layer.mergeAll(
	FocusMenuItem.layer,
	WaitSubmenuDelay.layer,
	MountMenu.layer,
	MountSubmenu.layer,
)

// COMPOSITION

export const MenuComposition = MenuDefinition.makeComposition({
	bindings: [AnimationBinding, ItemTooltipBinding],
	mounts: [MountMenu, MountSubmenu],
})
export type MenuViewBuilder = Block.ViewBuilderFor<typeof MenuComposition>

// INIT

export const init = MenuComposition.makeInit((id: string, options: InitOptions = {}) => ({
	model: initialModel(id, options),
}))

// UPDATE

const openStep = makeStep((model) =>
	model.isOpen
		? makeNoopStep()
		: Update.combineSteps([
				makeFieldsStep(() => ({ isOpen: () => true })),
				AnimationBinding.requestShow(),
			]),
)

const closeStep = makeStep((model) =>
	model.isOpen
		? Update.combineSteps([
				makeFieldsStep(() => ({ isOpen: () => false })),
				AnimationBinding.requestHide(),
			])
		: makeNoopStep(),
)

/** A close also drops the highlight, the submenu (and a pending hover) and the item tooltip. */
const closingStep = Update.combineSteps([
	ItemTooltipBinding.requestReset(),
	makeFieldsStep(() => ({
		highlighted: () => null,
		submenu: () => null,
		submenuGeneration: Number.increment,
	})),
	closeStep,
])

const closingWith = (outMessage: OutMessage) =>
	makeStep(() => Function.compose(closingStep, Update.withOutMessage(outMessage)))

/** The highlight moves in `update`, from the current Model, so fast keystrokes never reuse a stale one. */
const highlighting = (index: number) =>
	makeStep((model) => ({
		model: { ...model, highlighted: index },
		commands: [FocusMenuItem({ id: itemId(model.id, index) })],
	}))

const highlightingAfterSubmenu = (index: number) =>
	Update.combineSteps([makeFieldsStep(() => ({ submenu: () => null })), highlighting(index)])

const highlightingSubItem = (index: number) =>
	makeStep((model) =>
		model.submenu === null
			? { model }
			: {
					model: { ...model, submenu: { ...model.submenu, highlighted: index } },
					commands: [FocusMenuItem({ id: subItemId(model.id, index) })],
				},
	)

const openingSubmenu = (index: number, value: string, isKeyboard: boolean) =>
	makeStep((model) => {
		const submenu: Submenu = {
			index,
			value,
			side: "right",
			align: "start",
			highlighted: isKeyboard ? 0 : null,
		}
		return {
			model: {
				...model,
				highlighted: index,
				submenu,
				submenuGeneration: Number.increment(model.submenuGeneration),
			},
			commands: isKeyboard ? [FocusMenuItem({ id: subItemId(model.id, 0) })] : [],
		}
	})

const activating = (index: number, item: ItemRef, isKeyboard: boolean) =>
	makeStep(() => {
		if (item.isDisabled === true) return makeNoopStep()
		switch (item.kind) {
			case "Item":
				return closingWith(OutMessage.SelectedItem({ value: item.value }))
			case "Submenu":
				return openingSubmenu(index, item.value, isKeyboard)
			case "Checkbox":
				return makeOutMessageStep(() => OutMessage.ToggledCheckbox({ value: item.value }))
			case "Radio":
				return makeOutMessageStep(() => OutMessage.SelectedRadio({ value: item.value }))
		}
	})

const allEnabled = (count: number): ReadonlyArray<boolean> => Array.makeBy(count, () => true)

/** Opens with a highlight (keyboard) or none (pointer); the Mount focuses the highlighted item. */
const openingAt = (highlighted: number | null) =>
	Update.combineSteps([
		makeFieldsStep(() => ({ highlighted: () => highlighted, submenu: () => null })),
		openStep,
	])

const pressingMenuKey = (key: string, items: ReadonlyArray<ItemRef>) =>
	makeStep((model) => {
		if (key === "Escape") return closingStep
		if (isRovingKey(key)) {
			return Option.match(nextIndex(allEnabled(items.length), model.highlighted, key), {
				onNone: () => makeNoopStep(),
				onSome: highlightingAfterSubmenu,
			})
		}
		const highlighted = model.highlighted
		const current = highlighted === null ? undefined : items[highlighted]
		if (highlighted === null || current === undefined) return makeNoopStep()
		if (key === "ArrowRight") {
			return current.kind === "Submenu"
				? openingSubmenu(highlighted, current.value, true)
				: makeNoopStep()
		}
		return key === "Enter" || key === " " ? activating(highlighted, current, true) : makeNoopStep()
	})

const pressingSubmenuKey = (key: string, values: ReadonlyArray<string | null>) =>
	makeStep((model) => {
		const submenu = model.submenu
		if (submenu === null) return makeNoopStep()
		if (key === "Escape") return closingStep
		if (key === "ArrowLeft") return highlightingAfterSubmenu(submenu.index)
		if (isRovingKey(key)) {
			return Option.match(nextIndex(allEnabled(values.length), submenu.highlighted, key), {
				onNone: () => makeNoopStep(),
				onSome: highlightingSubItem,
			})
		}
		const value = submenu.highlighted === null ? undefined : values[submenu.highlighted]
		return (key === "Enter" || key === " ") && value !== undefined && value !== null
			? closingWith(OutMessage.SelectedSubmenuItem({ submenu: submenu.value, value }))
			: makeNoopStep()
	})

const waitingSubmenu = (generation: number, index: number, value: string) =>
	makeStep((model) => ({ model, commands: [WaitSubmenuDelay({ generation, index, value })] }))

/** Hovering a submenu trigger schedules its submenu; hovering any other item closes it. */
const hoveringItem = (index: number, item: ItemRef) =>
	makeStep((model) => {
		if (model.highlighted === index && (item.kind !== "Submenu" || model.submenu !== null))
			return makeNoopStep()
		const generation = Number.increment(model.submenuGeneration)
		const submenu = model.submenu !== null && model.submenu.index === index ? model.submenu : null
		const next = Update.combineSteps([
			makeFieldsStep(() => ({ submenu: () => submenu, submenuGeneration: () => generation })),
			highlighting(index),
		])
		return item.kind === "Submenu" && submenu === null
			? Update.combineSteps([next, waitingSubmenu(generation, index, item.value)])
			: next
	})

export const update = MenuComposition.makeUpdate({
	ClickedTrigger: (model) => (model.isOpen ? closingStep(model) : openingAt(null)(model)),
	PressedTriggerKey: (model, { key, count }) =>
		key === "ArrowDown"
			? openingAt(0)(model)
			: key === "ArrowUp"
				? openingAt(count - 1)(model)
				: makeNoopStep()(model),
	PressedOutside: closingStep,
	PressedMenuKey: (model, { key, items }) => pressingMenuKey(key, items)(model),
	HoveredItem: (model, { index, item }) => hoveringItem(index, item)(model),
	ClickedItem: (model, { index, item }) => activating(index, item, false)(model),
	LeftMenu: (model) => (model.submenu === null ? { model: { ...model, highlighted: null } } : { model }),
	ElapsedSubmenuDelay: (model, { generation, index, value }) =>
		generation === model.submenuGeneration && model.isOpen
			? openingSubmenu(index, value, false)(model)
			: makeNoopStep()(model),
	PressedSubmenuKey: (model, { key, values }) => pressingSubmenuKey(key, values)(model),
	HoveredSubmenuItem: (model, { index }) =>
		model.submenu === null || model.submenu.highlighted === index
			? makeNoopStep()(model)
			: highlightingSubItem(index)(model),
	ClickedSubmenuItem: (model, { value }) =>
		model.submenu === null
			? makeNoopStep()(model)
			: closingWith(OutMessage.SelectedSubmenuItem({ submenu: model.submenu.value, value }))(model),
	CompletedFocusMenuItem: makeNoopStep(),
	CompletedMountMenu: makeNoopStep(),
	CompletedMountSubmenu: makeNoopStep(),
	ChangedPlacement: (model, { side, align }) => ({ model: { ...model, side, align } }),
	ChangedSubmenuPlacement: (model, { side, align }) => ({
		model: model.submenu === null ? model : { ...model, submenu: { ...model.submenu, side, align } },
	}),
	RequestedClose: closingStep,
})
