import { useState } from "react"
import { useReverification, useUser } from "@clerk/clerk-react"
import { Field, FieldError, FieldLabel } from "@maple/ui/components/ui/field"

import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { SettingRow } from "@maple/ui/components/ui/setting-row"
import { Switch } from "@maple/ui/components/ui/switch"
import { settleClerk } from "@/components/account/account-errors"
import { SettingsSection, SettingsSections } from "@/components/settings/settings-section"
import { AccountSectionSkeleton } from "@/components/account/account-section-skeleton"
import type { UpdatePasswordParams } from "@/components/account/account-types"
import { useAsyncAction } from "@/hooks/use-mutation-action"

const MIN_PASSWORD_LENGTH = 8

export function PasswordSection() {
	const { user, isLoaded } = useUser()

	const [currentPassword, setCurrentPassword] = useState("")
	const [newPassword, setNewPassword] = useState("")
	const [confirmPassword, setConfirmPassword] = useState("")
	const [signOutOfOtherSessions, setSignOutOfOtherSessions] = useState(true)

	const updatePassword = useReverification((params: UpdatePasswordParams) => user?.updatePassword(params))

	const [withSaving, isSaving] = useAsyncAction((task: () => Promise<void>) => task())

	if (!isLoaded || !user) return <AccountSectionSkeleton />

	const hasPassword = user.passwordEnabled
	const tooShort = newPassword.length > 0 && newPassword.length < MIN_PASSWORD_LENGTH
	const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword
	const canSubmit =
		newPassword.length >= MIN_PASSWORD_LENGTH &&
		confirmPassword === newPassword &&
		(!hasPassword || currentPassword.length > 0)

	function handleSubmit() {
		if (!user || !canSubmit) return
		return withSaving(async () => {
			const ok = await settleClerk(
				updatePassword({
					newPassword,
					// Clerk rejects `currentPassword` on an account that has none yet.
					...(hasPassword ? { currentPassword } : undefined),
					signOutOfOtherSessions,
				}),
				{
					success: hasPassword ? "Password changed" : "Password set",
					error: "Failed to update your password",
				},
			)
			if (!ok) return
			setCurrentPassword("")
			setNewPassword("")
			setConfirmPassword("")
		})
	}

	return (
		<SettingsSections>
			<SettingsSection
				title={hasPassword ? "Change password" : "Set a password"}
				description={
					hasPassword
						? "Use at least 8 characters. Changing your password can sign you out of your other devices."
						: "You signed up with a social account or an email code. Adding a password gives you a second way in."
				}
			>
				<div className="space-y-4 max-w-md">
					{hasPassword && (
						<Field>
							<FieldLabel htmlFor="account-current-password">Current password</FieldLabel>
							<Input
								id="account-current-password"
								type="password"
								autoComplete="current-password"
								value={currentPassword}
								onChange={(e) => setCurrentPassword(e.target.value)}
								disabled={isSaving}
							/>
						</Field>
					)}
					<Field>
						<FieldLabel htmlFor="account-new-password">New password</FieldLabel>
						<Input
							id="account-new-password"
							type="password"
							autoComplete="new-password"
							value={newPassword}
							onChange={(e) => setNewPassword(e.target.value)}
							disabled={isSaving}
							aria-invalid={tooShort}
						/>
						{tooShort && (
							<FieldError match>Use at least {MIN_PASSWORD_LENGTH} characters.</FieldError>
						)}
					</Field>
					<Field>
						<FieldLabel htmlFor="account-confirm-password">Confirm new password</FieldLabel>
						<Input
							id="account-confirm-password"
							type="password"
							autoComplete="new-password"
							value={confirmPassword}
							onChange={(e) => setConfirmPassword(e.target.value)}
							disabled={isSaving}
							aria-invalid={mismatch}
						/>
						{mismatch && <FieldError match>Passwords do not match.</FieldError>}
					</Field>
					<SettingRow
						framed
						label="Sign out of other devices"
						description="End every session except this one."
						control={
							<Switch
								checked={signOutOfOtherSessions}
								onCheckedChange={setSignOutOfOtherSessions}
								disabled={isSaving}
							/>
						}
					/>
					<div className="flex justify-end">
						<Button size="sm" onClick={handleSubmit} loading={isSaving} disabled={!canSubmit}>
							{hasPassword ? "Change password" : "Set password"}
						</Button>
					</div>
				</div>
			</SettingsSection>
		</SettingsSections>
	)
}
