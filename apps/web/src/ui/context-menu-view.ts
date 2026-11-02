import { cn } from "@maple/ui/lib/utils"
import {
	contextMenuContentStyles,
	contextMenuItemStyles,
	contextMenuPositionerStyles,
	contextMenuSeparatorStyles,
	contextMenuShortcutStyles,
	contextMenuSubTriggerIconStyles,
	contextMenuSubTriggerStyles,
	contextMenuTriggerStyles,
} from "@maple/ui/styles/ui/context-menu"
import { Option } from "effect"
import { Submodel } from "foldkit"
import { type Attribute, type Html, type HtmlBuilder } from "foldkit/html"
import {
	itemId,
	Message,
	type Model,
	MountContextMenu,
	MountContextSubmenu,
	subItemId,
	subPopupId,
} from "./context-menu"
import { icon } from "./icon"
import { popupId, portalId } from "./overlay/popup-state"
import { focusGuard, isMounted, stateAttributes } from "./overlay/transition"

/** An entry of the menu: an item (with an optional shortcut) or a separator. */
export type ItemEntry = Readonly<{
	_tag: "Item"
	label: string
	shortcut?: string
	variant?: "default" | "destructive"
	/** Base UI's `disabled`: shown, not highlightable or pickable. */
	isDisabled?: boolean
	/** The item's children when they are more than its label (an icon, a check). */
	content?: ReadonlyArray<Html | string>
}>

/** An entry of the menu: an item (with an optional shortcut), a separator, or a submenu. */
export type Entry =
	| ItemEntry
	| Readonly<{ _tag: "Separator" }>
	| Readonly<{
			_tag: "Submenu"
			/** The trigger's children (`<Icon /><span>Label</span>`), before Base UI's chevron. */
			content: ReadonlyArray<Html | string>
			entries: ReadonlyArray<ItemEntry>
			className?: string
	  }>

export type ViewInputs = Readonly<{
	entries: ReadonlyArray<Entry>
	/** Classes for the trigger area (`ContextMenuTrigger className`). */
	triggerClassName?: string
	triggerContent: ReadonlyArray<Html | string>
	/** Trigger content with handlers of its own (a row link): built by the parent, scoped to it. */
	toTriggerContent?: () => ReadonlyArray<Html | string>
	className?: string
}>

type H = HtmlBuilder<Message>

const separator = (h: H): Html =>
	h.div([
		h.AriaOrientation("horizontal"),
		h.Class(cn(contextMenuSeparatorStyles)),
		h.DataAttribute("orientation", "horizontal"),
		h.DataAttribute("slot", "context-menu-separator"),
		h.Role("separator"),
	])

const item = (
	h: H,
	entry: ItemEntry,
	options: Readonly<{ id: string; isHighlighted: boolean; onHover: Message; onClick: Message }>,
): Html => {
	const isDisabled = entry.isDisabled ?? false
	return h.div(
		[
			...(isDisabled ? [h.AriaDisabled(true)] : []),
			h.Class(cn(contextMenuItemStyles)),
			...(isDisabled ? [h.DataAttribute("disabled", "")] : []),
			...(options.isHighlighted ? [h.DataAttribute("highlighted", "")] : []),
			h.DataAttribute("slot", "context-menu-item"),
			h.DataAttribute("variant", entry.variant ?? "default"),
			h.Id(options.id),
			h.Role("menuitem"),
			h.Tabindex(options.isHighlighted ? 0 : -1),
			...(isDisabled ? [] : [h.OnMouseMove(options.onHover), h.OnClick(options.onClick)]),
		],
		[
			...(entry.content ?? [entry.label]),
			...(entry.shortcut === undefined
				? []
				: [
						h.span(
							[
								h.Class(cn(contextMenuShortcutStyles)),
								h.DataAttribute("slot", "context-menu-shortcut"),
							],
							[entry.shortcut],
						),
					]),
		],
	)
}

type SubmenuEntry = Extract<Entry, { _tag: "Submenu" }>

/** `ContextMenuSubTrigger`, and its `ContextMenuSubContent` while open (portaled beside it). */
const subTrigger = (h: H, model: Model, entry: SubmenuEntry, index: number): Html => {
	const isOpen = model.submenu === index
	const triggerId = itemId(model.id, index)
	return h.div(
		[
			h.AriaExpanded(isOpen),
			h.AriaHasPopup("menu"),
			h.Class(cn(contextMenuSubTriggerStyles)),
			...(model.highlighted === index ? [h.DataAttribute("highlighted", "")] : []),
			...(isOpen ? [h.DataAttribute("popup-open", "")] : []),
			h.DataAttribute("slot", "context-menu-sub-trigger"),
			h.Id(triggerId),
			h.Role("menuitem"),
			h.Tabindex(-1),
			h.OnMouseMove(Message.OpenedSubmenu({ index })),
			h.OnClick(Message.OpenedSubmenu({ index })),
		],
		[
			...entry.content,
			icon(h, "ChevronRightIcon", {
				className: contextMenuSubTriggerIconStyles,
				attributes: [h.Attribute("stroke-width", "2")],
			}),
			...(isOpen ? [submenuPortal(h, model, entry, triggerId)] : []),
		],
	)
}

const submenuPortal = (h: H, model: Model, entry: SubmenuEntry, triggerId: string): Html =>
	h.div(
		[
			h.Key(`${portalId(model.id)}-sub`),
			h.DataAttribute("base-ui-portal", ""),
			h.OnMount(MountContextSubmenu({ id: model.id, triggerId })),
		],
		[
			h.div(
				[
					h.Class(cn(contextMenuPositionerStyles, !model.isOpen && "pointer-events-none")),
					h.DataAttribute("align", "start"),
					h.DataAttribute("open", ""),
					h.DataAttribute("side", "right"),
					h.Role("presentation"),
				],
				[
					h.div(
						[
							h.Class(cn(contextMenuContentStyles, entry.className)),
							h.DataAttribute("align", "start"),
							h.DataAttribute("open", ""),
							h.DataAttribute("side", "right"),
							h.DataAttribute("slot", "context-menu-sub-content"),
							h.Id(subPopupId(model.id)),
							h.Role("menu"),
							h.Tabindex(-1),
						],
						entry.entries.map((sub, index) =>
							item(h, sub, {
								id: subItemId(model.id, index),
								isHighlighted: model.subHighlighted === index,
								onHover: Message.HoveredSubItem({ index }),
								onClick: Message.ClickedSubItem({ index }),
							}),
						),
					),
				],
			),
		],
	)

const MENU_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End", "Enter", " ", "Escape"])

/** Menu keys go to `update` with which entries can take the highlight (items, not separators). */
const menuKeys = (h: H, entries: ReadonlyArray<Entry>) =>
	h.OnKeyDownPreventDefault((key) =>
		MENU_KEYS.has(key)
			? Option.some(
					Message.PressedMenuKey({
						key,
						enabled: entries.map(
							(entry) =>
								entry._tag !== "Separator" &&
								!(entry._tag === "Item" && entry.isDisabled === true),
						),
					}),
				)
			: Option.none(),
	)

const portal = (h: H, model: Model, inputs: ViewInputs): Html => {
	const state = stateAttributes(h, model.isOpen, model.animation)
	const placement = [h.DataAttribute("align", model.align), h.DataAttribute("instant", "click")]
	return h.div(
		[
			h.Key(portalId(model.id)),
			h.DataAttribute("base-ui-portal", ""),
			h.Id(portalId(model.id)),
			h.OnMount(MountContextMenu({ id: model.id, point: model.point })),
		],
		[
			h.div([
				h.AriaHidden(true),
				h.DataAttribute("base-ui-inert", ""),
				// Base UI's `inert: !open`: a closing menu lets the pointer reach the page at once.
				...(model.isOpen ? [] : [h.Inert(true)]),
				h.Role("presentation"),
				h.Style({ position: "fixed", inset: "0px", userSelect: "none" }),
			]),
			h.div(
				[
					h.Class(cn(contextMenuPositionerStyles, !model.isOpen && "pointer-events-none")),
					...placement,
					...state,
					h.DataAttribute("side", model.side),
					h.Role("presentation"),
				],
				[
					focusGuard(h, "inside"),
					h.div(
						[
							h.Class(cn(contextMenuContentStyles, inputs.className)),
							...placement,
							h.DataAttribute("base-ui-focusable", ""),
							...state,
							h.DataAttribute("rootownerid", `${model.id}-root`),
							h.DataAttribute("side", model.side),
							h.DataAttribute("slot", "context-menu-content"),
							h.Id(popupId(model.id)),
							h.Role("menu"),
							h.Tabindex(-1),
							menuKeys(h, inputs.entries),
							h.OnMouseLeave(Message.LeftMenu()),
						],
						inputs.entries.map((entry, index) => {
							switch (entry._tag) {
								case "Separator":
									return separator(h)
								case "Submenu":
									return subTrigger(h, model, entry, index)
								case "Item":
									return item(h, entry, {
										id: itemId(model.id, index),
										isHighlighted: model.highlighted === index,
										onHover: Message.HoveredItem({ index }),
										onClick: Message.ClickedItem({ index }),
									})
							}
						}),
					),
					focusGuard(h, "inside"),
				],
			),
		],
	)
}

/** The trigger area before a menu Submodel exists (rows that mount one lazily); the caller wires
 *  the pointer and contextmenu events that create it. */
export const idleTrigger = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ className?: string; attributes?: ReadonlyArray<Attribute<M>> }>,
	children: ReadonlyArray<Html>,
): Html =>
	h.div(
		[
			h.Class(cn(contextMenuTriggerStyles, options.className)),
			h.DataAttribute("slot", "context-menu-trigger"),
			...(options.attributes ?? []),
		],
		children,
	)

/** The trigger area, with the menu's portal as its last child while open (moved to `<body>`). */
export const view =Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) =>
	h.div(
		[
			h.Class(cn(contextMenuTriggerStyles, inputs.triggerClassName)),
			...(model.isOpen ? [h.DataAttribute("popup-open", ""), h.DataAttribute("pressed", "")] : []),
			h.DataAttribute("slot", "context-menu-trigger"),
			h.OnPointerDown((_type, _button, _sx, _sy, _t, clientX, clientY) =>
				Option.some(Message.PressedTriggerPointer({ point: { x: clientX, y: clientY } })),
			),
			h.OnContextMenu(Message.OpenedContextMenu()),
		],
		[
			...(inputs.toTriggerContent?.() ?? inputs.triggerContent),
			...(isMounted(model.isOpen, model.animation) ? [portal(h, model, inputs)] : []),
		],
	),
)
