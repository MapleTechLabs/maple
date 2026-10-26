import { OVERLAY_ITEMS } from "../overlay-items"
import { Option, Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Combobox from "../../../ui/combobox"
import * as ContextMenu from "../../../ui/context-menu"
import * as Dialog from "../../../ui/dialog"
import * as HoverCard from "../../../ui/hover-card"
import * as Menu from "../../../ui/menu"
import * as Popover from "../../../ui/popover"
import * as Select from "../../../ui/select"
import * as Toast from "../../../ui/toast"
import * as Tooltip from "../../../ui/tooltip"

export const OverlayItem = Schema.Literals(OVERLAY_ITEMS)
export type OverlayItem = typeof OverlayItem.Type

/** `?item=`, read before init: the one overlay rendered open (overlays cannot share a page). */
export const Flags = Schema.Struct({ item: Schema.NullOr(Schema.String) })
export type Flags = typeof Flags.Type

export const Model = Schema.Struct({
	item: Schema.Option(OverlayItem),
	dialog: Dialog.Model,
	alertDialog: Dialog.Model,
	sheet: Dialog.Model,
	command: Dialog.Model,
	popover: Popover.Model,
	hoverCard: HoverCard.Model,
	contextMenu: ContextMenu.Model,
	select: Select.Model,
	combobox: Combobox.Model,
	autocomplete: Combobox.Model,
	commandList: Combobox.Model,
	toasts: Toast.Model,
	tooltip: Tooltip.Model,
	dropdownMenu: Menu.Model,
	/** `KitDropdownMenu`'s checkbox and radio items (`defaultChecked`, `defaultValue`). */
	menuSettings: Schema.Struct({
		showAttributes: Schema.Boolean,
		wrapLines: Schema.Boolean,
		density: Schema.Literals(["compact", "comfortable"]),
	}),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotDialogMessage: { message: Dialog.Message },
	GotAlertDialogMessage: { message: Dialog.Message },
	GotSheetMessage: { message: Dialog.Message },
	GotCommandMessage: { message: Dialog.Message },
	GotPopoverMessage: { message: Popover.Message },
	GotHoverCardMessage: { message: HoverCard.Message },
	GotContextMenuMessage: { message: ContextMenu.Message },
	GotSelectMessage: { message: Select.Message },
	GotComboboxMessage: { message: Combobox.Message },
	GotAutocompleteMessage: { message: Combobox.Message },
	GotCommandListMessage: { message: Combobox.Message },
	GotToastMessage: { message: Toast.Message },
	GotTooltipMessage: { message: Tooltip.Message },
	GotDropdownMenuMessage: { message: Menu.Message },
})
export type Message = typeof Message.Type

/** No `?item=` opens the dialog, so the bare gallery still shows an overlay; an unknown one opens none. */
export const decodeItem = (raw: string | null): Option.Option<OverlayItem> =>
	raw === null ? Option.some("dialog") : Schema.decodeUnknownOption(OverlayItem)(raw)

/** The `toast-<type>` items' toast type. */
export const toastTypeOf = (item: OverlayItem): Option.Option<Toast.ToastType> =>
	item.startsWith("toast-")
		? Schema.decodeUnknownOption(Toast.ToastType)(item.slice("toast-".length))
		: Option.none()

export const TOAST_COPY = {
	default: { title: "Dashboard saved", description: "Checkout latency is up to date." },
	success: { title: "Schema applied", description: "All 14 tables are on the latest version." },
	error: { title: "Failed to delete rule", description: "The alert rule is referenced by a policy." },
	info: { title: "New version available", description: "Reload to get the latest Maple." },
	warning: { title: "Approaching ingest quota", description: "82% of this month's spans are used." },
	loading: { title: "Exporting logs", description: "Preparing 12,480 rows." },
} satisfies Record<Toast.ToastType, { title: string; description: string }>
