import { Array, Effect, Function, Option, Schema, Stream } from "effect"
import { Block, Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { anchoredPopup } from "./overlay/anchored"
import { containEscape } from "./overlay/portal"
import { initPopup, PopupState, PopupTransitionBlock } from "./overlay/popup-state"
import { Align, positionDefaults, Side } from "./overlay/position"
import { isRovingKey, nextIndex } from "./overlay/roving"

/**
 * Base UI `Combobox` (multiple, with chips) and `Autocomplete` (`@maple/ui/combobox`,
 * `@maple/ui/autocomplete`): an input that filters a listbox. Focus stays in the input; the
 * highlighted option is its `aria-activedescendant`. The views and `ComboboxBlock` are in
 * `combobox-view.ts`.
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

export type InitOptions = Readonly<{
	selected?: ReadonlyArray<string>
	isOpen?: boolean
	autoHighlight?: boolean
}>

const initialModel = (id: string, mode: Mode, options: InitOptions): Model => ({
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
	/** Operation: open the list (no-op while open). */
	RequestedOpen: {},
	/** Operation: close the list as Escape does (a single combobox's input reads its value again). */
	RequestedClose: {},
	/** Operation: the fields of a fresh `init` on `selected` (same id and mode); an open list closes
	 *  through its exit transition. */
	RequestedReset: { selected: Schema.Array(Schema.String) },
	/** Operation: the parent set the value (a route or form change); no OutMessage. */
	InformedOfValue: { selected: Schema.Array(Schema.String), inputValue: Schema.String },
	/** Operation: the parent set the input text alone. */
	InformedOfInput: { value: Schema.String },
	/** Operation: drop the highlighted option. */
	RequestedClearHighlight: {},
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
	ChangedSelection: { selected: Schema.Array(Schema.String) },
	ChangedValue: { value: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

export const ComboboxDefinition = Block.makeDefinition("Combobox", { Model, Message, OutMessage })

/** The popup's enter/exit transition; `initialModel` builds the field, so no Binding init. */
const AnimationBinding = ComboboxDefinition.makeBinding(PopupTransitionBlock, {
	field: "animation",
	init: false,
})

// MOUNT

/** Portal, inert marker and placement under the anchor (the chips field or the input group). */
export const MountCombobox = ComboboxDefinition.makeMountStream("MountCombobox", {
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
	handler: function* () {
		return ({ element, slot, anchorSelector, positionSelector, returnFocusId, sideOffset }) =>
			mountStream(element, { slot, anchorSelector, positionSelector, returnFocusId, sideOffset })
	},
})

type MountArgs = Readonly<{
	slot: string
	anchorSelector: string
	positionSelector?: string
	returnFocusId?: string
	sideOffset?: number
}>

const mountStream = (
	element: Element,
	{ slot, anchorSelector, positionSelector, returnFocusId, sideOffset }: MountArgs,
) =>
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
				: Option.some({ returnFocusId: Option.some(returnFocusId), initialFocus: "first-tabbable" }),
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
	)

/** While the list is open, Escape in the input closes it and stops short of an enclosing dialog. */
const escapeContained = (anchorSelector: string): Stream.Stream<never> =>
	Stream.callback<never>(() =>
		Option.match(Option.fromNullishOr(document.querySelector(anchorSelector)), {
			onNone: () => Effect.never,
			onSome: (anchor) => containEscape(anchor).pipe(Effect.andThen(Effect.never)),
		}),
	)

// COMPOSITION

export const ComboboxComposition = ComboboxDefinition.makeComposition({
	bindings: [AnimationBinding],
	mounts: [MountCombobox],
})
export type ComboboxViewBuilder = Block.ViewBuilderFor<typeof ComboboxComposition>

// INIT

export const init = ComboboxComposition.makeInit((id: string, mode: Mode, options: InitOptions = {}) => ({
	model: initialModel(id, mode, options),
}))

// UPDATE

const { makeStep, makeNoopStep, makeFieldsStep } = ComboboxDefinition

const toggle = (selected: ReadonlyArray<string>, value: string): ReadonlyArray<string> =>
	selected.includes(value) ? Array.filter(selected, (item) => item !== value) : [...selected, value]

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

/** Closing a single combobox puts its value back in the input. */
const closedStep = Update.combineSteps([
	makeFieldsStep((model) => ({
		highlighted: () => null,
		inputValue: () => (model.mode === "single" ? (model.selected[0] ?? "") : model.inputValue),
	})),
	closeStep,
])

/** Sets `highlighted`, then opens. */
const openHighlightingStep = (highlighted: number | null) =>
	Update.combineSteps([makeFieldsStep(() => ({ highlighted: () => highlighted })), openStep])

const indexOrNull = (items: ReadonlyArray<string>, value: string | null | undefined): number | null => {
	const index = value === null || value === undefined ? -1 : items.indexOf(value)
	return index === -1 ? null : index
}

/**
 * A multiple combobox toggles the value and stays open; a single one selects it, an autocomplete
 * fills the input, and both close.
 */
const pickStep = makeStep((model, value: string) => {
	if (model.mode === "multiple") {
		const selected = toggle(model.selected, value)
		return makeStep(() => ({
			model: modifyFields(model, { selected: () => selected, inputValue: () => "" }),
			outMessage: OutMessage.ChangedSelection({ selected }),
		}))
	}
	const selected = model.mode === "single" ? [value] : model.selected
	return makeStep(() =>
		Function.compose(
			Update.combineSteps([
				makeFieldsStep(() => ({
					selected: () => selected,
					inputValue: () => value,
					highlighted: () => null,
				})),
				closeStep,
			]),
			Update.withOutMessage(OutMessage.ChangedValue({ value })),
		),
	)
})

export const update = ComboboxComposition.makeUpdate({
	ChangedInput: (model, { value }) =>
		Update.combineSteps([
			makeFieldsStep(() => ({
				inputValue: () => value,
				highlighted: () => (model.autoHighlight ? 0 : null),
			})),
			openStep,
		])(model),
	ClickedInput: openStep,
	ClickedTrigger: (model) => (model.isOpen ? closedStep(model) : openStep(model)),
	ClickedInputOf: (model, { items, selected }) =>
		model.isOpen ? makeNoopStep()(model) : openHighlightingStep(indexOrNull(items, selected))(model),
	ClickedTriggerOf: (model, { items }) =>
		model.isOpen
			? closedStep(model)
			: Update.combineSteps([
					makeFieldsStep(() => ({
						inputValue: () => "",
						highlighted: () => indexOrNull(items, model.selected[0]),
					})),
					openStep,
				])(model),
	HighlightedItem: (model, { index }) => ({ model: modifyFields(model, { highlighted: () => index }) }),
	PressedInputKey: (model, { key, items, isUnfiltered }) => {
		const values = isUnfiltered === true ? items : visibleItems(model, items)
		if (key === "Escape") return closedStep(model)
		if (isRovingKey(key)) {
			const next = nextIndex(
				values.map(() => true),
				model.highlighted,
				key,
			)
			return makeFieldsStep(() => ({ highlighted: () => Option.getOrNull(next) }))(model)
		}
		return Option.match(
			Option.flatMap(Option.fromNullishOr(model.highlighted), (index) => Array.get(values, index)),
			{ onNone: () => makeNoopStep()(model), onSome: (value) => pickStep(model, value) },
		)
	},
	ClickedItem: (model, { value }) => pickStep(model, value),
	RemovedChip: (model, { value }) => {
		const selected = Array.filter(model.selected, (item) => item !== value)
		return {
			model: modifyFields(model, { selected: () => selected }),
			outMessage: OutMessage.ChangedSelection({ selected }),
		}
	},
	ClearedSelection: (model) => ({
		model: modifyFields(model, { selected: () => [] }),
		outMessage: OutMessage.ChangedSelection({ selected: [] }),
	}),
	PressedEscape: closedStep,
	PressedOutside: closedStep,
	CompletedMountCombobox: makeNoopStep(),
	ChangedPlacement: (model, { side, align }) => ({
		model: modifyFields(model, { side: () => side, align: () => align }),
	}),
	RequestedOpen: openStep,
	RequestedClose: closedStep,
	RequestedReset: (model, { selected }) =>
		Update.combineSteps([
			makeFieldsStep(() => ({
				inputValue: () => (model.mode === "single" ? (selected[0] ?? "") : ""),
				highlighted: () => (model.autoHighlight ? 0 : null),
				selected: () => selected,
			})),
			closeStep,
		])(model),
	InformedOfValue: (model, { selected, inputValue }) => ({
		model: modifyFields(model, { selected: () => selected, inputValue: () => inputValue }),
	}),
	InformedOfInput: (model, { value }) => ({ model: modifyFields(model, { inputValue: () => value }) }),
	RequestedClearHighlight: (model) => ({ model: modifyFields(model, { highlighted: () => null }) }),
})

/** Parent-initiated transitions; each enters `update`. */
export const operations = {
	requestOpen: Message.RequestedOpen,
	requestClose: Message.RequestedClose,
	requestReset: Message.RequestedReset,
	informOfValue: Message.InformedOfValue,
	informOfInput: Message.InformedOfInput,
	requestClearHighlight: Message.RequestedClearHighlight,
}
