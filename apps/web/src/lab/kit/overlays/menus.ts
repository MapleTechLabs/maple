import type { Html, HtmlBuilder } from "foldkit/html"
import type * as ContextMenu from "../../../ui/context-menu"
import { type Entry, view as contextMenuView } from "../../../ui/context-menu-view"
import { button } from "../../../ui/button"
import * as MenuView from "../../../ui/menu-view"
import type { MenuEntry } from "../../../ui/menu-view"
import { Message, type Model } from "./model"

// `KitContextMenu` (opened by a right-click in the scenario).
type H = HtmlBuilder<Message>

const CONTEXT_MENU_ENTRIES: ReadonlyArray<Entry> = [
	{ _tag: "Item", label: "Filter by service", shortcut: "F" },
	{ _tag: "Item", label: "Exclude service" },
	{ _tag: "Separator" },
	{ _tag: "Item", label: "Hide span", variant: "destructive" },
]

const dropdownEntries = (settings: Model["menuSettings"]): ReadonlyArray<MenuEntry> => [
	{
		_tag: "Group",
		label: "Trace",
		entries: [
			{ _tag: "Item", value: "open-trace", label: "Open trace", shortcut: "Enter" },
			{ _tag: "Item", value: "copy-trace-id", label: "Copy trace id", shortcut: "Cmd C" },
		],
	},
	{
		_tag: "Submenu",
		value: "add-to-dashboard",
		label: "Add to dashboard",
		entries: [
			{ _tag: "Item", value: "checkout-latency", label: "Checkout latency" },
			{ _tag: "Item", value: "payments", label: "Payments" },
		],
	},
	{ _tag: "Separator" },
	{
		_tag: "Checkbox",
		value: "show-attributes",
		label: "Show attributes",
		isChecked: settings.showAttributes,
	},
	{ _tag: "Checkbox", value: "wrap-lines", label: "Wrap lines", isChecked: settings.wrapLines },
	{ _tag: "Separator" },
	{
		_tag: "RadioGroup",
		items: [
			{ value: "compact", label: "Compact", isChecked: settings.density === "compact" },
			{ value: "comfortable", label: "Comfortable", isChecked: settings.density === "comfortable" },
		],
	},
	{ _tag: "Separator" },
	{ _tag: "Item", value: "delete", label: "Delete", variant: "destructive" },
]

// `KitDropdownMenu` (`defaultOpen`).
export const kitDropdownMenu = (h: H, model: Model): Html =>
	h.submodel({
		slotId: "dropdown-menu",
		model: model.dropdownMenu,
		view: MenuView.view,
		viewInputs: {
			entries: dropdownEntries(model.menuSettings),
			className: "w-56",
			toView: ({ trigger, withTrigger }) =>
				h.div(
					[h.Class("flex min-h-48 items-start")],
					withTrigger(button(h, { variant: "outline", attributes: trigger }, ["Row actions"])),
				),
		},
		toParentMessage: (message) => Message.GotDropdownMenuMessage({ message }),
	})

export const kitContextMenu = (h: H, model: ContextMenu.Model): Html =>
	h.div(
		[h.Class("flex min-h-48 items-start")],
		[
			h.submodel({
				slotId: "context-menu",
				model,
				view: contextMenuView,
				viewInputs: {
					entries: CONTEXT_MENU_ENTRIES,
					className: "w-52",
					triggerClassName:
						"flex h-40 w-80 items-center justify-center rounded-lg border border-dashed text-muted-foreground text-sm",
					triggerContent: ["Right-click a span"],
				},
				toParentMessage: (message) => Message.GotContextMenuMessage({ message }),
			}),
		],
	)
