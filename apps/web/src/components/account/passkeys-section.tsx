import { useState } from "react"
import { useReverification, useUser } from "@clerk/clerk-react"
import type { Passkey } from "@/components/account/account-types"
import { Field, FieldLabel } from "@maple/ui/components/ui/field"

import { Button } from "@maple/ui/components/ui/button"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { DropdownMenuItem } from "@maple/ui/components/ui/dropdown-menu"
import { FormDialog } from "@maple/ui/components/ui/form-dialog"
import { Input } from "@maple/ui/components/ui/input"
import { RowActionsMenu } from "@maple/ui/components/ui/row-actions-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
	TruncatedCell,
} from "@maple/ui/components/ui/table"
import { TruncatedText } from "@maple/ui/components/ui/truncated-text"
import { FingerprintIcon, PencilIcon, PlusIcon, TrashIcon } from "@/components/icons"
import { settleClerk } from "@/components/account/account-errors"
import { SettingsSection, SettingsSections } from "@/components/settings/settings-section"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatDateInTimezone } from "@/lib/timezone-format"
import { AccountSectionSkeleton } from "@/components/account/account-section-skeleton"
import { useAsyncAction } from "@/hooks/use-mutation-action"

/**
 * `@clerk/shared/webauthn` exports `isWebAuthnSupported()`, but it is not a declared dependency
 * of this app. The presence of `PublicKeyCredential` is the same check.
 */
const isWebAuthnSupported = () => typeof window !== "undefined" && "PublicKeyCredential" in window

export function PasskeysSection() {
	const { user, isLoaded } = useUser()

	const [withBusy, isBusy] = useAsyncAction((task: () => Promise<void>) => task())
	const [renaming, setRenaming] = useState<{ passkey: Passkey; name: string } | null>(null)
	const [pendingRemoval, setPendingRemoval] = useState<Passkey | null>(null)
	const { effectiveTimezone } = useTimezonePreference()

	const createPasskey = useReverification(() => user?.createPasskey())
	const deletePasskey = useReverification((passkey: Passkey) => passkey.delete())

	if (!isLoaded || !user) return <AccountSectionSkeleton />

	const supported = isWebAuthnSupported()
	const passkeys = user.passkeys

	function handleCreate() {
		// `createPasskey()` takes no name: Clerk derives one from the authenticator, and it is
		// renamed afterwards if the user wants something clearer.
		return withBusy(async () => {
			await settleClerk(createPasskey(), { success: "Passkey added", error: "Failed to add a passkey" })
		})
	}

	function handleRename() {
		if (!renaming) return
		const name = renaming.name.trim()
		if (name.length === 0) return
		const passkey = renaming.passkey
		return withBusy(async () => {
			const ok = await settleClerk(passkey.update({ name }), {
				success: "Passkey renamed",
				error: "Failed to rename passkey",
			})
			if (ok) setRenaming(null)
		})
	}

	function handleRemove() {
		if (!pendingRemoval) return
		const passkey = pendingRemoval
		return withBusy(async () => {
			const ok = await settleClerk(deletePasskey(passkey), {
				success: "Passkey removed",
				error: "Failed to remove passkey",
			})
			if (ok) setPendingRemoval(null)
		})
	}

	const formatDate = (date: Date) => formatDateInTimezone(date, { timeZone: effectiveTimezone })

	return (
		<SettingsSections>
			<SettingsSection
				title="Passkeys"
				description="Sign in with Touch ID, Windows Hello, a phone or a hardware key instead of a password."
				padded={!supported || passkeys.length === 0}
				actions={
					<Button size="sm" onClick={handleCreate} disabled={isBusy || !supported}>
						<PlusIcon data-icon="inline-start" />
						Add passkey
					</Button>
				}
			>
				{!supported ? (
					<p className="text-sm text-muted-foreground">
						This browser does not support passkeys. Open Maple in a recent version of Chrome,
						Safari, Edge or Firefox over HTTPS to register one.
					</p>
				) : passkeys.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia>
								<FingerprintIcon size={20} />
							</EmptyMedia>
							<EmptyTitle>No passkeys</EmptyTitle>
							<EmptyDescription>Add one to sign in without typing a password.</EmptyDescription>
						</EmptyHeader>
						<Button size="sm" onClick={handleCreate} disabled={isBusy}>
							<PlusIcon data-icon="inline-start" />
							Add passkey
						</Button>
					</Empty>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Name</TableHead>
								<TableHead>Added</TableHead>
								<TableHead>Last used</TableHead>
								<TableHead className="w-10" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{passkeys.map((passkey) => (
								<TableRow key={passkey.id}>
									<TruncatedCell>
										<div className="flex items-center gap-2.5">
											<FingerprintIcon
												size={16}
												className="shrink-0 text-muted-foreground"
											/>
											<TruncatedText
												text={passkey.name || "Unnamed passkey"}
												className="text-xs font-medium"
											/>
										</div>
									</TruncatedCell>
									<TableCell className="text-muted-foreground text-xs">
										{formatDate(passkey.createdAt)}
									</TableCell>
									<TableCell className="text-muted-foreground text-xs">
										{passkey.lastUsedAt ? formatDate(passkey.lastUsedAt) : "Never"}
									</TableCell>
									<TableCell>
										<RowActionsMenu label={`Actions for ${passkey.name ?? "passkey"}`}>
											<DropdownMenuItem
												disabled={isBusy}
												onClick={() =>
													setRenaming({
														passkey,
														name: passkey.name ?? "",
													})
												}
											>
												<PencilIcon size={14} />
												Rename
											</DropdownMenuItem>
											<DropdownMenuItem
												variant="destructive"
												disabled={isBusy}
												onClick={() => setPendingRemoval(passkey)}
											>
												<TrashIcon size={14} />
												Remove
											</DropdownMenuItem>
										</RowActionsMenu>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</SettingsSection>

			<FormDialog
				open={renaming !== null}
				onOpenChange={(open) => {
					if (!open) setRenaming(null)
				}}
				title="Rename passkey"
				description='Give it a name you will recognise, like "MacBook Touch ID".'
				onSubmit={() => void handleRename()}
				submitLabel="Save"
				pending={isBusy}
				submitDisabled={(renaming?.name.trim().length ?? 0) === 0}
			>
				<Field>
					<FieldLabel htmlFor="passkey-name">Name</FieldLabel>
					<Input
						id="passkey-name"
						value={renaming?.name ?? ""}
						onChange={(e) => setRenaming(renaming ? { ...renaming, name: e.target.value } : null)}
						disabled={isBusy}
						autoComplete="off"
					/>
				</Field>
			</FormDialog>

			<ConfirmDialog
				open={pendingRemoval !== null}
				onOpenChange={(open) => {
					if (!open) setPendingRemoval(null)
				}}
				title="Remove passkey?"
				description={`${pendingRemoval?.name ?? "This passkey"} can no longer be used to sign in. The credential stays on your device until you delete it there too.`}
				confirmLabel="Remove"
				pending={isBusy}
				onConfirm={() => void handleRemove()}
			/>
		</SettingsSections>
	)
}
