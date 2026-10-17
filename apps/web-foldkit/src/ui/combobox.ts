import * as Animation from "@foldkit/ui/animation"
import { Array, Option, Schema, Stream } from "effect"
import { Mount, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { anchoredPopup } from "./overlay/anchored"
import { initPopup, makeTransition, PopupState } from "./overlay/popup-state"
import { Align, positionDefaults, Side } from "./overlay/position"
import { isRovingKey, nextIndex } from "./overlay/roving"

/**
 * Base UI `Combobox` (multiple, with chips) and `Autocomplete` (`@maple/ui/combobox`,
 * `@maple/ui/autocomplete`): an input that filters a listbox. Focus stays in the input; the
 * highlighted option is its `aria-activedescendant`. The views are in `combobox-view.ts`.
 */

// MODEL

export const Mode = Schema.Literals(["multiple", "autocomplete"])
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
	inputValue: "",
	highlighted: options.autoHighlight === true ? 0 : null,
	selected: options.selected ?? [],
	autoHighlight: options.autoHighlight ?? false,
})

/** Base UI's default filter: a case-insensitive "contains" on the option's label. */
export const filterItems = (items: ReadonlyArray<string>, query: string): ReadonlyArray<string> =>
	query.trim() === ""
		? items
		: Array.filter(items, (item) => item.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))

// MESSAGE

export const Message = defineMessageUnion({
	ChangedInput: { value: Schema.String },
	ClickedInput: {},
	HighlightedItem: { index: Schema.NullOr(Schema.Number) },
	PressedInputKey: { key: Schema.String, values: Schema.Array(Schema.String) },
	ClickedItem: { value: Schema.String },
	RemovedChip: { value: Schema.String },
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

/** A multiple combobox toggles the value and stays open; an autocomplete fills the input and closes. */
const pick = (model: Model, value: string): UpdateReturn => {
	if (model.mode === "multiple") {
		const selected = toggle(model.selected, value)
		return {
			model: { ...model, selected, inputValue: "" },
			outMessage: OutMessage.ChangedSelection({ selected }),
		}
	}
	return {
		...transition.close({ ...model, inputValue: value, highlighted: null }),
		outMessage: OutMessage.ChangedValue({ value }),
	}
}

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		ChangedInput: ({ value }) =>
			transition.open({ ...model, inputValue: value, highlighted: model.autoHighlight ? 0 : null }),
		ClickedInput: () => transition.open(model),
		HighlightedItem: ({ index }) => ({ model: { ...model, highlighted: index } }),
		PressedInputKey: ({ key, values }) => {
			if (key === "Escape") return transition.close({ ...model, highlighted: null })
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
		PressedEscape: () => transition.close({ ...model, highlighted: null }),
		PressedOutside: () => transition.close({ ...model, highlighted: null }),
		CompletedMountCombobox: () => ({ model }),
		ChangedPlacement: ({ side, align }) => ({ model: { ...model, side, align } }),
		GotAnimationMessage: ({ message: animationMessage }) =>
			transition.foldAnimation(model, animationMessage),
	})

// MOUNT

/** Portal, inert marker and placement under the anchor (the chips field or the input group). */
export const MountCombobox = Mount.defineStream("MountCombobox", {
	args: { slot: Schema.String, anchorSelector: Schema.String },
	messages: [Message.CompletedMountCombobox, Message.ChangedPlacement, Message.PressedOutside],
	execute: ({ element, slot, anchorSelector }) =>
		anchoredPopup(element, {
			positionerSelector: `[data-slot=${slot}-positioner]`,
			popupSelector: `[data-slot=${slot}-popup]`,
			config: {
				...positionDefaults,
				anchor: { _tag: "Selector", selector: anchorSelector },
				side: "bottom",
				align: "start",
				sideOffset: 4,
				fallbackAxisSide: "none",
			},
			insideSelectors: [anchorSelector],
			markOutside: Option.some({ mark: true, ariaHidden: true, keep: [anchorSelector] }),
			lockScroll: false,
			focus: Option.none(),
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
		),
})
