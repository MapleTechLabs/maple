import { cn } from "@maple/ui/lib/utils"
import {
	dropdownMenuContentStyles,
	dropdownMenuPositionerStyles,
	dropdownMenuSubContentStyles,
} from "@maple/ui/styles/ui/dropdown-menu"
import { Array, Option } from "effect"
import { Submodel } from "foldkit"
import { type ChildAttribute, childAttributes, type Html, type HtmlBuilder } from "foldkit/html"
import {
	menuCheckableItem,
	menuGroup,
	menuItem,
	menuLabel,
	menuRadioGroup,
	menuSeparator,
	menuShortcut,
	menuSubTrigger,
} from "./dropdown-menu"
import {
	type ItemRef,
	itemId,
	Message,
	type Model,
	MountMenu,
	MountSubmenu,
	subItemId,
	subPopupId,
	subPortalId,
} from "./menu"
import { popupId, portalId, triggerId } from "./overlay/popup-state"
import type { Align, Side } from "./overlay/position"
import { focusGuard, isMounted, SR_ONLY_STYLE, stateAttributes } from "./overlay/transition"

// ENTRIES

export type MenuItemEntry = Readonly<{
	_tag: "Item"
	value: string
	label: string
	shortcut?: string
	variant?: "default" | "destructive"
}>

/** The menu's content, as data: `update` addresses highlightable entries by document order. */
export type MenuEntry =
	| MenuItemEntry
	| Readonly<{ _tag: "Group"; label?: string; entries: ReadonlyArray<MenuEntry> }>
	| Readonly<{ _tag: "Submenu"; value: string; label: string; entries: ReadonlyArray<MenuItemEntry> }>
	| Readonly<{ _tag: "Checkbox"; value: string; label: string; isChecked: boolean }>
	| Readonly<{
			_tag: "RadioGroup"
			/** `<DropdownMenuLabel>` inside the radio group (`Menu.GroupLabel`). */
			label?: string
			items: ReadonlyArray<Readonly<{ value: string; label: string; isChecked: boolean }>>
	  }>
	| Readonly<{ _tag: "Separator" }>

/** The highlightable entries in document order. */
export const itemRefs = (entries: ReadonlyArray<MenuEntry>): ReadonlyArray<ItemRef> =>
	entries.flatMap((entry): ReadonlyArray<ItemRef> => {
		switch (entry._tag) {
			case "Item":
				return [{ kind: "Item", value: entry.value }]
			case "Submenu":
				return [{ kind: "Submenu", value: entry.value }]
			case "Checkbox":
				return [{ kind: "Checkbox", value: entry.value }]
			case "RadioGroup":
				return entry.items.map((item) => ({ kind: "Radio", value: item.value }))
			case "Group":
				return itemRefs(entry.entries)
			case "Separator":
				return []
		}
	})

export type ViewInputs = Readonly<{
	entries: ReadonlyArray<MenuEntry>
	/** `<DropdownMenuContent className side align sideOffset>`. */
	className?: string
	side?: Side
	align?: Align
	sideOffset?: number
	/** `trigger` goes on the parent's button; `withTrigger(button)` adds Base UI's guards and the portal. */
	toView: (
		render: Readonly<{
			trigger: ReadonlyArray<ChildAttribute>
			withTrigger: (button: Html) => ReadonlyArray<Html>
		}>,
	) => Html
}>

type H = HtmlBuilder<Message>

const countOf = (entry: MenuEntry): number => itemRefs([entry]).length

const ROOT_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End", "Enter", " ", "Escape", "ArrowRight"])
const SUBMENU_KEYS = new Set([...ROOT_KEYS, "ArrowLeft"])

const shortcutOf = (h: H, entry: MenuItemEntry): ReadonlyArray<Html> =>
	entry.shortcut === undefined ? [] : [menuShortcut(h, [entry.shortcut])]

const renderEntries = (
	h: H,
	model: Model,
	entries: ReadonlyArray<MenuEntry>,
	start: number,
): ReadonlyArray<Html> => {
	const offsets = Array.scan(entries, start, (index, entry) => index + countOf(entry))
	return entries.map((entry, position) => renderEntry(h, model, entry, offsets[position] ?? start))
}

const row = (model: Model, index: number, item: ItemRef) => ({
	id: itemId(model.id, index),
	isHighlighted: model.highlighted === index,
	onHighlight: Message.HoveredItem({ index, item }),
	onSelect: Message.ClickedItem({ index, item }),
})

const renderEntry = (h: H, model: Model, entry: MenuEntry, index: number): Html => {
	switch (entry._tag) {
		case "Item":
			return menuItem(
				h,
				{ ...row(model, index, { kind: "Item", value: entry.value }), variant: entry.variant },
				[entry.label, ...shortcutOf(h, entry)],
			)
		case "Group": {
			const labelId = `${model.id}-group-${index}`
			return menuGroup(h, entry.label === undefined ? undefined : labelId, [
				...(entry.label === undefined ? [] : [menuLabel(h, labelId, [entry.label])]),
				...renderEntries(h, model, entry.entries, index),
			])
		}
		case "Submenu":
			return menuSubTrigger(
				h,
				{
					...row(model, index, { kind: "Submenu", value: entry.value }),
					isSubmenuOpen: model.submenu !== null && model.submenu.index === index,
				},
				[entry.label],
			)
		case "Checkbox":
			return menuCheckableItem(
				h,
				{
					...row(model, index, { kind: "Checkbox", value: entry.value }),
					kind: "checkbox",
					isChecked: entry.isChecked,
				},
				[entry.label],
			)
		case "RadioGroup": {
			const labelId = entry.label === undefined ? undefined : `${model.id}-group-${index}`
			return menuRadioGroup(
				h,
				[
					...(entry.label === undefined || labelId === undefined
						? []
						: [menuLabel(h, labelId, [entry.label])]),
					...entry.items.map((item, offset) =>
						menuCheckableItem(
							h,
							{
								...row(model, index + offset, { kind: "Radio", value: item.value }),
								kind: "radio",
								isChecked: item.isChecked,
							},
							[item.label],
						),
					),
				],
				labelId,
			)
		}
		case "Separator":
			return menuSeparator(h)
	}
}

/** The submenu entry with this value, at any depth. */
const findSubmenu = (
	entries: ReadonlyArray<MenuEntry>,
	value: string,
): Option.Option<ReadonlyArray<MenuItemEntry>> =>
	Array.findFirst(entries, (entry) =>
		entry._tag === "Submenu" && entry.value === value
			? Option.some(entry.entries)
			: entry._tag === "Group"
				? findSubmenu(entry.entries, value)
				: Option.none(),
	)

const keyHandler = (h: H, keys: ReadonlySet<string>, toMessage: (key: string) => Message) =>
	h.OnKeyDownPreventDefault((key) => (keys.has(key) ? Option.some(toMessage(key)) : Option.none()))

const submenuPortal = (h: H, model: Model, inputs: ViewInputs): ReadonlyArray<Html> => {
	const submenu = model.submenu
	if (submenu === null) return []
	const items = Option.getOrElse(findSubmenu(inputs.entries, submenu.value), () => [])
	const placement = [
		h.DataAttribute("align", submenu.align),
		h.DataAttribute("open", ""),
		h.DataAttribute("side", submenu.side),
	]
	return [
		h.div(
			[
				h.Key(subPortalId(model.id)),
				h.DataAttribute("base-ui-portal", ""),
				h.Id(subPortalId(model.id)),
				h.OnMount(MountSubmenu({ id: model.id, index: submenu.index })),
			],
			[
				h.div(
					[h.Class(dropdownMenuPositionerStyles), ...placement, h.Role("presentation")],
					[
						h.div(
							[
								h.AriaLabelledBy(itemId(model.id, submenu.index)),
								h.Class(cn(dropdownMenuContentStyles, dropdownMenuSubContentStyles)),
								...placement,
								h.DataAttribute("base-ui-focusable", ""),
								h.DataAttribute("slot", "dropdown-menu-sub-content"),
								h.Id(subPopupId(model.id)),
								h.Role("menu"),
								h.Tabindex(-1),
								keyHandler(h, SUBMENU_KEYS, (key) =>
									Message.PressedSubmenuKey({
										key,
										values: items.map((item) => item.value),
									}),
								),
							],
							items.map((item, index) =>
								menuItem(
									h,
									{
										id: subItemId(model.id, index),
										variant: item.variant,
										isHighlighted: submenu.highlighted === index,
										onHighlight: Message.HoveredSubmenuItem({ index }),
										onSelect: Message.ClickedSubmenuItem({ value: item.value }),
									},
									[item.label, ...shortcutOf(h, item)],
								),
							),
						),
					],
				),
			],
		),
	]
}

const portal = (h: H, model: Model, inputs: ViewInputs): Html => {
	const state = stateAttributes(h, model.isOpen, model.animation)
	const placement = [h.DataAttribute("align", model.align), ...state, h.DataAttribute("side", model.side)]
	const refs = itemRefs(inputs.entries)
	return h.div(
		[
			h.Key(portalId(model.id)),
			h.DataAttribute("base-ui-portal", ""),
			h.Id(portalId(model.id)),
			h.OnMount(
				MountMenu({
					id: model.id,
					side: inputs.side ?? "bottom",
					align: inputs.align ?? "start",
					sideOffset: inputs.sideOffset ?? 4,
				}),
			),
		],
		[
			h.div([
				h.DataAttribute("base-ui-inert", ""),
				h.Role("presentation"),
				h.Style({ position: "fixed", inset: "0px", userSelect: "none" }),
				h.OnClick(Message.PressedOutside()),
			]),
			h.div(
				[h.Class(dropdownMenuPositionerStyles), ...placement, h.Role("presentation")],
				[
					focusGuard(h, "inside"),
					h.div(
						[
							h.AriaLabelledBy(triggerId(model.id)),
							h.Class(cn(dropdownMenuContentStyles, inputs.className)),
							...placement,
							h.DataAttribute("base-ui-focusable", ""),
							h.DataAttribute("rootownerid", `${model.id}-root`),
							h.DataAttribute("slot", "dropdown-menu-content"),
							h.Id(popupId(model.id)),
							h.Role("menu"),
							h.Tabindex(-1),
							keyHandler(h, ROOT_KEYS, (key) => Message.PressedMenuKey({ key, items: refs })),
							h.OnMouseLeave(Message.LeftMenu()),
						],
						renderEntries(h, model, inputs.entries, 0),
					),
					focusGuard(h, "inside"),
				],
			),
			...submenuPortal(h, model, inputs),
		],
	)
}

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const isVisible = isMounted(model.isOpen, model.animation)
	const count = itemRefs(inputs.entries).length
	const trigger = childAttributes([
		...(isVisible ? [h.AriaControls(popupId(model.id))] : []),
		h.AriaExpanded(model.isOpen),
		h.AriaHasPopup("menu"),
		...(model.isOpen ? [h.DataAttribute("popup-open", ""), h.DataAttribute("pressed", "")] : []),
		h.DataAttribute("slot", "dropdown-menu-trigger"),
		h.Id(triggerId(model.id)),
		h.OnClick(Message.ClickedTrigger()),
		keyHandler(h, new Set(["ArrowDown", "ArrowUp"]), (key) => Message.PressedTriggerKey({ key, count })),
	])
	// Built here, not inside `withTrigger`: handlers bind to the boundary rendering them.
	const openPortal = isVisible ? portal(h, model, inputs) : null
	const withTrigger = (button: Html): ReadonlyArray<Html> =>
		openPortal !== null
			? [
					focusGuard(h, undefined, [h.Key("guard-before")]),
					button,
					focusGuard(h, undefined, [h.Key("guard-after")]),
					focusGuard(h, "outside", [h.Key("guard-outside-before")]),
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
					focusGuard(h, "outside", [h.Key("guard-outside-after")]),
					openPortal,
				]
			: [button]
	return inputs.toView({ trigger, withTrigger })
})
