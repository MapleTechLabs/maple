import { cn } from "@maple/ui/lib/utils"
import {
	selectGroupLabelStyles,
	selectItemIndicatorIconStyles,
	selectItemIndicatorStyles,
	selectItemStyles,
	selectItemTextStyles,
	selectListStyles,
	selectPopupStyles,
	selectPopupSurfaceStyles,
	selectPositionerStyles,
	selectSeparatorStyles,
	selectTriggerIconClassName,
	selectTriggerVariants,
	selectValueStyles,
} from "@maple/ui/styles/ui/select"
import { Array, Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { checkIcon, chevronExpandYIcon } from "./overlay/icons"
import { portalId, triggerId } from "./overlay/popup-state"
import { isRovingKey, nextIndex } from "./overlay/roving"
import { focusGuard, isMounted, SR_ONLY_STYLE, stateAttributes } from "./overlay/transition"
import { itemId, listId, Message, type Model, MountSelect } from "./select"

export type SelectOption = Readonly<{ value: string; label: string }>

/** What the list shows: groups with a label, separators and loose items, in order. */
export type SelectEntry =
	| Readonly<{ _tag: "Group"; label: string; items: ReadonlyArray<SelectOption> }>
	| Readonly<{ _tag: "Separator" }>
	| Readonly<{ _tag: "Item"; item: SelectOption }>

export type ViewInputs = Readonly<{
	/** Places the trigger and, while open, its guards, hidden input and portal (siblings in Base UI). */
	toView: (parts: ReadonlyArray<Html>) => Html
	entries: ReadonlyArray<SelectEntry>
	ariaLabel: string
	className?: string
}>

type H = HtmlBuilder<Message>

/** The options in list order: their index is the highlight and focus index. */
export const optionsOf = (entries: ReadonlyArray<SelectEntry>): ReadonlyArray<SelectOption> =>
	Array.flatMap(entries, (entry) =>
		entry._tag === "Group" ? entry.items : entry._tag === "Item" ? [entry.item] : [],
	)

export const selectedIndexOf = (entries: ReadonlyArray<SelectEntry>, value: string): number | null =>
	Option.getOrNull(Array.findFirstIndex(optionsOf(entries), (option) => option.value === value))

const option = (h: H, model: Model, item: SelectOption, index: number): Html => {
	const isSelected = item.value === model.value
	const isHighlighted = model.highlighted === index
	return h.div(
		[
			h.AriaSelected(isSelected),
			h.Class(cn(selectItemStyles)),
			...(isHighlighted ? [h.DataAttribute("highlighted", "")] : []),
			...(isSelected ? [h.DataAttribute("selected", "")] : []),
			h.DataAttribute("slot", "select-item"),
			h.Id(itemId(model.id, index)),
			h.Role("option"),
			h.Tabindex(isHighlighted ? 0 : -1),
			h.OnMouseMove(Message.HoveredItem({ index })),
			h.OnClick(Message.SelectedItem({ index, value: item.value })),
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
							[checkIcon(h, selectItemIndicatorIconStyles)],
						),
					]
				: []),
			h.div([h.Class(selectItemTextStyles)], [item.label]),
		],
	)
}

/** Groups, separators and options, numbering options in list order as they render. */
const listChildren = (h: H, model: Model, entries: ReadonlyArray<SelectEntry>): ReadonlyArray<Html> =>
	Array.mapAccum(entries, 0, (start, entry, entryIndex): [number, Html] => {
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
				return [start + 1, option(h, model, entry.item, start)]
			case "Group": {
				const labelId = `${model.id}-group-${entryIndex}`
				return [
					start + entry.items.length,
					h.div(
						[h.AriaLabelledBy(labelId), h.DataAttribute("slot", "select-group"), h.Role("group")],
						[
							h.div(
								[
									h.AriaHidden(true),
									h.Class(selectGroupLabelStyles),
									h.DataAttribute("slot", "select-group-label"),
									h.Id(labelId),
								],
								[entry.label],
							),
							...entry.items.map((item, offset) => option(h, model, item, start + offset)),
						],
					),
				]
			}
		}
	})[1]

/** Arrows and Home/End move the highlight with focus; Enter and Space select; Escape closes. */
const listKeys = (h: H, model: Model, options: ReadonlyArray<SelectOption>) =>
	h.OnKeyDownFocus((key) => {
		const focusTrigger = `#${CSS.escape(triggerId(model.id))}`
		if (isRovingKey(key)) {
			return Option.map(
				nextIndex(
					options.map(() => true),
					model.highlighted,
					key,
				),
				(index) => ({
					focusSelector: `#${CSS.escape(itemId(model.id, index))}`,
					message: Message.HighlightedItem({ index }),
				}),
			)
		}
		if (key === "Escape")
			return Option.some({ focusSelector: focusTrigger, message: Message.PressedEscape() })
		if ((key === "Enter" || key === " ") && model.highlighted !== null) {
			const index = model.highlighted
			return Option.map(Array.get(options, index), (item) => ({
				focusSelector: focusTrigger,
				message: Message.SelectedItem({ index, value: item.value }),
			}))
		}
		return Option.none()
	})

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
				h.Role("presentation"),
				h.Style({ position: "fixed", inset: "0px", userSelect: "none" }),
			]),
			h.div(
				[
					h.Class(selectPositionerStyles),
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
							h.Id(`${model.id}-popup`),
							h.Role("presentation"),
							h.Tabindex(-1),
							listKeys(h, model, optionsOf(inputs.entries)),
						],
						[
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
										listChildren(h, model, inputs.entries),
									),
								],
							),
						],
					),
					focusGuard(h, "inside"),
				],
			),
		],
	)
}

/** `<SelectTrigger><SelectValue /></SelectTrigger>` and, while open, its guards and portal. */
export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const options = optionsOf(inputs.entries)
	const selected = Array.findFirst(options, (item) => item.value === model.value)
	const isVisible = isMounted(model.isOpen, model.animation)
	const trigger = h.button(
		[
			h.Key("trigger"),
			...(isVisible ? [h.AriaControls(listId(model.id))] : []),
			h.AriaExpanded(model.isOpen),
			h.AriaHasPopup("listbox"),
			h.AriaLabel(inputs.ariaLabel),
			h.Class(cn(selectTriggerVariants({ size: "default" }), inputs.className)),
			...(model.isOpen ? [h.DataAttribute("popup-open", "")] : []),
			h.DataAttribute("popup-side", model.side),
			...(model.isOpen ? [h.DataAttribute("pressed", "")] : []),
			h.DataAttribute("slot", "select-trigger"),
			h.Id(triggerId(model.id)),
			h.Role("combobox"),
			h.Tabindex(0),
			h.Type("button"),
			h.OnClick(
				Message.ClickedTrigger({ selectedIndex: selectedIndexOf(inputs.entries, model.value) }),
			),
		],
		[
			h.span(
				[h.Class(selectValueStyles), h.DataAttribute("slot", "select-value")],
				[Option.match(selected, { onNone: () => "", onSome: (item) => item.label })],
			),
			h.span(
				[
					h.AriaHidden(true),
					...(model.isOpen ? [h.DataAttribute("popup-open", "")] : []),
					h.DataAttribute("slot", "select-icon"),
				],
				[chevronExpandYIcon(h, selectTriggerIconClassName)],
			),
		],
	)
	const hiddenInput = h.input([
		h.Key("hidden-input"),
		h.AriaHidden(true),
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
