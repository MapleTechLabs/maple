import { useState } from "react"
import { useClerk, useReverification, useUser } from "@clerk/clerk-react"
import { toastManager } from "@maple/ui/components/ui/toast"

import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { ImageDropzone, TypeToConfirmField } from "@/components/common/image-dropzone"
import { UserAvatar, userInitials } from "@/components/dashboard/user-avatar"
import { toastAccountError } from "@/components/account/account-errors"
import { AccountSectionSkeleton } from "@/components/account/account-section-skeleton"

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
	const [isSavingName, setIsSavingName] = useState(false)
	const [isSavingAvatar, setIsSavingAvatar] = useState(false)
	const [deleteOpen, setDeleteOpen] = useState(false)
	const [confirmText, setConfirmText] = useState("")
	const [isDeleting, setIsDeleting] = useState(false)

	const deleteAccount = useReverification(() => user?.delete())

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

	async function handleSaveName() {
		if (!user || !nameDirty) return
		setIsSavingName(true)
		try {
			await user.update({ firstName: trimmedFirst, lastName: trimmedLast })
			setDraft(null)
			toastManager.add({ title: "Profile updated", type: "success" })
		} catch (err) {
			toastAccountError(err, "Failed to update profile")
		} finally {
			setIsSavingName(false)
		}
	}

	async function handleAvatarSelect(file: File) {
		if (!user || isSavingAvatar) return
		setIsSavingAvatar(true)
		try {
			await user.setProfileImage({ file })
			toastManager.add({ title: "Profile picture updated", type: "success" })
		} catch (err) {
			toastAccountError(err, "Failed to update profile picture")
		} finally {
			setIsSavingAvatar(false)
		}
	}

	async function handleRemoveAvatar() {
		if (!user || isSavingAvatar) return
		setIsSavingAvatar(true)
		try {
			await user.setProfileImage({ file: null })
			toastManager.add({ title: "Profile picture removed", type: "success" })
		} catch (err) {
			toastAccountError(err, "Failed to remove profile picture")
		} finally {
			setIsSavingAvatar(false)
		}
	}

	async function handleDelete() {
		if (!user || !confirmMatches) return
		setIsDeleting(true)
		try {
			await deleteAccount()
			// The session is gone with the user, so sign out rather than leaving a dead session
			// behind; `afterSignOutUrl` on ClerkProvider takes it to the sign-in page.
			await signOut()
		} catch (err) {
			setIsDeleting(false)
			toastAccountError(err, "Failed to delete account")
		}
	}

	function handleDialogChange(open: boolean) {
		setDeleteOpen(open)
		if (!open) setConfirmText("")
	}

	return (
		<div className="space-y-6">
			<Card>
				<CardHeader>
					<CardTitle>Profile</CardTitle>
					<CardDescription>
						Your name and picture as they appear to other members of your organizations.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="space-y-4 max-w-md">
						<div className="space-y-1.5">
							<Label>Profile picture</Label>
							<ImageDropzone
								preview={
									<UserAvatar
										name={displayName}
										initials={userInitials(displayName)}
										imageUrl={user.hasImage ? user.imageUrl : undefined}
										className="size-full rounded-md text-sm"
									/>
								}
								onFile={(file) => void handleAvatarSelect(file)}
								onRemove={user.hasImage ? () => void handleRemoveAvatar() : undefined}
								uploading={isSavingAvatar}
								targetLabel="Change profile picture"
								changeLabel="Change picture"
							/>
						</div>
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-1.5">
								<Label htmlFor="account-first-name">First name</Label>
								<Input
									id="account-first-name"
									value={firstName}
									onChange={(e) => updateDraft({ firstName: e.target.value })}
									disabled={isSavingName}
									autoComplete="given-name"
									placeholder="First name"
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="account-last-name">Last name</Label>
								<Input
									id="account-last-name"
									value={lastName}
									onChange={(e) => updateDraft({ lastName: e.target.value })}
									disabled={isSavingName}
									autoComplete="family-name"
									placeholder="Last name"
								/>
							</div>
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
				</CardContent>
			</Card>

			{user.deleteSelfEnabled && (
				<Card className="border-destructive/40">
					<CardHeader>
						<CardTitle className="text-destructive">Danger Zone</CardTitle>
						<CardDescription>
							Permanently delete your Maple account. You are removed from every organization you
							belong to. Organizations you own, and the telemetry in them, are not deleted —
							hand them over or delete them first.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="flex items-center justify-between gap-4">
							<div className="text-xs text-muted-foreground">
								Delete {email || "your account"} and sign out everywhere.
							</div>
							<Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
								Delete account
							</Button>
						</div>
					</CardContent>
				</Card>
			)}

			<ConfirmDialog
				open={deleteOpen}
				onOpenChange={handleDialogChange}
				title="Delete your account?"
				description="Your profile, sign-in methods and organization memberships are permanently deleted, and every session is signed out. This cannot be undone."
				confirmLabel="Delete account"
				pending={isDeleting}
				confirmDisabled={!confirmMatches}
				onConfirm={() => void handleDelete()}
			>
				<TypeToConfirmField
					id="account-delete-confirm"
					expected={email}
					value={confirmText}
					onChange={setConfirmText}
				/>
			</ConfirmDialog>
		</div>
	)
}
