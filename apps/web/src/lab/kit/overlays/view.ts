import { OVERLAY_ITEMS } from "../overlay-items"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { kitPage, kitSection } from "../kit-layout"
import * as ToastView from "../../../ui/toast-view"
import { kitHoverCard, kitPopover, kitTooltip } from "./cards"
import { kitAlertDialog, kitDialog, kitSheet } from "./dialogs"
import { kitCommand } from "./command"
import { kitContextMenu, kitDropdownMenu } from "./menus"
import { kitAutocomplete, kitComboboxChips, kitSelect } from "../pickers"
import { Message, type Model, type OverlayItem, toastTypeOf } from "./model"

type H = HtmlBuilder<Message>

const itemRow = (h: H, children: ReadonlyArray<Html>) =>
	h.div([h.Class("flex min-h-48 items-start")], children)

const renderItem = (h: H, model: Model, item: OverlayItem): Html => {
	switch (item) {
		case "dialog":
			return kitDialog(h, model.dialog)
		case "alert-dialog":
			return kitAlertDialog(h, model.alertDialog)
		case "popover":
			return kitPopover(h, model.popover)
		case "tooltip":
			return kitTooltip(h, model.tooltip)
		case "hover-card":
			return kitHoverCard(h, model.hoverCard)
		case "dropdown-menu":
			return kitDropdownMenu(h, model)
		case "context-menu":
			return kitContextMenu(h, model.contextMenu)
		case "select":
			return kitSelect(
				h,
				model.select,
				(message) => Message.GotSelectMessage({ message }),
				(parts) => itemRow(h, parts),
			)
		case "combobox":
			return kitComboboxChips(
				h,
				model.combobox,
				(message) => Message.GotComboboxMessage({ message }),
				(parts) => itemRow(h, parts),
			)
		case "autocomplete":
			return kitAutocomplete(
				h,
				model.autocomplete,
				(message) => Message.GotAutocompleteMessage({ message }),
				(parts) => itemRow(h, parts),
			)
		case "command":
			return kitCommand(h, model.command, model.commandList)
		case "sheet":
			return kitSheet(h, model.sheet)
		default:
			return h.div(
				[h.Class("flex min-h-48 items-start")],
				Option.toArray(Option.map(toastTypeOf(item), (type) => kitToastNote(h, type))),
			)
	}
}

/** `KitToast`'s note; the toast itself is in the bottom-right region. Three text nodes, `type`
 *  between literals: one merged node shapes differently at the joins. */
const kitToastNote = (h: H, type: string): Html =>
	h.p(
		[h.Class("text-muted-foreground text-sm")],
		["Toast type: ", type, ", shown in the bottom right corner."],
	)

/** TanStack `<Link>`: the active one also gets `active`, `aria-current` and `data-status`. */
const itemLink = (h: H, name: OverlayItem, isActive: boolean): Html =>
	h.a(
		[
			...(isActive ? [h.AriaCurrent("page")] : []),
			h.Class(
				cn(
					"rounded-md border px-2 py-1 font-mono text-xs transition-colors",
					isActive
						? "active border-foreground/20 bg-accent font-medium text-foreground"
						: "border-border text-muted-foreground hover:bg-surface-sunken hover:text-foreground",
				),
			),
			...(isActive ? [h.DataAttribute("status", "active")] : []),
			h.Href(`/lab/kit/overlays?item=${name}`),
		],
		[name],
	)

export const view = (model: Model, h: H): Html =>
	h.div(
		[h.Id("app")],
		[
			kitPage(
				h,
				{
					title: "Kit: overlays",
					description: "One overlay from @maple/ui per ?item=, rendered open on mount.",
				},
				[
					kitSection(h, "Items", [
						h.nav(
							[h.AriaLabel("Overlay items"), h.Class("flex flex-wrap gap-1.5")],
							OVERLAY_ITEMS.map((name) => itemLink(h, name, Option.contains(model.item, name))),
						),
					]),
					...Option.toArray(
						Option.map(model.item, (item) => kitSection(h, item, [renderItem(h, model, item)])),
					),
				],
			),
			...ToastView.regions(h, model.toasts, (message) => Message.GotToastMessage({ message })),
		],
	)
