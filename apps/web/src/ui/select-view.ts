import { cn } from "@maple/ui/lib/utils"
import {
	selectGroupLabelStyles,
	selectLabelStyles,
	selectItemIndicatorIconStyles,
	selectItemIndicatorStyles,
	selectItemStyles,
	selectItemTextStyles,
	selectListStyles,
	selectPopupStyles,
	selectPopupSurfaceStyles,
	selectPositionerStyles,
	selectScrollDownArrowIconStyles,
	selectScrollDownArrowStyles,
	selectScrollUpArrowIconStyles,
	selectScrollUpArrowStyles,
	selectSeparatorStyles,
	selectTriggerIconClassName,
	selectTriggerVariants,
	selectValueStyles,
} from "@maple/ui/styles/ui/select"
import { Array, Option } from "effect"
import { Block } from "foldkit"
import type { Html } from "foldkit/html"
import { icon } from "./icon"
import { portalId, triggerId } from "./overlay/popup-state"
import { focusGuard, isMounted, SR_ONLY_STYLE, stateAttributes } from "./overlay/transition"
import {
	EffectsLayer,
	init,
	itemId,
	listId,
	Message,
	type Model,
	MountSelect,
	SelectComposition,
	type SelectViewBuilder,
	update,
} from "./select"

/** `isDisabled`: `<SelectItem disabled>`, listed but not choosable. */
export type SelectOption = Readonly<{ value: string; label: string; isDisabled?: boolean; title?: string }>

/** What the list shows: groups with a label, separators and loose items, in order. */
export type SelectEntry =
	| Readonly<{
			_tag: "Group"
			label: string
			items: ReadonlyArray<SelectOption>
			/** `<SelectLabel>` in the group (not `SelectGroupLabel`): it labels the Select, not the group. */
			isSelectLabel?: boolean
	  }>
	| Readonly<{ _tag: "Separator" }>
	| Readonly<{ _tag: "Item"; item: SelectOption }>

export type ViewInputs = Readonly<{
	/** Places the trigger and, while open, its guards, hidden input and portal (siblings in Base UI). */
	toView: (parts: ReadonlyArray<Html>) => Html
	entries: ReadonlyArray<SelectEntry>
	/** Omit when the trigger is named by its value alone, as a bare `<SelectTrigger>` is. */
	ariaLabel?: string
	/** Inside a Base UI field: the field label (and description) that name the trigger. */
	labelledBy?: string
	describedBy?: string
	/** `<SelectTrigger size>`. */
	size?: "sm" | "default" | "lg"
	className?: string
	/** `<SelectValue>`'s render function: the trigger's content for the value, listed or not. */
	renderValue?: (value: string) => ReadonlyArray<Html | string>
	/** A `<SelectItem>`'s children when they are more than its label. */
	renderItem?: (option: SelectOption) => ReadonlyArray<Html | string>
	/** `<SelectTrigger>` children placed before `<SelectValue>` (an icon). */
	leading?: ReadonlyArray<Html>
	/** `<Select disabled>`: the trigger and hidden input are disabled and out of the tab order. */
	isDisabled?: boolean
}>

type H = SelectViewBuilder

/** The options in list order: their index is the highlight and focus index. */
export const optionsOf = (entries: ReadonlyArray<SelectEntry>): ReadonlyArray<SelectOption> =>
	Array.flatMap(entries, (entry) =>
		entry._tag === "Group" ? entry.items : entry._tag === "Item" ? [entry.item] : [],
	)

/** Base UI's `Select.Label` id: every `<SelectLabel>` renders it, and it names the trigger. */
export const selectLabelId = (id: string): string => `${id}-label`

export const selectedIndexOf = (entries: ReadonlyArray<SelectEntry>, value: string): number | null =>
	Option.getOrNull(Array.findFirstIndex(optionsOf(entries), (option) => option.value === value))

const option = (h: H, model: Model, inputs: ViewInputs, item: SelectOption, index: number): Html => {
	const isSelected = item.value === model.value
	const isDisabled = item.isDisabled ?? false
	const isHighlighted = model.highlighted === index
	return h.div(
		[
			h.AriaSelected(isSelected),
			...(isDisabled ? [h.AriaDisabled(true)] : []),
			h.Class(cn(selectItemStyles)),
			...(isDisabled ? [h.DataAttribute("disabled", "")] : []),
			...(isHighlighted ? [h.DataAttribute("highlighted", "")] : []),
			...(isSelected ? [h.DataAttribute("selected", "")] : []),
			h.DataAttribute("slot", "select-item"),
			h.Id(itemId(model.id, index)),
			h.Role("option"),
			h.Tabindex(isHighlighted ? 0 : -1),
			...(item.title === undefined ? [] : [h.Title(item.title)]),
			...(isDisabled
				? []
				: [
						h.OnMouseMove(Message.HoveredItem({ index })),
						h.OnClick(Message.SelectedItem({ index, value: item.value })),
					]),
		],
		[
			...(isSelected
				? [
						h.span(
							[
								h.AriaHidden(true),
								h.Class(selectItemIndicatorStyles),
								h.DataAttribute("selected", ""),
							],
							[icon(h, "CheckIcon", { className: selectItemIndicatorIconStyles })],
						),
					]
				: []),
			h.div([h.Class(selectItemTextStyles)], inputs.renderItem?.(item) ?? [item.label]),
		],
	)
}

/** Groups, separators and options, numbering options in list order as they render. */
const listChildren = (h: H, model: Model, inputs: ViewInputs): ReadonlyArray<Html> =>
	Array.mapAccum(inputs.entries, 0, (start, entry, entryIndex): [number, Html] => {
		switch (entry._tag) {
			case "Separator":
				return [
					start,
					h.div([
						h.Class(selectSeparatorStyles),
						h.DataAttribute("orientation", "horizontal"),
						h.DataAttribute("slot", "select-separator"),
						h.Role("presentation"),
					]),
				]
			case "Item":
				return [start + 1, option(h, model, inputs, entry.item, start)]
			case "Group": {
				const labelId = `${model.id}-group-${entryIndex}`
				const isSelectLabel = entry.isSelectLabel ?? false
				return [
					start + entry.items.length,
					h.div(
						[
							...(isSelectLabel ? [] : [h.AriaLabelledBy(labelId)]),
							h.DataAttribute("slot", "select-group"),
							h.Role("group"),
						],
						[
							isSelectLabel
								? h.div(
										[
											h.Class(selectLabelStyles),
											h.DataAttribute("slot", "select-label"),
											h.Id(selectLabelId(model.id)),
										],
										[entry.label],
									)
								: h.div(
										[
											h.AriaHidden(true),
											h.Class(selectGroupLabelStyles),
											h.DataAttribute("slot", "select-group-label"),
											h.Id(labelId),
										],
										[entry.label],
									),
							...entry.items.map((item, offset) =>
								option(h, model, inputs, item, start + offset),
							),
						],
					),
				]
			}
		}
	})[1]

const LIST_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End", "Enter", " ", "Escape"])

/** List keys go to `update` with the options in order: arrows, Home/End, Enter/Space, Escape. */
const listKeys = (h: H, options: ReadonlyArray<SelectOption>) =>
	h.OnKeyDownPreventDefault((key) =>
		LIST_KEYS.has(key)
			? Option.some(Message.PressedListKey({ key, values: options.map((item) => item.value) }))
			: Option.none(),
	)

const TRIGGER_KEYS = new Set(["ArrowDown", "ArrowUp", "Enter", " "])

/** `SelectScrollUpArrow` / `SelectScrollDownArrow`, while the list can scroll that way. */
const scrollArrow = (h: H, model: Model, direction: "up" | "down"): Html =>
	h.div(
		[
			h.AriaHidden(true),
			h.Class(direction === "up" ? selectScrollUpArrowStyles : selectScrollDownArrowStyles),
			h.DataAttribute("direction", direction),
			h.DataAttribute("side", model.isAlignedWithTrigger ? "none" : model.side),
			h.DataAttribute("slot", `select-scroll-${direction}-arrow`),
			h.DataAttribute("visible", ""),
			h.Style({ position: "absolute" }),
		],
		[
			icon(h, direction === "up" ? "ChevronUpIcon" : "ChevronDownIcon", {
				className:
					direction === "up" ? selectScrollUpArrowIconStyles : selectScrollDownArrowIconStyles,
			}),
		],
	)

const portal = (h: H, model: Model, inputs: ViewInputs): Html => {
	const state = stateAttributes(h, model.isOpen, model.animation)
	const placement = [
		h.DataAttribute("align", model.align),
		...state,
		h.DataAttribute("side", model.isAlignedWithTrigger ? "none" : model.side),
	]
	return h.div(
		[
			h.Key(portalId(model.id)),
			h.DataAttribute("base-ui-portal", ""),
			h.Id(portalId(model.id)),
			h.OnMount(MountSelect({ id: model.id })),
		],
		[
			h.div([
				h.DataAttribute("base-ui-inert", ""),
				// Base UI's `inert: !open`: a closing menu lets the pointer reach the page at once.
				...(model.isOpen ? [] : [h.Inert(true)]),
				h.Role("presentation"),
				h.Style({ position: "fixed", inset: "0px", userSelect: "none" }),
			]),
			h.div(
				[
					h.Class(cn(selectPositionerStyles, !model.isOpen && "pointer-events-none")),
					...placement,
					h.DataAttribute("slot", "select-positioner"),
					h.Role("presentation"),
				],
				[
					focusGuard(h, "inside"),
					h.div(
						[
							h.Class(selectPopupStyles),
							h.DataAttribute("align", model.align),
							h.DataAttribute("base-ui-focusable", ""),
							...state,
							h.DataAttribute("side", model.isAlignedWithTrigger ? "none" : model.side),
							h.DataAttribute("slot", "select-popup"),
							listKeys(h, optionsOf(inputs.entries)),
							h.Id(`${model.id}-popup`),
							h.Role("presentation"),
							h.Tabindex(-1),
						],
						[
							...(model.scrollArrows.up ? [scrollArrow(h, model, "up")] : []),
							h.div(
								[h.Class(selectPopupSurfaceStyles)],
								[
									h.div(
										[
											h.Class(`${cn(selectListStyles)} base-ui-disable-scrollbar`),
											h.DataAttribute("slot", "select-list"),
											h.Id(listId(model.id)),
											h.Role("listbox"),
											h.Style({
												position: "relative",
												maxHeight: "100%",
												overflow: "hidden auto",
											}),
										],
										listChildren(h, model, inputs),
									),
								],
							),
							...(model.scrollArrows.down ? [scrollArrow(h, model, "down")] : []),
						],
					),
					focusGuard(h, "inside"),
				],
			),
		],
	)
}

/** `<SelectTrigger><SelectValue /></SelectTrigger>` and, while open, its guards and portal. */
export const view = SelectComposition.makeView.withInputs<ViewInputs>((model, inputs, h) => {
	const options = optionsOf(inputs.entries)
	const selected = Array.findFirst(options, (item) => item.value === model.value)
	const isVisible = isMounted(model.isOpen, model.animation)
	const isDisabled = inputs.isDisabled ?? false
	const trigger = h.button(
		[
			h.Key("trigger"),
			...(isVisible ? [h.AriaControls(listId(model.id))] : []),
			h.AriaExpanded(model.isOpen),
			h.AriaHasPopup("listbox"),
			...(inputs.ariaLabel === undefined ? [] : [h.AriaLabel(inputs.ariaLabel)]),
			...(inputs.labelledBy === undefined ? [] : [h.AriaLabelledBy(inputs.labelledBy)]),
			...(inputs.describedBy === undefined ? [] : [h.AriaDescribedBy(inputs.describedBy)]),
			h.Class(cn(selectTriggerVariants({ size: inputs.size ?? "default" }), inputs.className)),
			...(isDisabled ? [h.DataAttribute("disabled", ""), h.Disabled(true)] : []),
			...(model.isOpen ? [h.DataAttribute("popup-open", "")] : []),
			...(isDisabled ? [] : [h.DataAttribute("popup-side", model.side)]),
			...(model.isOpen ? [h.DataAttribute("pressed", "")] : []),
			h.DataAttribute("slot", "select-trigger"),
			h.Id(triggerId(model.id)),
			h.Role("combobox"),
			h.Tabindex(isDisabled ? -1 : 0),
			h.Type("button"),
			h.OnClick(
				Message.ClickedTrigger({ selectedIndex: selectedIndexOf(inputs.entries, model.value) }),
			),
			h.OnKeyDownPreventDefault((key) =>
				TRIGGER_KEYS.has(key)
					? Option.some(
							Message.PressedTriggerKey({
								key,
								selectedIndex: selectedIndexOf(inputs.entries, model.value),
							}),
						)
					: Option.none(),
			),
		],
		[
			...(inputs.leading ?? []),
			h.span(
				[h.Class(selectValueStyles), h.DataAttribute("slot", "select-value")],
				inputs.renderValue?.(model.value) ??
					Option.match(selected, { onNone: () => [""], onSome: (item) => [item.label] }),
			),
			h.span(
				[
					h.AriaHidden(true),
					...(model.isOpen ? [h.DataAttribute("popup-open", "")] : []),
					h.DataAttribute("slot", "select-icon"),
				],
				[icon(h, "ChevronExpandYIcon", { className: selectTriggerIconClassName })],
			),
		],
	)
	const hiddenInput = h.input([
		h.Key("hidden-input"),
		h.AriaHidden(true),
		...(isDisabled ? [h.Disabled(true)] : []),
		h.Id(`${triggerId(model.id)}-hidden-input`),
		h.Style(SR_ONLY_STYLE),
		h.Tabindex(-1),
		h.Value(model.value),
	])
	return inputs.toView(
		isVisible
			? [
					trigger,
					focusGuard(h, "outside", [h.Key("guard-before")]),
					h.span([
						h.Key("owner"),
						h.AriaOwns(portalId(model.id)),
						h.Style({
							clipPath: SR_ONLY_STYLE.clipPath,
							position: "fixed",
							top: "0px",
							left: "0px",
						}),
					]),
					focusGuard(h, "outside", [h.Key("guard-after")]),
					hiddenInput,
					portal(h, model, inputs),
				]
			: [trigger, hiddenInput],
	)
})

// BLOCK

const prepare = () =>
	SelectComposition.prepareBlock({
		init,
		update,
		view,
		operations: { informValue: Message.InformedOfValue },
		EffectsLayer,
	})
export const SelectBlock: Block.FromAssemblyWithViewAndOutMessage<typeof Model, typeof prepare> =
	Block.assemble(prepare)
