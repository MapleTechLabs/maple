import { Effect, Option } from "effect"
import { Update } from "foldkit"
import * as Dialog from "../../../ui/dialog"
import * as HoverCard from "../../../ui/hover-card"
import * as Popover from "../../../ui/popover"
import * as Toast from "../../../ui/toast"
import {
	decodeItem,
	type Flags,
	Message,
	type Model,
	type OverlayItem,
	TOAST_COPY,
	toastTypeOf,
} from "./model"

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	item: new URLSearchParams(window.location.search).get("item"),
}))

const isItem = (item: Option.Option<OverlayItem>, name: OverlayItem) => Option.contains(item, name)

const toastFold = {
	read: (model: Model) => Option.some(model.toasts),
	write: (model: Model, toasts: Toast.Model): Model => ({ ...model, toasts }),
	toParentMessage: (message: Toast.Message) => Message.GotToastMessage({ message }),
}

/** `KitToast`: one toast of the item's type with no timeout. */
const addKitToast = (type: Toast.ToastType) =>
	Update.foldChildStep({
		...toastFold,
		update: (toasts: Toast.Model) => Toast.add(toasts, { ...TOAST_COPY[type], type, timeoutMs: 0 }),
	})

const toastItemType = (item: Option.Option<OverlayItem>): Option.Option<Toast.ToastType> =>
	Option.flatMap(item, toastTypeOf)

/** `defaultOpen`: the overlay named by `?item=` starts open. */
export const init = (flags: Flags): Update.Return<Model, Message> => {
	const item = decodeItem(flags.item)
	const model: Model = {
		item,
		dialog: Dialog.init("kit-dialog", "dialog", { isOpen: isItem(item, "dialog") }),
		alertDialog: Dialog.init("kit-alert-dialog", "alert-dialog", {
			isOpen: isItem(item, "alert-dialog"),
		}),
		sheet: Dialog.init("kit-sheet", "sheet", { isOpen: isItem(item, "sheet") }),
		command: Dialog.init("kit-command", "command-dialog", { isOpen: isItem(item, "command") }),
		popover: Popover.init("kit-popover", { isOpen: isItem(item, "popover") }),
		hoverCard: HoverCard.init("kit-hover-card", { isOpen: isItem(item, "hover-card") }),
		toasts: Toast.init("kit-toast"),
	}
	return Option.match(toastItemType(item), {
		onNone: () => ({ model }),
		onSome: (type) => addKitToast(type)(model),
	})
}

const foldToast = Update.foldChild({ ...toastFold, update: Toast.update })

/** A gallery field holding one overlay Submodel whose update returns no OutMessage. */
const fieldFold = <Field extends keyof Model, ChildMessage>(
	field: Field,
	update: (model: Model[Field], message: ChildMessage) => Update.Return<Model[Field], ChildMessage>,
	toParentMessage: (message: ChildMessage) => Message,
) =>
	Update.foldChild({
		update,
		read: (model: Model) => Option.some(model[field]),
		write: (model: Model, next: Model[Field]): Model => ({ ...model, [field]: next }),
		toParentMessage,
	})

const foldPopover = fieldFold("popover", Popover.update, (message) => Message.GotPopoverMessage({ message }))
const foldHoverCard = fieldFold("hoverCard", HoverCard.update, (message) =>
	Message.GotHoverCardMessage({ message }),
)

type DialogField = "dialog" | "alertDialog" | "sheet" | "command"

/** The gallery reads `isOpen`; Opened and Closed need no reaction. */
const ignoreOutMessage = (_outMessage: Dialog.OutMessage) => (model: Model) => ({ model })

const dialogFold = (field: DialogField, toParentMessage: (message: Dialog.Message) => Message) =>
	Update.foldChild({
		update: Dialog.update,
		read: (model: Model) => Option.some(model[field]),
		write: (model: Model, next: Dialog.Model): Model => ({ ...model, [field]: next }),
		toParentMessage,
		foldOutMessage: ignoreOutMessage,
	})

const foldDialog = dialogFold("dialog", (message) => Message.GotDialogMessage({ message }))
const foldAlertDialog = dialogFold("alertDialog", (message) => Message.GotAlertDialogMessage({ message }))
const foldSheet = dialogFold("sheet", (message) => Message.GotSheetMessage({ message }))
const foldCommand = dialogFold("command", (message) => Message.GotCommandMessage({ message }))

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		GotDialogMessage: ({ message: child }) => foldDialog(model, child),
		GotAlertDialogMessage: ({ message: child }) => foldAlertDialog(model, child),
		GotSheetMessage: ({ message: child }) => foldSheet(model, child),
		GotCommandMessage: ({ message: child }) => foldCommand(model, child),
		GotPopoverMessage: ({ message: child }) => foldPopover(model, child),
		GotHoverCardMessage: ({ message: child }) => foldHoverCard(model, child),
		GotToastMessage: ({ message: child }) => foldToast(model, child),
	})
