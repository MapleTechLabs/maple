import { useState } from "react"
import { useReverification, useUser } from "@clerk/clerk-react"
import type { EmailAddress } from "@/components/account/account-types"
import { Field, FieldLabel } from "@maple/ui/components/ui/field"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { DropdownMenuItem } from "@maple/ui/components/ui/dropdown-menu"
import { FormDialog } from "@maple/ui/components/ui/form-dialog"
import { Input } from "@maple/ui/components/ui/input"
import { RowActionsMenu } from "@maple/ui/components/ui/row-actions-menu"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { CircleCheckIcon, EnvelopeIcon, PlusIcon, TrashIcon } from "@/components/icons"
import { settleClerk, toastAccountError } from "@/components/account/account-errors"
import { SettingsSection, SettingsSections } from "@/components/settings/settings-section"
import { AccountSectionSkeleton } from "@/components/account/account-section-skeleton"
import { CodeField } from "@/components/account/code-field"
import { useAsyncAction } from "@/hooks/use-mutation-action"

/**
 * The add flow is a two-step dialog: create the address, then verify the emailed code. The
 * pending `EmailAddress` is carried in state between the steps because that resource
 * (not the user) is what `attemptVerification` is called on.
 */
type AddState =
	| { step: "closed" }
	| { step: "email"; value: string }
	| { step: "code"; address: EmailAddress; code: string }

export function EmailAddressesSection() {
	const { user, isLoaded } = useUser()

	const [add, setAdd] = useState<AddState>({ step: "closed" })
	const [withBusy, isBusy] = useAsyncAction((task: () => Promise<void>) => task())
	const [pendingRemoval, setPendingRemoval] = useState<EmailAddress | null>(null)

	const createEmailAddress = useReverification((email: string) => user?.createEmailAddress({ email }))
	const destroyEmailAddress = useReverification((address: EmailAddress) => address.destroy())

	if (!isLoaded || !user) return <AccountSectionSkeleton />

	const emails = user.emailAddresses
	const verifiedCount = emails.filter((e) => e.verification.status === "verified").length

	function handleCreate() {
		if (add.step !== "email") return
		const email = add.value.trim()
		if (email.length === 0) return
		return withBusy(() =>
			createEmailAddress(email)
				.then(async (address) => {
					if (!address) return
					await address.prepareVerification({ strategy: "email_code" })
					setAdd({ step: "code", address, code: "" })
				})
				.catch((err: unknown) => toastAccountError(err, "Failed to add email address")),
		)
	}

	function handleVerify(code: string) {
		if (add.step !== "code" || code.length < 6) return
		const address = add.address
		return withBusy(async () => {
			const ok = await settleClerk(address.attemptVerification({ code }), {
				success: "Email address verified",
				error: "That code did not match",
			})
			if (ok) setAdd({ step: "closed" })
		})
	}

	/** Re-open the code step for an address added earlier but never verified. */
	function handleResendVerification(address: EmailAddress) {
		return withBusy(async () => {
			const ok = await settleClerk(address.prepareVerification({ strategy: "email_code" }), {
				error: "Failed to send a verification code",
			})
			if (ok) setAdd({ step: "code", address, code: "" })
		})
	}

	/**
	 * Primary is a property of the *user*, not of the address: Clerk has no
	 * `emailAddress.setPrimary()`.
	 */
	function handleSetPrimary(address: EmailAddress) {
		if (!user) return
		return withBusy(async () => {
			await settleClerk(user.update({ primaryEmailAddressId: address.id }), {
				success: `${address.emailAddress} is now your primary email`,
				error: "Failed to change your primary email",
			})
		})
	}

	function handleRemove() {
		if (!pendingRemoval) return
		const address = pendingRemoval
		return withBusy(async () => {
			const ok = await settleClerk(destroyEmailAddress(address), {
				success: "Email address removed",
				error: "Failed to remove email address",
			})
			if (ok) setPendingRemoval(null)
		})
	}

	return (
		<SettingsSections>
			<SettingsSection
				title="Email addresses"
				description="Your primary address receives sign-in codes, alerts and digests. Others can be used to sign in."
				padded={false}
				actions={
					<Button size="sm" onClick={() => setAdd({ step: "email", value: "" })}>
						<PlusIcon data-icon="inline-start" />
						Add email
					</Button>
				}
			>
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Email</TableHead>
							<TableHead>Status</TableHead>
							<TableHead className="w-10" />
						</TableRow>
					</TableHeader>
					<TableBody>
						{emails.map((address) => {
							const isPrimary = address.id === user.primaryEmailAddressId
							const isVerified = address.verification.status === "verified"
							// Clerk requires at least one verified address, so the last one is undeletable.
							const canRemove = !isPrimary && !(isVerified && verifiedCount === 1)

							return (
								<TableRow key={address.id}>
									<TableCell className="font-medium text-xs">
										{address.emailAddress}
									</TableCell>
									<TableCell>
										<div className="flex items-center gap-1.5">
											{isPrimary && <Badge variant="secondary">Primary</Badge>}
											{isVerified ? (
												<Badge variant="outline" className="gap-1">
													<CircleCheckIcon size={12} />
													Verified
												</Badge>
											) : (
												<Badge variant="outline" className="text-muted-foreground">
													Unverified
												</Badge>
											)}
										</div>
									</TableCell>
									<TableCell>
										<RowActionsMenu label={`Actions for ${address.emailAddress}`}>
											{!isVerified && (
												<DropdownMenuItem
													disabled={isBusy}
													onClick={() => void handleResendVerification(address)}
												>
													<EnvelopeIcon />
													Verify
												</DropdownMenuItem>
											)}
											{!isPrimary && isVerified && (
												<DropdownMenuItem
													disabled={isBusy}
													onClick={() => void handleSetPrimary(address)}
												>
													<CircleCheckIcon />
													Set as primary
												</DropdownMenuItem>
											)}
											<DropdownMenuItem
												variant="destructive"
												disabled={isBusy || !canRemove}
												onClick={() => setPendingRemoval(address)}
											>
												<TrashIcon />
												Remove
											</DropdownMenuItem>
										</RowActionsMenu>
									</TableCell>
								</TableRow>
							)
						})}
					</TableBody>
				</Table>
			</SettingsSection>

			<FormDialog
				open={add.step !== "closed"}
				onOpenChange={(open) => {
					if (!open) setAdd({ step: "closed" })
				}}
				pending={isBusy}
				{...(add.step === "code"
					? {
							title: `Verify ${add.address.emailAddress}`,
							description: "Enter the six-digit code we just emailed to that address.",
							submitLabel: "Verify",
							submitDisabled: add.code.length < 6,
							onSubmit: () => void handleVerify(add.code),
						}
					: {
							title: "Add an email address",
							description: "We will send a six-digit code to confirm you own it.",
							submitLabel: "Send code",
							submitDisabled: add.step !== "email" || add.value.trim().length === 0,
							onSubmit: () => void handleCreate(),
						})}
			>
				{add.step === "code" ? (
					<CodeField
						value={add.code}
						onValueChange={(code) => setAdd({ ...add, code })}
						onValueComplete={(code) => void handleVerify(code)}
						label="Verification code"
					/>
				) : (
					<Field>
						<FieldLabel htmlFor="account-new-email">Email address</FieldLabel>
						<Input
							id="account-new-email"
							type="email"
							autoComplete="email"
							placeholder="you@example.com"
							value={add.step === "email" ? add.value : ""}
							onChange={(e) => setAdd({ step: "email", value: e.target.value })}
							disabled={isBusy}
						/>
					</Field>
				)}
			</FormDialog>

			<ConfirmDialog
				open={pendingRemoval !== null}
				onOpenChange={(open) => {
					if (!open) setPendingRemoval(null)
				}}
				title="Remove email address?"
				description={`${pendingRemoval?.emailAddress} can no longer be used to sign in or receive notifications from Maple.`}
				confirmLabel="Remove"
				pending={isBusy}
				onConfirm={() => void handleRemove()}
			/>
		</SettingsSections>
	)
}
