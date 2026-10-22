import * as Animation from "@foldkit/ui/animation"
import { Array, Effect, Option, Schema, Stream } from "effect"
import { Mount, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { anchoredPopup } from "./overlay/anchored"
import { containEscape } from "./overlay/portal"
import { initPopup, makeTransition, PopupState } from "./overlay/popup-state"
import { Align, positionDefaults, Side } from "./overlay/position"
import { isRovingKey, nextIndex } from "./overlay/roving"

/**
 * Base UI `Combobox` (multiple, with chips) and `Autocomplete` (`@maple/ui/combobox`,
 * `@maple/ui/autocomplete`): an input that filters a listbox. Focus stays in the input; the
 * highlighted option is its `aria-activedescendant`. The views are in `combobox-view.ts`.
 */

// MODEL

export const Mode = Schema.Literals(["single", "multiple", "autocomplete"])
export type Mode = typeof Mode.Type

export const Model = Schema.Struct({
	...PopupState.fields,
	mode: Mode,
	inputValue: Schema.String,
	highlighted: Schema.NullOr(Schema.Number),
	selected: Schema.Array(Schema.String),
	/** `autoHighlight="always"` (the command palette): the first match stays highlighted. */
	autoHighlight: Schema.Boolean,
})
export type Model = typeof Model.Type

export const inputId = (id: string): string => `${id}-input`
export const listId = (id: string): string => `${id}-list`
export const itemId = (id: string, index: number): string => `${inputId(id)}-${index}`

export const init = (
	id: string,
	mode: Mode,
	options: Readonly<{ selected?: ReadonlyArray<string>; isOpen?: boolean; autoHighlight?: boolean }> = {},
): Model => ({
	...initPopup(id, { isOpen: options.isOpen ?? false, side: "bottom", align: "start" }),
	mode,
	inputValue: mode === "single" ? (options.selected?.[0] ?? "") : "",
	highlighted: options.autoHighlight === true ? 0 : null,
	selected: options.selected ?? [],
	autoHighlight: options.autoHighlight ?? false,
})

/** Base UI's default filter: a case-insensitive "contains" on the option's label. */
export const filterItems = (items: ReadonlyArray<string>, query: string): ReadonlyArray<string> =>
	query.trim() === ""
		? items
		: Array.filter(items, (item) => item.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))

/** The query the list filters by: a single combobox still reading its value shows every item. */
export const queryOf = (model: Model): string =>
	model.mode === "single" && model.inputValue === model.selected[0] ? "" : model.inputValue

/** The items the list shows for the current input. */
export const visibleItems = (model: Model, items: ReadonlyArray<string>): ReadonlyArray<string> =>
	filterItems(items, queryOf(model))

// MESSAGE

export const Message = defineMessageUnion({
	ChangedInput: { value: Schema.String },
	ClickedInput: {},
	ClickedTrigger: {},
	/** A `<ComboboxTrigger>` opening its popup list: the selected value starts highlighted. */
	ClickedTriggerOf: { items: Schema.Array(Schema.String) },
	/** An input click on a single combobox that opens on its selected value, highlighted. */
	ClickedInputOf: { items: Schema.Array(Schema.String), selected: Schema.NullOr(Schema.String) },
	HighlightedItem: { index: Schema.NullOr(Schema.Number) },
	/** `items` unfiltered: `update` filters by the current input, so a key typed in the same frame counts. */
	PressedInputKey: {
		key: Schema.String,
		items: Schema.Array(Schema.String),
		/** The list shows every item whatever is typed (see `SingleViewInputs.isUnfiltered`). */
		isUnfiltered: Schema.optional(Schema.Boolean),
	},
	ClickedItem: { value: Schema.String },
	RemovedChip: { value: Schema.String },
	/** `MultiSelectCombobox`'s clear button: `onValueChange([])`. */
	ClearedSelection: {},
	PressedEscape: {},
	PressedOutside: {},
	CompletedMountCombobox: {},
	ChangedPlacement: { side: Side, align: Align },
	GotAnimationMessage: { message: Animation.Message },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
	ChangedSelection: { selected: Schema.Array(Schema.String) },
	ChangedValue: { value: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

// UPDATE

const transition = makeTransition<Model, Message>(
	(message) => Message.GotAnimationMessage({ message }),
	"WaitForComboboxExit",
)
export const WaitForComboboxExit = transition.WaitForExit

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>

const toggle = (selected: ReadonlyArray<string>, value: string): ReadonlyArray<string> =>
	selected.includes(value) ? Array.filter(selected, (item) => item !== value) : [...selected, value]

/** Closing a single combobox puts its value back in the input. */
const closed = (model: Model): UpdateReturn =>
	transition.close({
		...model,
		highlighted: null,
		inputValue: model.mode === "single" ? (model.selected[0] ?? "") : model.inputValue,
	})

/**
 * A multiple combobox toggles the value and stays open; a single one selects it, an autocomplete
 * fills the input, and both close.
 */
const pick = (model: Model, value: string): UpdateReturn => {
	if (model.mode === "multiple") {
		const selected = toggle(model.selected, value)
		return {
			model: { ...model, selected, inputValue: "" },
			outMessage: OutMessage.ChangedSelection({ selected }),
		}
	}
	const selected = model.mode === "single" ? [value] : model.selected
	return {
		...transition.close({ ...model, selected, inputValue: value, highlighted: null }),
		outMessage: OutMessage.ChangedValue({ value }),
	}
}

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		ChangedInput: ({ value }) =>
			transition.open({ ...model, inputValue: value, highlighted: model.autoHighlight ? 0 : null }),
		ClickedInput: () => transition.open(model),
		ClickedTrigger: () => (model.isOpen ? closed(model) : transition.open(model)),
		ClickedInputOf: ({ items, selected }) => {
			if (model.isOpen) return { model }
			const index = selected === null ? -1 : items.indexOf(selected)
			return transition.open({ ...model, highlighted: index === -1 ? null : index })
		},
		ClickedTriggerOf: ({ items }) => {
			if (model.isOpen) return closed(model)
			const index = model.selected[0] === undefined ? -1 : items.indexOf(model.selected[0])
			return transition.open({ ...model, inputValue: "", highlighted: index === -1 ? null : index })
		},
		HighlightedItem: ({ index }) => ({ model: { ...model, highlighted: index } }),
		PressedInputKey: ({ key, items, isUnfiltered }) => {
			const values = isUnfiltered === true ? items : visibleItems(model, items)
			if (key === "Escape") return closed(model)
			if (isRovingKey(key)) {
				const next = nextIndex(
					values.map(() => true),
					model.highlighted,
					key,
				)
				return { model: { ...model, highlighted: Option.getOrNull(next) } }
			}
			return Option.match(
				Option.flatMap(Option.fromNullishOr(model.highlighted), (index) => Array.get(values, index)),
				{ onNone: () => ({ model }), onSome: (value) => pick(model, value) },
			)
		},
		ClickedItem: ({ value }) => pick(model, value),
		RemovedChip: ({ value }) => {
			const selected = Array.filter(model.selected, (item) => item !== value)
			return { model: { ...model, selected }, outMessage: OutMessage.ChangedSelection({ selected }) }
		},
		ClearedSelection: () => ({
			model: { ...model, selected: [] },
			outMessage: OutMessage.ChangedSelection({ selected: [] }),
		}),
		PressedEscape: () => closed(model),
		PressedOutside: () => closed(model),
		CompletedMountCombobox: () => ({ model }),
		ChangedPlacement: ({ side, align }) => ({ model: { ...model, side, align } }),
		GotAnimationMessage: ({ message: animationMessage }) =>
			transition.foldAnimation(model, animationMessage),
	})

// MOUNT

/** Portal, inert marker and placement under the anchor (the chips field or the input group). */
export const MountCombobox = Mount.defineStream("MountCombobox", {
	args: {
		slot: Schema.String,
		anchorSelector: Schema.String,
		/** Where the popup is placed when not under `anchorSelector` (which still counts as inside). */
		positionSelector: Schema.optional(Schema.String),
		/** A `<ComboboxTrigger>`: focus moves into the popup and returns to this id on close. */
		returnFocusId: Schema.optional(Schema.String),
		sideOffset: Schema.optional(Schema.Number),
	},
	messages: [Message.CompletedMountCombobox, Message.ChangedPlacement, Message.PressedOutside],
	execute: ({ element, slot, anchorSelector, positionSelector, returnFocusId, sideOffset }) =>
		anchoredPopup(element, {
			positionerSelector: `[data-slot=${slot}-positioner]`,
			popupSelector: `[data-slot=${slot}-popup]`,
			config: {
				...positionDefaults,
				anchor: { _tag: "Selector", selector: positionSelector ?? anchorSelector },
				side: "bottom",
				align: "start",
				sideOffset: sideOffset ?? 4,
				fallbackAxisSide: "none",
				// `ComboboxPositioner` passes `lazyFlip: true`: a flipped list keeps its side while open.
				lazyFlip: true,
			},
			insideSelectors: [anchorSelector],
			markOutside: Option.some({ mark: true, ariaHidden: true, keep: [anchorSelector] }),
			lockScroll: false,
			focus:
				returnFocusId === undefined
					? Option.none()
					: Option.some({
							returnFocusId: Option.some(returnFocusId),
							initialFocus: "first-tabbable",
						}),
		}).pipe(
			Stream.map((event) => {
				switch (event._tag) {
					case "Mounted":
						return Message.CompletedMountCombobox()
					case "Placed":
						return Message.ChangedPlacement({
							side: event.placed.side,
							align: event.placed.align,
						})
					case "PressedOutside":
						return Message.PressedOutside()
				}
			}),
			Stream.merge(escapeContained(anchorSelector)),
		),
})

/** While the list is open, Escape in the input closes it and stops short of an enclosing dialog. */
const escapeContained = (anchorSelector: string): Stream.Stream<never> =>
	Stream.callback<never>(() =>
		Option.match(Option.fromNullishOr(document.querySelector(anchorSelector)), {
			onNone: () => Effect.never,
			onSome: (anchor) => containEscape(anchor).pipe(Effect.andThen(Effect.never)),
		}),
	)
