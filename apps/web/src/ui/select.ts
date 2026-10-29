import { Array, Effect, Function, Layer, Option, Queue, Schema, Stream } from "effect"
import { Block, Dom, Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { anchoredPopup } from "./overlay/anchored"
import { initPopup, PopupState, PopupTransitionBlock, triggerId } from "./overlay/popup-state"
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

export type InitOptions = Readonly<{ value: string; selectedIndex: number | null; isOpen?: boolean }>

/** `<Select defaultValue defaultOpen>`; `selectedIndex` is the value's index among the items. */
const initialModel = (id: string, options: InitOptions): Model => ({
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
	/** The parent's value changed outside the Select (a reset or a synced form state). */
	InformedOfValue: { value: Schema.String },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ ChangedValue: { value: Schema.String } })
export type OutMessage = typeof OutMessage.Type

export const SelectDefinition = Block.makeDefinition("Select", { Model, Message, OutMessage })

export const FocusSelectItem = SelectDefinition.makeCommand("FocusSelectItem", {
	args: { id: Schema.String },
	messages: [Message.CompletedFocusSelectItem],
	handler: function* () {
		return ({ id }) =>
			Dom.focus(`#${CSS.escape(id)}`).pipe(Effect.ignore, Effect.as(Message.CompletedFocusSelectItem()))
	},
})

// The exit wait runs inside PopupTransitionBlock; `initialModel` builds the animation field.
const AnimationBinding = SelectDefinition.makeBinding(PopupTransitionBlock, { field: "animation", init: false })

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
const mountSelect = (element: Element, id: string): Stream.Stream<MountMessage> => {
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
}

export const MountSelect = SelectDefinition.makeMountStream("MountSelect", {
	args: { id: Schema.String },
	messages: [
		Message.CompletedMountSelect,
		Message.ChangedPlacement,
		Message.ChangedScrollArrows,
		Message.PressedOutside,
	],
	handler: function* () {
		return ({ element, id }) => mountSelect(element, id)
	},
})

/** The handlers this Block owns (the animation's come with its Binding); pass to `prepareBlock`. */
export const EffectsLayer = Layer.mergeAll(FocusSelectItem.layer, MountSelect.layer)

// COMPOSITION

export const SelectComposition = SelectDefinition.makeComposition({
	bindings: [AnimationBinding],
	mounts: [MountSelect],
})
export type SelectViewBuilder = Block.ViewBuilderFor<typeof SelectComposition>

// INIT

export const init = SelectComposition.makeInit((id: string, options: InitOptions) => ({
	model: initialModel(id, options),
}))

// UPDATE

const { makeStep, makeNoopStep, makeFieldsStep } = SelectDefinition

const openStep = makeStep((model) =>
	model.isOpen
		? makeNoopStep()
		: Update.combineSteps([makeFieldsStep(() => ({ isOpen: () => true })), AnimationBinding.requestShow()]),
)

const closeStep = makeStep((model) =>
	model.isOpen
		? Update.combineSteps([makeFieldsStep(() => ({ isOpen: () => false })), AnimationBinding.requestHide()])
		: makeNoopStep(),
)

/** The highlight moves in `update`, from the current Model, with focus following it. */
const highlighting = (index: number) =>
	makeStep((model) => ({
		model: { ...model, highlighted: index },
		commands: [FocusSelectItem({ id: itemId(model.id, index) })],
	}))

const selecting = (value: string) =>
	makeStep(() =>
		Function.compose(
			Update.combineSteps([makeFieldsStep(() => ({ value: () => value })), closeStep]),
			Update.withOutMessage(OutMessage.ChangedValue({ value })),
		),
	)

const openingAt = (selectedIndex: number | null) =>
	makeStep(() =>
		Update.combineSteps([
			makeFieldsStep(() => ({
				highlighted: () => selectedIndex,
				isAlignedWithTrigger: () => true,
				scrollArrows: () => ({ up: false, down: false }),
			})),
			openStep,
		]),
	)

const pressingListKey = (key: string, values: ReadonlyArray<string>) =>
	makeStep((model) => {
		if (key === "Escape") return closeStep
		if (isRovingKey(key)) {
			return Option.match(
				nextIndex(
					values.map(() => true),
					model.highlighted,
					key,
				),
				{ onNone: () => makeNoopStep(), onSome: highlighting },
			)
		}
		return Option.match(
			Option.flatMap(Option.fromNullishOr(model.highlighted), (index) => Array.get(values, index)),
			{ onNone: () => makeNoopStep(), onSome: selecting },
		)
	})

export const update = SelectComposition.makeUpdate({
	// `focusItemOnOpen: "auto"`: a pointer open highlights nothing until an item is hovered.
	ClickedTrigger: (model) => (model.isOpen ? closeStep(model) : openingAt(null)(model)),
	PressedEscape: closeStep,
	PressedOutside: closeStep,
	PressedTriggerKey: (model, { selectedIndex }) =>
		model.isOpen ? makeNoopStep()(model) : openingAt(selectedIndex)(model),
	PressedListKey: (model, { key, values }) => pressingListKey(key, values)(model),
	HoveredItem: (model, { index }) =>
		model.highlighted === index ? makeNoopStep()(model) : highlighting(index)(model),
	SelectedItem: (model, { value }) => selecting(value)(model),
	CompletedFocusSelectItem: makeNoopStep(),
	CompletedMountSelect: makeNoopStep(),
	ChangedPlacement: (model, { side, align, isAlignedWithTrigger }) => ({
		model: { ...model, side, align, isAlignedWithTrigger },
	}),
	ChangedScrollArrows: (model, { up, down }) =>
		model.scrollArrows.up === up && model.scrollArrows.down === down
			? { model }
			: { model: { ...model, scrollArrows: { up, down } } },
	InformedOfValue: (model, { value }) => ({ model: { ...model, value } }),
})
