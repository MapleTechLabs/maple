import { cn } from "@maple/ui/lib/utils"
import { truncatedCellStyles } from "@maple/ui/styles/ui/table"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../../ui/button"
import { confirmDialog } from "../../../../ui/confirm-dialog"
import { badge } from "../../../../ui/display"
import { formDialog } from "../../../../ui/form-dialog"
import { icon } from "../../../../ui/icon"
import * as Menu from "../../../../ui/menu"
import type { MenuEntry } from "../../../../ui/menu-view"
import * as OtpField from "../../../../ui/otp-field"
import { rowActionsMenu } from "../../../../ui/row-actions-menu"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../../ui/table"
import { truncatedText } from "../../../../ui/truncated-text"
import { accountSectionSkeleton } from "../../kit/account-skeleton"
import { settingsSection, settingsSections } from "../../kit/section"
import { codeField } from "../code-field"
import { textField } from "../fields"
import type { AccountEmail, AccountUser } from "../user"
import { Message, type Model } from "./model"
import { canRemove } from "./update"

type H = HtmlBuilder<Message>

const rowMenuEntries = (model: Model, user: AccountUser, address: AccountEmail): ReadonlyArray<MenuEntry> => {
	const isPrimary = address.id === user.primaryEmailAddressId
	return [
		...(address.isVerified
			? []
			: [
					{
						_tag: "Item",
						value: "verify",
						label: "Verify",
						icon: "EnvelopeIcon",
						isDisabled: model.isBusy,
					} as const,
				]),
		...(!isPrimary && address.isVerified
			? [
					{
						_tag: "Item",
						value: "primary",
						label: "Set as primary",
						icon: "CircleCheckIcon",
						isDisabled: model.isBusy,
					} as const,
				]
			: []),
		{
			_tag: "Item",
			value: "remove",
			label: "Remove",
			icon: "TrashIcon",
			variant: "destructive",
			isDisabled: model.isBusy || !canRemove(user, address),
		},
	]
}

const emailRow = (h: H, model: Model, user: AccountUser, address: AccountEmail): Html => {
	const isPrimary = address.id === user.primaryEmailAddressId
	const menuId = `email-actions-${address.id}`
	return tableRow(
		h,
		[
			tableCell(
				h,
				[truncatedText(h, { text: address.email })],
				cn(truncatedCellStyles, "font-medium text-xs"),
			),
			tableCell(h, [
				h.div(
					[h.Class("flex items-center gap-1.5")],
					[
						...(isPrimary ? [badge(h, { variant: "secondary" }, ["Primary"])] : []),
						address.isVerified
							? badge(h, { variant: "outline", className: "gap-1" }, [
									icon(h, "CircleCheckIcon", { size: 12 }),
									"Verified",
								])
							: badge(h, { variant: "outline", className: "text-muted-foreground" }, [
									"Unverified",
								]),
					],
				),
			]),
			tableCell(h, [
				rowActionsMenu(h, {
					slotId: menuId,
					model: model.rowMenus[menuId] ?? Menu.init(menuId),
					label: `Actions for ${address.email}`,
					entries: rowMenuEntries(model, user, address),
					toParentMessage: (message) => Message.GotRowMenuMessage({ menuId, message }),
				}),
			]),
		],
		undefined,
		[h.Key(address.id)],
	)
}

const addDialog = (h: H, model: Model): Html => {
	const add = model.add
	return formDialog(h, {
		slotId: "account-add-email",
		model: model.addDialog,
		toParentMessage: (message) => Message.GotAddDialogMessage({ message }),
		isPending: model.isBusy,
		onSubmit: Message.SubmittedAdd(),
		...(add._tag === "Code"
			? {
					title: `Verify ${add.email}`,
					description: "Enter the six-digit code we just emailed to that address.",
					submitLabel: "Verify",
					isSubmitDisabled: OtpField.valueOf(model.code).length < 6,
					fields: [
						codeField(h, {
							model: model.code,
							label: "Verification code",
							toParentMessage: (message) => Message.GotCodeMessage({ message }),
						}),
					],
				}
			: {
					title: "Add an email address",
					description: "We will send a six-digit code to confirm you own it.",
					submitLabel: "Send code",
					isSubmitDisabled: add.value.trim().length === 0,
					fields: [
						textField(h, {
							id: "account-new-email",
							label: "Email address",
							value: add.value,
							type: "email",
							autoComplete: "email",
							placeholder: "you@example.com",
							isDisabled: model.isBusy,
							onInput: (value) => Message.ChangedEmail({ value }),
						}),
					],
				}),
	})
}

const loaded = (h: H, model: Model, user: AccountUser): Html =>
	settingsSections(h, "standard", [
		settingsSection(
			h,
			{
				id: "account-emails",
				title: "Email addresses",
				description: [
					"Your primary address receives sign-in codes, alerts and digests. Others can be used to sign in.",
				],
				padded: false,
				actions: button(h, { size: "sm", attributes: [h.OnClick(Message.ClickedAdd())] }, [
					icon(h, "PlusIcon", { attributes: [h.DataAttribute("icon", "inline-start")] }),
					"Add email",
				]),
			},
			[
				table(h, {}, [
					tableHeader(h, [
						tableRow(h, [
							tableHead(h, ["Email"]),
							tableHead(h, ["Status"]),
							tableHead(h, [], "w-10"),
						]),
					]),
					tableBody(
						h,
						user.emails.map((address) => emailRow(h, model, user, address)),
					),
				]),
			],
		),
		addDialog(h, model),
		confirmDialog(h, {
			slotId: "account-remove-email",
			model: model.removeDialog,
			toParentMessage: (message) => Message.GotRemoveDialogMessage({ message }),
			title: "Remove email address?",
			description: `${model.removing?.email ?? ""} can no longer be used to sign in or receive notifications from Maple.`,
			confirmLabel: "Remove",
			isPending: model.isBusy,
			onConfirm: Message.ClickedConfirmRemove(),
		}),
	])

export const view = Submodel.defineView<Model, Message, Readonly<Record<never, never>>>(
	(model, _inputs, h) =>
		!model.isLoaded || model.user === null ? accountSectionSkeleton(h) : loaded(h, model, model.user),
)
