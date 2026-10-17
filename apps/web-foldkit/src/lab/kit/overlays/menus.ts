import type { Html, HtmlBuilder } from "foldkit/html"
import type * as ContextMenu from "../../../ui/context-menu"
import { type Entry, view as contextMenuView } from "../../../ui/context-menu-view"
import { Message } from "./model"

// apps/web/src/lab/kit/overlays-menus.tsx `KitContextMenu` (opened by a right-click in the scenario).
type H = HtmlBuilder<Message>

const CONTEXT_MENU_ENTRIES: ReadonlyArray<Entry> = [
	{ _tag: "Item", label: "Filter by service", shortcut: "F" },
	{ _tag: "Item", label: "Exclude service" },
	{ _tag: "Separator" },
	{ _tag: "Item", label: "Hide span", variant: "destructive" },
]

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
