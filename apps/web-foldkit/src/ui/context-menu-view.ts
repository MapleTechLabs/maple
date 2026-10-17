import { cn } from "@maple/ui/lib/utils"
import {
	contextMenuContentStyles,
	contextMenuItemStyles,
	contextMenuPositionerStyles,
	contextMenuSeparatorStyles,
	contextMenuShortcutStyles,
	contextMenuTriggerStyles,
} from "@maple/ui/styles/ui/context-menu"
import { Option } from "effect"
import { Submodel } from "foldkit"
import { type Html, type HtmlBuilder } from "foldkit/html"
import { itemId, Message, type Model, MountContextMenu } from "./context-menu"
import { popupId, portalId } from "./overlay/popup-state"
import { focusGuard, isMounted, stateAttributes } from "./overlay/transition"

/** An entry of the menu: an item (with an optional shortcut) or a separator. */
export type Entry =
	| Readonly<{ _tag: "Item"; label: string; shortcut?: string; variant?: "default" | "destructive" }>
	| Readonly<{ _tag: "Separator" }>

export type ViewInputs = Readonly<{
	entries: ReadonlyArray<Entry>
	/** Classes for the trigger area (`ContextMenuTrigger className`). */
	triggerClassName?: string
	triggerContent: ReadonlyArray<Html | string>
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

const item = (h: H, model: Model, entry: Extract<Entry, { _tag: "Item" }>, index: number): Html => {
	const isHighlighted = model.highlighted === index
	return h.div(
		[
			h.Class(cn(contextMenuItemStyles)),
			...(isHighlighted ? [h.DataAttribute("highlighted", "")] : []),
			h.DataAttribute("slot", "context-menu-item"),
			h.DataAttribute("variant", entry.variant ?? "default"),
			h.Id(itemId(model.id, index)),
			h.Role("menuitem"),
			h.Tabindex(isHighlighted ? 0 : -1),
			h.OnMouseMove(Message.HoveredItem({ index })),
			h.OnClick(Message.ClickedItem({ index })),
		],
		[
			entry.label,
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

const MENU_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End", "Enter", " ", "Escape"])

/** Menu keys go to `update` with which entries can take the highlight (items, not separators). */
const menuKeys = (h: H, entries: ReadonlyArray<Entry>) =>
	h.OnKeyDownPreventDefault((key) =>
		MENU_KEYS.has(key)
			? Option.some(
					Message.PressedMenuKey({ key, enabled: entries.map((entry) => entry._tag === "Item") }),
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
				h.Role("presentation"),
				h.Style({ position: "fixed", inset: "0px", userSelect: "none" }),
			]),
			h.div(
				[
					h.Class(contextMenuPositionerStyles),
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
						inputs.entries.map((entry, index) =>
							entry._tag === "Separator" ? separator(h) : item(h, model, entry, index),
						),
					),
					focusGuard(h, "inside"),
				],
			),
		],
	)
}

/** The trigger area, with the menu's portal as its last child while open (moved to `<body>`). */
export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) =>
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
			...inputs.triggerContent,
			...(isMounted(model.isOpen, model.animation) ? [portal(h, model, inputs)] : []),
		],
	),
)
