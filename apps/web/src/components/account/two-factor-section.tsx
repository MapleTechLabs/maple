import { useState } from "react"
import { useReverification, useUser } from "@clerk/clerk-react"
import { toastManager } from "@maple/ui/components/ui/toast"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { CopyableField } from "@maple/ui/components/ui/copyable-field"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { CircleCheckIcon, ShieldIcon } from "@/components/icons"
import { settleClerk, toastAccountError } from "@/components/account/account-errors"
import { SettingsSection, SettingsSections } from "@/components/settings/settings-section"
import { AccountSectionSkeleton } from "@/components/account/account-section-skeleton"
import { CodeField } from "@/components/account/code-field"
import { QrCode } from "@/components/account/qr-code"
import { REPLAY_BLOCK_CLASS } from "@/components/common/replay-privacy"
import { useAsyncAction } from "@/hooks/use-mutation-action"

/**
 * Enrollment is a three-step dialog. `uri`/`secret` come back from `createTOTP()` and are only
 * valid for that one attempt; `backupCodes` come back from `verifyTOTP()` and are never
 * retrievable again, which is why they get their own terminal step rather than a toast.
 */
type EnrollState =
	| { step: "closed" }
	| { step: "scan"; uri: string; secret: string }
	| { step: "verify"; uri: string; secret: string; code: string }
	| { step: "codes"; codes: ReadonlyArray<string> }

export function TwoFactorSection() {
	const { user, isLoaded } = useUser()

	const [enroll, setEnroll] = useState<EnrollState>({ step: "closed" })
	const [withBusy, isBusy] = useAsyncAction((task: () => Promise<void>) => task())
	const [disableOpen, setDisableOpen] = useState(false)

	const createTOTP = useReverification(() => user?.createTOTP())
	const disableTOTP = useReverification(() => user?.disableTOTP())
	const createBackupCode = useReverification(() => user?.createBackupCode())

	if (!isLoaded || !user) return <AccountSectionSkeleton />

	const { totpEnabled, backupCodeEnabled } = user

	function handleStartEnrollment() {
		return withBusy(async () => {
			const totp = await createTOTP().catch((err: unknown) => {
				toastAccountError(err, "Failed to start two-factor setup")
				return null
			})
			if (totp === null) return
			if (!totp?.uri || !totp.secret) {
				toastManager.add({ title: "Clerk did not return a setup key", type: "error" })
				return
			}
			setEnroll({ step: "scan", uri: totp.uri, secret: totp.secret })
		})
	}

	function handleVerify(code: string) {
		if (enroll.step !== "verify" || !user || code.length < 6) return
		return withBusy(async () => {
			await settleClerk(
				user.verifyTOTP({ code }).then((result) => {
					// Backup codes are minted alongside the first second factor and shown exactly once.
					// If Clerk returns none (backup codes disabled instance-wide), close out instead of
					// showing an empty list.
					const codes = result.backupCodes ?? []
					setEnroll(codes.length > 0 ? { step: "codes", codes } : { step: "closed" })
				}),
				{ success: "Two-factor authentication enabled", error: "That code did not match" },
			)
		})
	}

	function handleRegenerateBackupCodes() {
		return withBusy(async () => {
			const result = await createBackupCode().catch((err: unknown) => {
				toastAccountError(err, "Failed to generate backup codes")
				return null
			})
			if (!result) return
			setEnroll({ step: "codes", codes: result.codes })
			toastManager.add({ title: "New backup codes generated", type: "success" })
		})
	}

	function handleDisable() {
		return withBusy(async () => {
			const ok = await settleClerk(disableTOTP(), {
				success: "Two-factor authentication disabled",
				error: "Failed to disable two-factor authentication",
			})
			if (ok) setDisableOpen(false)
		})
	}

	return (
		<SettingsSections>
			<SettingsSection
				title="Authenticator app"
				description="Require a six-digit code from an authenticator app (1Password, Authy, Google Authenticator) in addition to your password when you sign in."
				actions={
					totpEnabled ? (
						<Badge variant="outline" className="gap-1">
							<CircleCheckIcon size={12} />
							Enabled
						</Badge>
					) : (
						<Badge variant="outline" className="text-muted-foreground">
							Not set up
						</Badge>
					)
				}
			>
				{totpEnabled ? (
					<div className="flex items-center justify-between gap-4">
						<p className="text-xs text-muted-foreground">
							Your authenticator app is registered for this account.
						</p>
						<Button
							variant="outline"
							size="sm"
							onClick={() => setDisableOpen(true)}
							disabled={isBusy}
						>
							Remove
						</Button>
					</div>
				) : (
					<Button size="sm" className="self-start" onClick={handleStartEnrollment} loading={isBusy}>
						<ShieldIcon data-icon="inline-start" />
						Set up authenticator
					</Button>
				)}
			</SettingsSection>

			{totpEnabled && (
				<SettingsSection
					title="Backup codes"
					description="Single-use codes for signing in when you cannot reach your authenticator. Generating a new set invalidates the old one."
					actions={backupCodeEnabled ? <Badge variant="secondary">Active</Badge> : undefined}
				>
					<Button
						variant="outline"
						size="sm"
						className="self-start"
						onClick={handleRegenerateBackupCodes}
						loading={isBusy}
					>
						{backupCodeEnabled ? "Regenerate codes" : "Generate codes"}
					</Button>
				</SettingsSection>
			)}

			<Dialog
				open={enroll.step !== "closed"}
				onOpenChange={(open) => {
					if (!open) setEnroll({ step: "closed" })
				}}
			>
				{/* Every step of enrollment shows a secret in plain text (QR, setup key, backup
				    codes), and the dashboard records itself with rrweb — block the whole dialog. */}
				<DialogContent className={REPLAY_BLOCK_CLASS}>
					{enroll.step === "scan" && (
						<>
							<DialogHeader>
								<DialogTitle>Scan this code</DialogTitle>
								<DialogDescription>
									Open your authenticator app and scan the code, or enter the setup key by
									hand.
								</DialogDescription>
							</DialogHeader>
							<DialogPanel>
								<div className="flex flex-col items-center gap-4">
									<div className="rounded-md border border-border bg-background p-3">
										<QrCode value={enroll.uri} className="size-44" />
									</div>
									<div className="w-full">
										<CopyableField
											value={enroll.secret}
											label="Setup key"
											copyLabel="Setup key"
										/>
									</div>
								</div>
							</DialogPanel>
							<DialogFooter>
								<Button variant="outline" onClick={() => setEnroll({ step: "closed" })}>
									Cancel
								</Button>
								<Button
									onClick={() =>
										setEnroll({
											step: "verify",
											uri: enroll.uri,
											secret: enroll.secret,
											code: "",
										})
									}
								>
									Continue
								</Button>
							</DialogFooter>
						</>
					)}

					{enroll.step === "verify" && (
						<>
							<DialogHeader>
								<DialogTitle>Enter the code</DialogTitle>
								<DialogDescription>
									Type the six-digit code your authenticator app is showing now.
								</DialogDescription>
							</DialogHeader>
							<DialogPanel>
								<CodeField
									value={enroll.code}
									onValueChange={(code) => setEnroll({ ...enroll, code })}
									onValueComplete={(code) => void handleVerify(code)}
									label="Authenticator code"
								/>
							</DialogPanel>
							<DialogFooter>
								<Button
									variant="outline"
									disabled={isBusy}
									onClick={() =>
										setEnroll({
											step: "scan",
											uri: enroll.uri,
											secret: enroll.secret,
										})
									}
								>
									Back
								</Button>
								<Button
									onClick={() => void handleVerify(enroll.code)}
									loading={isBusy}
									disabled={enroll.code.length < 6}
								>
									Verify
								</Button>
							</DialogFooter>
						</>
					)}

					{enroll.step === "codes" && (
						<>
							<DialogHeader>
								<DialogTitle>Save your backup codes</DialogTitle>
								<DialogDescription>
									Each code works once. This is the only time they are shown, so store them
									somewhere safe before closing.
								</DialogDescription>
							</DialogHeader>
							<DialogPanel>
								<div className="grid grid-cols-2 gap-1.5 rounded-md border border-border bg-muted/30 p-3 font-mono text-xs">
									{enroll.codes.map((code) => (
										<span key={code}>{code}</span>
									))}
								</div>
							</DialogPanel>
							<DialogFooter>
								<CopyButton
									value={enroll.codes.join("\n")}
									label="Backup codes"
									idleLabel="Copy all"
									variant="outline"
								/>
								<Button onClick={() => setEnroll({ step: "closed" })}>I saved them</Button>
							</DialogFooter>
						</>
					)}
				</DialogContent>
			</Dialog>

			<ConfirmDialog
				open={disableOpen}
				onOpenChange={setDisableOpen}
				title="Remove two-factor authentication?"
				description="Your account will be protected by your password alone, and your backup codes stop working."
				confirmLabel="Remove"
				pending={isBusy}
				onConfirm={() => void handleDisable()}
			/>
		</SettingsSections>
	)
}
