import { initialsFrom } from "@maple/ui/lib/initials"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../../ui/button"
import { confirmDialog } from "../../../../ui/confirm-dialog"
import { warmAvatarTone } from "../../../../ui/avatar-tone"
import { avatarFallback } from "../../../../ui/display"
import { field, fieldLabel } from "../../../../ui/field"
import { accountSectionSkeleton } from "../../kit/account-skeleton"
import { dangerRow, dangerZone } from "../../kit/danger-zone"
import { imageDropzone, typeToConfirmField } from "../../kit/image-dropzone"
import { saveBar } from "../../kit/save-bar"
import { settingsSection, settingsSections } from "../../kit/section"
import { fieldIds, stateFor, textField } from "../fields"
import type { AccountUser } from "../user"
import { Message, type Model } from "./model"
import { AVATAR_INPUT_ID, isConfirmMatching, isNameDirty, namesOf } from "./update"

type H = HtmlBuilder<Message>

const DANGER_DESCRIPTION =
	"Permanently delete your Maple account. You are removed from every organization you belong to. Organizations you own, and the telemetry in them, are not deleted: hand them over or delete them first."

/** `UserAvatar` in the dropzone (the initials until images are rendered). */
const userAvatar = (h: H, name: string): Html =>
	avatarFallback(
		h,
		{
			className: "bg-muted size-full rounded-md text-sm",
			fallbackClassName: `rounded-[inherit] font-medium ${warmAvatarTone(name)}`,
		},
		initialsFrom(name),
	)

const profileSection = (h: H, model: Model, user: AccountUser): Html => {
	const names = namesOf(model, user)
	const displayName = user.fullName ?? user.primaryEmail ?? "You"
	const pictureState = stateFor("")
	return settingsSection(
		h,
		{
			id: "account-profile",
			title: "Profile",
			description: ["Your name and picture as they appear to other members of your organizations."],
		},
		[
			h.div(
				[h.Class("space-y-4 max-w-md")],
				[
					field(h, { state: pictureState }, [
						fieldLabel(
							h,
							{ ids: fieldIds("account-picture"), state: pictureState },
							"Profile picture",
						),
						imageDropzone(h, {
							inputId: AVATAR_INPUT_ID,
							preview: userAvatar(h, displayName),
							isUploading: model.isSavingAvatar,
							isDragging: model.isDragging,
							targetLabel: "Change profile picture",
							changeLabel: "Change picture",
							onPick: Message.ClickedPickAvatar(),
							onFiles: (files) => Message.PickedAvatar({ files }),
							onDragOver: Message.DraggedOverAvatar(),
							onDragLeave: Message.LeftAvatar(),
							...(user.hasImage && { onRemove: Message.ClickedRemoveAvatar() }),
						}),
					]),
					h.div(
						[h.Class("grid grid-cols-2 gap-3")],
						[
							textField(h, {
								id: "account-first-name",
								label: "First name",
								value: names.firstName,
								onInput: (value) => Message.ChangedFirstName({ value }),
								autoComplete: "given-name",
								placeholder: "First name",
								isDisabled: model.isSavingName,
							}),
							textField(h, {
								id: "account-last-name",
								label: "Last name",
								value: names.lastName,
								onInput: (value) => Message.ChangedLastName({ value }),
								autoComplete: "family-name",
								placeholder: "Last name",
								isDisabled: model.isSavingName,
							}),
						],
					),
				],
			),
		],
	)
}

const deleteSection = (h: H, user: AccountUser): ReadonlyArray<Html> =>
	user.deleteSelfEnabled
		? [
				dangerZone(h, { id: "account-danger", description: [DANGER_DESCRIPTION] }, [
					dangerRow(h, {
						title: "Delete account",
						description: ["Delete ", user.primaryEmail ?? "your account", " and sign out everywhere."],
						action: button(
							h,
							{ variant: "destructive", size: "sm", attributes: [h.OnClick(Message.ClickedDelete())] },
							["Delete account"],
						),
					}),
				]),
			]
		: []

const deleteDialog = (h: H, model: Model, user: AccountUser): Html =>
	confirmDialog(h, {
		slotId: "account-delete",
		model: model.deleteDialog,
		toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
		title: "Delete your account?",
		description:
			"Your profile, sign-in methods and organization memberships are permanently deleted, and every session is signed out. This cannot be undone.",
		confirmLabel: "Delete account",
		isPending: model.isDeleting,
		isConfirmDisabled: !isConfirmMatching(model, user),
		onConfirm: Message.ClickedConfirmDelete(),
		children: [
			typeToConfirmField(h, {
				id: "account-delete-confirm",
				expected: user.primaryEmail ?? "",
				value: model.confirmText,
				onInput: (value) => Message.ChangedConfirmText({ value }),
			}),
		],
	})

export const view = Submodel.defineView<Model, Message, Readonly<Record<never, never>>>(
	(model, _inputs, h) => {
		const user = model.user
		if (!model.isLoaded || user === null) return accountSectionSkeleton(h)
		return settingsSections(h, [
			profileSection(h, model, user),
			...deleteSection(h, user),
			...saveBar(h, {
				isDirty: isNameDirty(model, user),
				isPending: model.isSavingName,
				onDiscard: Message.ClickedDiscardName(),
				onSave: Message.ClickedSaveName(),
			}),
			deleteDialog(h, model, user),
		])
	},
)
