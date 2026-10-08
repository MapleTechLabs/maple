import { useAtomSet } from "@/lib/effect-atom"
import { useEffect, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useAuth, useOrganization, useOrganizationList } from "@clerk/clerk-react"
import { toastManager } from "@maple/ui/components/ui/toast"
import { Panel } from "@maple/ui/components/ui/panel"
import { Field, FieldLabel, FieldDescription } from "@maple/ui/components/ui/field"

import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { UserIcon } from "@/components/icons"
import { ImageDropzone, TypeToConfirmField } from "@/components/common/image-dropzone"
import { settleClerk } from "@/components/account/account-errors"
import { SettingsSection, SettingsSections } from "@/components/settings/settings-section"
import { AccountSectionSkeleton } from "@/components/account/account-section-skeleton"
import { toastExit } from "@/lib/error-toast"
import { OrgAvatar } from "@/components/dashboard/org-switcher-menu"
import { RegionBadge } from "@/components/region/region-badge"
import { organizationHomeRegion } from "@maple/domain/organization-regions"
import { MAPLE_REGION_LABELS } from "@/lib/region"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"
import { useAsyncAction } from "@/hooks/use-mutation-action"

export function OrganizationSection() {
	const { orgRole } = useAuth()
	const { organization, isLoaded } = useOrganization()
	const { setActive, userMemberships } = useOrganizationList({
		userMemberships: { infinite: true },
	})
	const navigate = useNavigate()

	const isAdmin = orgRole === "org:admin"

	const [name, setName] = useState("")
	const [withSavingName, isSavingName] = useAsyncAction((task: () => Promise<boolean>) => task())
	const [withSavingLogo, isSavingLogo] = useAsyncAction((task: () => Promise<boolean>) => task())
	const [deleteOpen, setDeleteOpen] = useState(false)
	const [confirmText, setConfirmText] = useState("")
	const [withDeleting, isDeleting] = useAsyncAction((task: () => Promise<void>) => task())

	useEffect(() => {
		setName(organization?.name ?? "")
	}, [organization?.id, organization?.name])

	const deleteMutation = useAtomSet(MapleInternalAtomClient.mutation("organizations", "delete"), {
		mode: "promiseExit",
	})

	if (!isLoaded) return <AccountSectionSkeleton />

	if (!organization) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyMedia>
						<UserIcon size={20} />
					</EmptyMedia>
					<EmptyTitle>No organization</EmptyTitle>
					<EmptyDescription>
						Select or create an organization to manage its settings.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		)
	}

	const trimmedName = name.trim()
	const nameDirty = trimmedName.length > 0 && trimmedName !== organization.name
	const confirmMatches = confirmText.trim() === organization.name

	function handleRename() {
		if (!organization || !nameDirty) return
		return withSavingName(() =>
			settleClerk(organization.update({ name: trimmedName }), {
				success: "Organization renamed",
				error: "Failed to rename organization",
			}),
		)
	}

	function handleLogoSelect(file: File) {
		if (!organization || !isAdmin || isSavingLogo) return
		return withSavingLogo(() =>
			settleClerk(organization.setLogo({ file }), {
				success: "Organization logo updated",
				error: "Failed to update logo",
			}),
		)
	}

	function handleRemoveLogo() {
		if (!organization || !isAdmin || isSavingLogo) return
		return withSavingLogo(() =>
			settleClerk(organization.setLogo({ file: null }), {
				success: "Organization logo removed",
				error: "Failed to remove logo",
			}),
		)
	}

	function handleDelete() {
		if (!organization || !confirmMatches) return
		return withDeleting(async () => {
			const result = await deleteMutation({})
			if (toastExit(result, { error: "Failed to delete organization" })) {
				const remaining = (userMemberships?.data ?? []).filter(
					(m) => m.organization.id !== organization.id,
				)
				const next = remaining[0]?.organization.id ?? null
				// A failed switch falls through to navigation; Clerk's session refreshes on next load.
				if (setActive) await setActive({ organization: next }).catch(() => undefined)
				toastManager.add({ title: "Organization deleted", type: "success" })
				setDeleteOpen(false)
				setConfirmText("")
				navigate({ to: "/" })
			}
		})
	}

	function handleDialogChange(open: boolean) {
		setDeleteOpen(open)
		if (!open) setConfirmText("")
	}

	return (
		<SettingsSections>
			<SettingsSection
				title="General"
				description={
					isAdmin
						? "Update your organization's logo and name. Changes are visible to all members."
						: "Only org admins can change these settings."
				}
			>
				<div className="max-w-md space-y-4">
					<Field>
						<FieldLabel>Logo</FieldLabel>
						<ImageDropzone
							preview={
								<OrgAvatar
									name={organization.name}
									imageUrl={organization.imageUrl}
									className="size-full"
									fit="contain"
								/>
							}
							onFile={(file) => void handleLogoSelect(file)}
							onRemove={organization.hasImage ? () => void handleRemoveLogo() : undefined}
							uploading={isSavingLogo}
							disabled={!isAdmin}
							targetLabel="Change organization logo"
							changeLabel="Change logo"
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="org-name">Name</FieldLabel>
						<Input
							id="org-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							disabled={!isAdmin || isSavingName}
							placeholder="Organization name"
						/>
					</Field>
					<div className="flex justify-end">
						<Button
							size="sm"
							onClick={handleRename}
							loading={isSavingName}
							disabled={!isAdmin || !nameDirty}
						>
							Save
						</Button>
					</div>
					<DataRegionRow metadata={organization.publicMetadata} />
				</div>
			</SettingsSection>

			<SettingsSection
				title="Danger zone"
				description="Permanently delete this organization, its dashboards, alerts, API keys, and all associated data. Telemetry already sent to Maple will age out per its retention policy. This cannot be undone."
				framed={false}
			>
				<Panel padded className="flex-row items-center justify-between gap-4 border-destructive/40">
					<p className="text-xs text-muted-foreground">
						{isAdmin
							? `Delete "${organization.name}" and remove every member's access.`
							: "Only org admins can delete the organization."}
					</p>
					<Button
						variant="destructive"
						size="sm"
						disabled={!isAdmin}
						onClick={() => setDeleteOpen(true)}
					>
						Delete organization
					</Button>
				</Panel>
			</SettingsSection>

			<ConfirmDialog
				open={deleteOpen}
				onOpenChange={handleDialogChange}
				title="Delete organization?"
				description="All dashboards, alerts, API keys, ingest keys, and integrations for this org will be permanently deleted. This cannot be undone."
				confirmLabel="Delete organization"
				pending={isDeleting}
				confirmDisabled={!confirmMatches}
				onConfirm={() => void handleDelete()}
			>
				<TypeToConfirmField
					id="org-delete-confirm"
					expected={organization.name}
					value={confirmText}
					onChange={setConfirmText}
				/>
			</ConfirmDialog>
		</SettingsSections>
	)
}

function DataRegionRow({ metadata }: { metadata: unknown }) {
	const region = organizationHomeRegion(metadata)
	return (
		<Field>
			<FieldLabel>Data region</FieldLabel>
			<div className="flex items-center gap-2 text-sm">
				<RegionBadge region={region} />
				<span>{MAPLE_REGION_LABELS[region].name}</span>
			</div>
			<FieldDescription>
				Chosen when the organization was created. All of its telemetry is stored and processed in this
				region.
			</FieldDescription>
		</Field>
	)
}
