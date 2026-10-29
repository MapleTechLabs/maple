import { cn } from "@maple/ui/lib/utils"
import {
	dropdownMenuContentStyles,
	dropdownMenuPositionerStyles,
	dropdownMenuSubContentStyles,
} from "@maple/ui/styles/ui/dropdown-menu"
import { Array, Option } from "effect"
import { Block } from "foldkit"
import { type ChildAttribute, childAttributes, type Html } from "foldkit/html"
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
	EffectsLayer,
	init,
	type ItemRef,
	ItemTooltipBinding,
	itemId,
	itemTooltipTriggerId,
	MenuComposition,
	type MenuViewBuilder,
	Message,
	Model,
	MountMenu,
	MountSubmenu,
	subItemId,
	subPopupId,
	subPortalId,
	update,
} from "./menu"
import { icon, type IconName } from "./icon"
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
	/** A leading icon (`<DropdownMenuItem><PencilIcon />Edit</DropdownMenuItem>`). */
	icon?: IconName
	/** Base UI's `disabled`: shown, not highlightable or selectable. */
	isDisabled?: boolean
	className?: string
	/** The item's own children (an avatar, a badge), in place of `icon`, `label` and `shortcut`. */
	content?: ReadonlyArray<Html | string>
	/**
	 * A tooltip on a wrapper `div` around the item (`<TooltipTrigger render={<div />}>`): a disabled
	 * item swallows pointer events, so the wrapper takes the hover.
	 */
	tooltip?: Readonly<{ content: ReadonlyArray<Html | string>; side?: Side }>
}>

/** `<DropdownMenuSub>`: its trigger row, then the items of its popup. */
export type MenuSubmenuEntry = Readonly<{
	_tag: "Submenu"
	value: string
	label: string
	entries: ReadonlyArray<MenuItemEntry>
	/** The trigger's own children, in place of `label` (the chevron is always appended). */
	content?: ReadonlyArray<Html | string>
	/** A leading icon on the trigger row. */
	icon?: IconName
	/** A separator drawn after this item's index (`<DropdownMenuSeparator />` between items). */
	separatorAfter?: number
	/** `<DropdownMenuSubContent className>`. */
	className?: string
	/** A `div` with this class around the items (a scroller). */
	itemsClassName?: string
	/** Rows that are not items (loading, an empty notice), shown when there are no entries. */
	placeholder?: ReadonlyArray<Html>
	/** Rows drawn above the items, outside their scroller (a search field). */
	header?: ReadonlyArray<Html>
}>

/** The menu's content, as data: `update` addresses highlightable entries by document order. */
export type MenuEntry =
	| MenuItemEntry
	| Readonly<{
			_tag: "Group"
			label?: string
			/** The label's own children (an avatar and a name), in place of `label`. */
			labelContent?: ReadonlyArray<Html | string>
			entries: ReadonlyArray<MenuEntry>
	  }>
	| MenuSubmenuEntry
	| Readonly<{ _tag: "Checkbox"; value: string; label: string; isChecked: boolean }>
	| Readonly<{
			_tag: "RadioGroup"
			items: ReadonlyArray<
				Readonly<{
					value: string
					label: string
					isChecked: boolean
					hint?: string
					/** The item's own children, in place of `label` and `hint`. */
					content?: ReadonlyArray<Html | string>
				}>
			>
			/** A `DropdownMenuLabel` inside the group, which then names it (`aria-labelledby`). */
			label?: string
			/** Each item's text in its own `<span>` (`<DropdownMenuRadioItem><span>...</span>`). */
			isItemLabelWrapped?: boolean
	  }>
	| Readonly<{ _tag: "Separator" }>
	/** A `DropdownMenuLabel` that is not a group's name (a note after the items). */
	| Readonly<{ _tag: "Label"; label: string; className?: string }>
	/** A plain element inside the popup that is not an item (a heading and a note above them). */
	| Readonly<{ _tag: "Content"; content: Html }>

const itemRefOf = (entry: MenuItemEntry): ItemRef =>
	entry.isDisabled === true
		? { kind: "Item", value: entry.value, isDisabled: true }
		: { kind: "Item", value: entry.value }

/** The highlightable entries in document order. */
export const itemRefs = (entries: ReadonlyArray<MenuEntry>): ReadonlyArray<ItemRef> =>
	entries.flatMap((entry): ReadonlyArray<ItemRef> => {
		switch (entry._tag) {
			case "Item":
				return [itemRefOf(entry)]
			case "Submenu":
				return [{ kind: "Submenu", value: entry.value }]
			case "Checkbox":
				return [{ kind: "Checkbox", value: entry.value }]
			case "RadioGroup":
				return entry.items.map((item) => ({ kind: "Radio", value: item.value }))
			case "Group":
				return itemRefs(entry.entries)
			case "Separator":
			case "Label":
			case "Content":
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

type H = MenuViewBuilder

const countOf = (entry: MenuEntry): number => itemRefs([entry]).length

const ROOT_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End", "Enter", " ", "Escape", "ArrowRight"])
const SUBMENU_KEYS = new Set([...ROOT_KEYS, "ArrowLeft"])

const shortcutOf = (h: H, entry: MenuItemEntry): ReadonlyArray<Html> =>
	entry.shortcut === undefined ? [] : [menuShortcut(h, [entry.shortcut])]

const itemContent = (h: H, entry: MenuItemEntry): ReadonlyArray<Html | string> =>
	entry.content ?? [
		...(entry.icon === undefined ? [] : [icon(h, entry.icon)]),
		entry.label,
		...shortcutOf(h, entry),
	]

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

/** The item inside its tooltip trigger; the tooltip's portal rides along while it is this item's. */
const withItemTooltip = (
	h: H,
	model: Model,
	index: number,
	tooltip: NonNullable<MenuItemEntry["tooltip"]>,
	item: Html,
): Html => {
	const id = itemTooltipTriggerId(model.id, index)
	const side = tooltip.side ?? "left"
	return h.block(
		ItemTooltipBinding.embedView({
			slotId: `${model.id}-item-tooltip-${index}`,
			model: model.itemTooltip,
			viewInputs: {
				triggerIds: [id],
				side,
				toContent: () => tooltip.content,
				toView: ({ trigger, portal }) =>
					h.div(
						[...trigger(id)],
						[item, ...(portal !== null && model.itemTooltip.triggerId === id ? [portal] : [])],
					),
			},
		}),
	)
}

const renderEntry = (h: H, model: Model, entry: MenuEntry, index: number): Html => {
	switch (entry._tag) {
		case "Item": {
			const item = menuItem(
				h,
				{
					...row(model, index, itemRefOf(entry)),
					variant: entry.variant,
					isDisabled: entry.isDisabled,
					className: entry.className,
				},
				itemContent(h, entry),
			)
			return entry.tooltip === undefined ? item : withItemTooltip(h, model, index, entry.tooltip, item)
		}
		case "Group": {
			const labelId = `${model.id}-group-${index}`
			const labelChildren =
				entry.labelContent ?? (entry.label === undefined ? undefined : [entry.label])
			return menuGroup(h, labelChildren === undefined ? undefined : labelId, [
				...(labelChildren === undefined ? [] : [menuLabel(h, labelId, labelChildren)]),
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
				entry.content ?? [...(entry.icon === undefined ? [] : [icon(h, entry.icon)]), entry.label],
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
			const labelId = `${model.id}-group-${index}`
			return menuRadioGroup(h, entry.label === undefined ? undefined : labelId, [
				...(entry.label === undefined ? [] : [menuLabel(h, labelId, [entry.label])]),
				...entry.items.map((item, offset) =>
					menuCheckableItem(
						h,
						{
							...row(model, index + offset, { kind: "Radio", value: item.value }),
							kind: "radio",
							isChecked: item.isChecked,
						},
						item.content ?? [
							entry.isItemLabelWrapped === true ? h.span([], [item.label]) : item.label,
							...(item.hint === undefined
								? []
								: [h.span([h.Class("text-muted-foreground text-3xs")], [item.hint])]),
						],
					),
				),
			])
		}
		case "Separator":
			return menuSeparator(h)
		case "Label":
			return menuLabel(h, `${model.id}-label-${index}`, [entry.label], entry.className)
		case "Content":
			return entry.content
	}
}

/** The submenu entry with this value, at any depth. */
const findSubmenu = (entries: ReadonlyArray<MenuEntry>, value: string): Option.Option<MenuSubmenuEntry> =>
	Array.findFirst(entries, (entry) =>
		entry._tag === "Submenu" && entry.value === value
			? Option.some(entry)
			: entry._tag === "Group"
				? findSubmenu(entry.entries, value)
				: Option.none(),
	)

const keyHandler = (h: H, keys: ReadonlySet<string>, toMessage: (key: string) => Message) =>
	h.OnKeyDownPreventDefault((key) => (keys.has(key) ? Option.some(toMessage(key)) : Option.none()))

const submenuPortal = (h: H, model: Model, inputs: ViewInputs): ReadonlyArray<Html> => {
	const submenu = model.submenu
	if (submenu === null) return []
	const maybeEntry = findSubmenu(inputs.entries, submenu.value)
	const items = Option.match(maybeEntry, { onNone: () => [], onSome: (entry) => entry.entries })
	const body = (rows: ReadonlyArray<Html>): ReadonlyArray<Html> =>
		Option.match(maybeEntry, {
			onNone: () => rows,
			onSome: (entry) => [
				...(entry.header ?? []),
				...(rows.length === 0
					? (entry.placeholder ?? [])
					: entry.itemsClassName === undefined
						? rows
						: [h.div([h.Class(entry.itemsClassName)], rows)]),
			],
		})
	const subClassName = Option.getOrUndefined(
		Option.flatMapNullishOr(maybeEntry, (entry) => entry.className),
	)
	const separatorAfter = Option.match(maybeEntry, {
		onNone: () => undefined,
		onSome: (entry) => entry.separatorAfter,
	})
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
					[
						h.Class(cn(dropdownMenuPositionerStyles, !model.isOpen && "pointer-events-none")),
						...placement,
						h.Role("presentation"),
					],
					[
						h.div(
							[
								h.AriaLabelledBy(itemId(model.id, submenu.index)),
								h.Class(
									cn(dropdownMenuContentStyles, dropdownMenuSubContentStyles, subClassName),
								),
								...placement,
								h.DataAttribute("base-ui-focusable", ""),
								h.DataAttribute("slot", "dropdown-menu-sub-content"),
								h.Id(subPopupId(model.id)),
								h.Role("menu"),
								h.Tabindex(-1),
								keyHandler(h, SUBMENU_KEYS, (key) =>
									Message.PressedSubmenuKey({
										key,
										values: items.map((item) =>
											item.isDisabled === true ? null : item.value,
										),
									}),
								),
							],
							body(
								items.flatMap((item, index) => [
									menuItem(
										h,
										{
											id: subItemId(model.id, index),
											variant: item.variant,
											isDisabled: item.isDisabled,
											isHighlighted: submenu.highlighted === index,
											onHighlight: Message.HoveredSubmenuItem({ index }),
											onSelect: Message.ClickedSubmenuItem({ value: item.value }),
										},
										item.content ?? [item.label, ...shortcutOf(h, item)],
									),
									...(separatorAfter === index ? [menuSeparator(h)] : []),
								]),
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
				// Base UI's `inert: !open`: a closing menu lets the pointer reach the page at once.
				...(model.isOpen ? [] : [h.Inert(true)]),
				h.Role("presentation"),
				h.Style({ position: "fixed", inset: "0px", userSelect: "none" }),
				h.OnClick(Message.PressedOutside()),
			]),
			h.div(
				[
					h.Class(cn(dropdownMenuPositionerStyles, !model.isOpen && "pointer-events-none")),
					...placement,
					h.Role("presentation"),
				],
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

export const view = MenuComposition.makeView.withInputs<ViewInputs>((model, inputs, h) => {
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

// BLOCK

const prepare = () =>
	MenuComposition.prepareBlock({
		init,
		update,
		view,
		operations: { requestClose: Message.RequestedClose },
		EffectsLayer,
	})
export const MenuBlock: Block.FromAssemblyWithViewAndOutMessage<typeof Model, typeof prepare> =
	Block.assemble(prepare)
