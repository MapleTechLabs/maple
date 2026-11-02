import { formatDateInTimezone } from "@maple/web-data/lib/timezone-format"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "@maple/views/ui/empty"
import { formDialog } from "@maple/views/ui/form-dialog"
import { icon } from "@maple/views/ui/icon"
import * as Menu from "@maple/views/ui/menu"
import { rowActionsMenu } from "@maple/views/ui/row-actions-menu"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow, truncatedTableCell } from "@maple/views/ui/table"
import { truncatedText } from "@maple/views/ui/truncated-text"
import { accountSectionSkeleton } from "../../kit/account-skeleton"
import { settingsSection, settingsSections } from "../../kit/section"
import { textField } from "../fields"
import type { AccountPasskey, AccountUser } from "../user"
import { Message, type Model } from "./model"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"

type H = HtmlBuilder<Message>
type Inputs = Readonly<{ timeZone: string }>

const addButton = (h: H, isDisabled: boolean): Html =>
	button(h, { size: "sm", isDisabled, attributes: [h.OnClick(Message.ClickedAdd())] }, [
		icon(h, "PlusIcon", { attributes: [h.DataAttribute("icon", "inline-start")] }),
		"Add passkey",
	])

const passkeyRow = (h: H, model: Model, passkey: AccountPasskey, inputs: Inputs): Html => {
	const menuId = `passkey-actions-${passkey.id}`
	const formatDate = (ms: number) => formatDateInTimezone(ms, { timeZone: inputs.timeZone })
	return tableRow(
		h,
		[
			truncatedTableCell(
				h,
				[
					hstack(h, { gap: "2.5" },
						[
							icon(h, "FingerprintIcon", {
								size: 16,
								className: "shrink-0 text-muted-foreground",
							}),
							truncatedText(h, {
								text: passkey.name || "Unnamed passkey",
								className: typographyClass({ size: "xs", weight: "medium" }),
							}),
						],
					),
				],
			),
			tableCell(h, [formatDate(passkey.createdAtMs)], typographyClass({ size: "xs", tone: "muted" })),
			tableCell(
				h,
				[passkey.lastUsedAtMs === null ? "Never" : formatDate(passkey.lastUsedAtMs)],
				typographyClass({ size: "xs", tone: "muted" }),
			),
			tableCell(h, [
				rowActionsMenu(h, {
					slotId: menuId,
					model: model.rowMenus[menuId] ?? Menu.init(menuId),
					label: `Actions for ${passkey.name ?? "passkey"}`,
					entries: [
						{
							_tag: "Item",
							value: "rename",
							label: "Rename",
							icon: "PencilIcon",
							isDisabled: model.isBusy,
						},
						{
							_tag: "Item",
							value: "remove",
							label: "Remove",
							icon: "TrashIcon",
							variant: "destructive",
							isDisabled: model.isBusy,
						},
					],
					toParentMessage: (message) => Message.GotRowMenuMessage({ menuId, message }),
				}),
			]),
		],
		undefined,
		[h.Key(passkey.id)],
	)
}

const body = (h: H, model: Model, user: AccountUser, inputs: Inputs): ReadonlyArray<Html> => {
	if (!model.isSupported)
		return [
			typography(h, { size: "sm", tone: "muted", as: "p" },
				[
					"This browser does not support passkeys. Open Maple in a recent version of Chrome, Safari, Edge or Firefox over HTTPS to register one.",
				],
			),
		]
	if (user.passkeys.length === 0)
		return [
			empty(h, [
				emptyHeader(h, [
					emptyMedia(h, {}, [icon(h, "FingerprintIcon", { size: 20 })]),
					emptyTitle(h, ["No passkeys"]),
					emptyDescription(h, ["Add one to sign in without typing a password."]),
				]),
				addButton(h, model.isBusy),
			]),
		]
	return [
		table(h, {}, [
			tableHeader(h, [
				tableRow(h, [
					tableHead(h, ["Name"]),
					tableHead(h, ["Added"]),
					tableHead(h, ["Last used"]),
					tableHead(h, [], "w-10"),
				]),
			]),
			tableBody(
				h,
				user.passkeys.map((passkey) => passkeyRow(h, model, passkey, inputs)),
			),
		]),
	]
}

const loaded = (h: H, model: Model, user: AccountUser, inputs: Inputs): Html =>
	settingsSections(h, [
		settingsSection(
			h,
			{
				id: "account-passkeys",
				title: "Passkeys",
				description: [
					"Sign in with Touch ID, Windows Hello, a phone or a hardware key instead of a password.",
				],
				padded: !model.isSupported || user.passkeys.length === 0,
				actions: addButton(h, model.isBusy || !model.isSupported),
			},
			body(h, model, user, inputs),
		),
		formDialog(h, {
			slotId: "passkey-rename",
			model: model.renameDialog,
			toParentMessage: (message) => Message.GotRenameDialogMessage({ message }),
			title: "Rename passkey",
			description: 'Give it a name you will recognise, like "MacBook Touch ID".',
			onSubmit: Message.SubmittedRename(),
			submitLabel: "Save changes",
			isPending: model.isBusy,
			isSubmitDisabled: (model.renaming?.name.trim().length ?? 0) === 0,
			fields: [
				textField(h, {
					id: "passkey-name",
					label: "Name",
					value: model.renaming?.name ?? "",
					autoComplete: "off",
					isDisabled: model.isBusy,
					onInput: (value) => Message.ChangedName({ value }),
				}),
			],
		}),
		confirmDialog(h, {
			slotId: "passkey-remove",
			model: model.removeDialog,
			toParentMessage: (message) => Message.GotRemoveDialogMessage({ message }),
			title: "Remove passkey?",
			description: `${model.removing?.name ?? "This passkey"} can no longer be used to sign in. The credential stays on your device until you delete it there too.`,
			confirmLabel: "Remove passkey",
			isPending: model.isBusy,
			onConfirm: Message.ClickedConfirmRemove(),
		}),
	])

export const view = Submodel.defineView<Model, Message, Inputs>((model, inputs, h) =>
	!model.isLoaded || model.user === null ? accountSectionSkeleton(h) : loaded(h, model, model.user, inputs),
)
