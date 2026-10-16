import { useState } from "react"
import { useClerk, useReverification, useUser } from "@clerk/clerk-react"
import { Field, FieldLabel } from "@maple/ui/components/ui/field"

import { Button } from "@maple/ui/components/ui/button"
import { Panel } from "@maple/ui/components/ui/panel"
import { Input } from "@maple/ui/components/ui/input"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { ImageDropzone, TypeToConfirmField } from "@/components/common/image-dropzone"
import { UserAvatar, userInitials } from "@/components/dashboard/user-avatar"
import { settleClerk, toastAccountError } from "@/components/account/account-errors"
import { SettingsSection, SettingsSections } from "@/components/settings/settings-section"
import { AccountSectionSkeleton } from "@/components/account/account-section-skeleton"
import { useAsyncAction } from "@/hooks/use-mutation-action"

/**
 * Edits to the name fields are held as a draft tagged with the user id they were typed against.
 * Reading through the tag rather than syncing state in an effect means a user switch (or a name
 * changed in another tab) resets the form on the very next render, with no effect to schedule.
 */
interface NameDraft {
	userId: string
	firstName: string
	lastName: string
}

export function ProfileSection() {
	const { user, isLoaded } = useUser()
	const { signOut } = useClerk()

	const [draft, setDraft] = useState<NameDraft | null>(null)
	const [deleteOpen, setDeleteOpen] = useState(false)
	const [confirmText, setConfirmText] = useState("")

	const deleteAccount = useReverification(() => user?.delete())

	const [withSavingName, isSavingName] = useAsyncAction((task: () => Promise<boolean>) => task())

	// `null` removes the picture.
	const [setAvatar, isSavingAvatar] = useAsyncAction(async (file: File | null) => {
		if (!user) return
		await settleClerk(user.setProfileImage({ file }), {
			success: file ? "Profile picture updated" : "Profile picture removed",
			error: file ? "Failed to update profile picture" : "Failed to remove profile picture",
		})
	})

	const [handleDelete, isDeleting] = useAsyncAction(() => {
		if (!user) return Promise.resolve()
		// The session is gone with the user, so sign out rather than leaving a dead session
		// behind; `afterSignOutUrl` on ClerkProvider takes it to the sign-in page.
		return deleteAccount()
			.then(() => signOut())
			.catch((err: unknown) => toastAccountError(err, "Failed to delete account"))
	})

	if (!isLoaded || !user) return <AccountSectionSkeleton />

	const savedFirstName = user.firstName ?? ""
	const savedLastName = user.lastName ?? ""
	const isCurrentDraft = draft?.userId === user.id
	const firstName = isCurrentDraft ? draft.firstName : savedFirstName
	const lastName = isCurrentDraft ? draft.lastName : savedLastName

	const trimmedFirst = firstName.trim()
	const trimmedLast = lastName.trim()
	const nameDirty = trimmedFirst !== savedFirstName || trimmedLast !== savedLastName

	const displayName = user.fullName ?? user.primaryEmailAddress?.emailAddress ?? "You"
	const email = user.primaryEmailAddress?.emailAddress ?? ""
	// A user has no unique display name to type back, so the primary email is the confirm string.
	const confirmMatches = email.length > 0 && confirmText.trim() === email

	function updateDraft(patch: Partial<Omit<NameDraft, "userId">>) {
		if (!user) return
		setDraft({ userId: user.id, firstName, lastName, ...patch })
	}

	function handleSaveName() {
		if (!user || !nameDirty) return
		return withSavingName(async () => {
			const ok = await settleClerk(user.update({ firstName: trimmedFirst, lastName: trimmedLast }), {
				success: "Profile updated",
				error: "Failed to update profile",
			})
			if (ok) setDraft(null)
			return ok
		})
	}

	function handleDialogChange(open: boolean) {
		setDeleteOpen(open)
		if (!open) setConfirmText("")
	}

	return (
		<SettingsSections>
			<SettingsSection
				title="Profile"
				description="Your name and picture as they appear to other members of your organizations."
			>
				<div className="space-y-4 max-w-md">
					<Field>
						<FieldLabel>Profile picture</FieldLabel>
						<ImageDropzone
							preview={
								<UserAvatar
									name={displayName}
									initials={userInitials(displayName)}
									imageUrl={user.hasImage ? user.imageUrl : undefined}
									className="size-full rounded-md text-sm"
								/>
							}
							onFile={(file) => {
								if (!isSavingAvatar) void setAvatar(file)
							}}
							onRemove={
								user.hasImage
									? () => {
											if (!isSavingAvatar) void setAvatar(null)
										}
									: undefined
							}
							uploading={isSavingAvatar}
							targetLabel="Change profile picture"
							changeLabel="Change picture"
						/>
					</Field>
					<div className="grid grid-cols-2 gap-3">
						<Field>
							<FieldLabel htmlFor="account-first-name">First name</FieldLabel>
							<Input
								id="account-first-name"
								value={firstName}
								onChange={(e) => updateDraft({ firstName: e.target.value })}
								disabled={isSavingName}
								autoComplete="given-name"
								placeholder="First name"
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="account-last-name">Last name</FieldLabel>
							<Input
								id="account-last-name"
								value={lastName}
								onChange={(e) => updateDraft({ lastName: e.target.value })}
								disabled={isSavingName}
								autoComplete="family-name"
								placeholder="Last name"
							/>
						</Field>
					</div>
					<div className="flex justify-end">
						<Button
							size="sm"
							onClick={handleSaveName}
							loading={isSavingName}
							disabled={!nameDirty}
						>
							Save
						</Button>
					</div>
				</div>
			</SettingsSection>

			{user.deleteSelfEnabled && (
				<SettingsSection
					title="Danger zone"
					description="Permanently delete your Maple account. You are removed from every organization you belong to. Organizations you own, and the telemetry in them, are not deleted: hand them over or delete them first."
					framed={false}
				>
					<Panel
						padded
						className="flex-row items-center justify-between gap-4 border-destructive/40"
					>
						<p className="text-xs text-muted-foreground">
							Delete {email || "your account"} and sign out everywhere.
						</p>
						<Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
							Delete account
						</Button>
					</Panel>
				</SettingsSection>
			)}

			<ConfirmDialog
				open={deleteOpen}
				onOpenChange={handleDialogChange}
				title="Delete your account?"
				description="Your profile, sign-in methods and organization memberships are permanently deleted, and every session is signed out. This cannot be undone."
				confirmLabel="Delete account"
				pending={isDeleting}
				confirmDisabled={!confirmMatches}
				onConfirm={() => {
					if (confirmMatches) void handleDelete()
				}}
			>
				<TypeToConfirmField
					id="account-delete-confirm"
					expected={email}
					value={confirmText}
					onChange={setConfirmText}
				/>
			</ConfirmDialog>
		</SettingsSections>
	)
}
