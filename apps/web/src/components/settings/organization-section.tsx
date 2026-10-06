import { useAtomSet } from "@/lib/effect-atom"
import { useEffect, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useAuth, useOrganization, useOrganizationList } from "@clerk/clerk-react"
import { toastManager } from "@maple/ui/components/ui/toast"

import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { UserIcon } from "@/components/icons"
import { ImageDropzone, TypeToConfirmField } from "@/components/common/image-dropzone"
import { toastAccountError } from "@/components/account/account-errors"
import { AccountSectionSkeleton } from "@/components/account/account-section-skeleton"
import { toastExit } from "@/lib/error-toast"
import { OrgAvatar } from "@/components/dashboard/org-switcher-menu"
import { RegionBadge } from "@/components/region/region-badge"
import { organizationHomeRegion } from "@maple/domain/organization-regions"
import { MAPLE_REGION_LABELS } from "@/lib/region"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

export function OrganizationSection() {
	const { orgRole } = useAuth()
	const { organization, isLoaded } = useOrganization()
	const { setActive, userMemberships } = useOrganizationList({
		userMemberships: { infinite: true },
	})
	const navigate = useNavigate()

	const isAdmin = orgRole === "org:admin"

	const [name, setName] = useState("")
	const [isSavingName, setIsSavingName] = useState(false)
	const [isSavingLogo, setIsSavingLogo] = useState(false)
	const [deleteOpen, setDeleteOpen] = useState(false)
	const [confirmText, setConfirmText] = useState("")
	const [isDeleting, setIsDeleting] = useState(false)

	useEffect(() => {
		setName(organization?.name ?? "")
	}, [organization?.id, organization?.name])

	const deleteMutation = useAtomSet(MapleApiAtomClient.mutation("organizations", "delete"), {
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

	async function handleRename() {
		if (!organization || !nameDirty) return
		setIsSavingName(true)
		try {
			await organization.update({ name: trimmedName })
			toastManager.add({ title: "Organization renamed", type: "success" })
		} catch (err) {
			toastAccountError(err, "Failed to rename organization")
		} finally {
			setIsSavingName(false)
		}
	}

	async function handleLogoSelect(file: File) {
		if (!organization || !isAdmin || isSavingLogo) return
		setIsSavingLogo(true)
		try {
			await organization.setLogo({ file })
			toastManager.add({ title: "Organization logo updated", type: "success" })
		} catch (err) {
			toastAccountError(err, "Failed to update logo")
		} finally {
			setIsSavingLogo(false)
		}
	}

	async function handleRemoveLogo() {
		if (!organization || !isAdmin || isSavingLogo) return
		setIsSavingLogo(true)
		try {
			await organization.setLogo({ file: null })
			toastManager.add({ title: "Organization logo removed", type: "success" })
		} catch (err) {
			toastAccountError(err, "Failed to remove logo")
		} finally {
			setIsSavingLogo(false)
		}
	}

	async function handleDelete() {
		if (!organization || !confirmMatches) return
		setIsDeleting(true)
		const result = await deleteMutation({})
		if (toastExit(result, { error: "Failed to delete organization" })) {
			const remaining = (userMemberships?.data ?? []).filter(
				(m) => m.organization.id !== organization.id,
			)
			const next = remaining[0]?.organization.id ?? null
			try {
				if (setActive) await setActive({ organization: next })
			} catch {
				// fall through to navigation; Clerk session will refresh on next load
			}
			toastManager.add({ title: "Organization deleted", type: "success" })
			setIsDeleting(false)
			setDeleteOpen(false)
			setConfirmText("")
			navigate({ to: "/" })
			return
		}
		setIsDeleting(false)
	}

	function handleDialogChange(open: boolean) {
		setDeleteOpen(open)
		if (!open) setConfirmText("")
	}

	return (
		<div className="space-y-6">
			<Card>
				<CardHeader>
					<CardTitle>General</CardTitle>
					<CardDescription>
						{isAdmin
							? "Update your organization's logo and name. Changes are visible to all members."
							: "Only org admins can change these settings."}
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="space-y-4 max-w-md">
						<div className="space-y-1.5">
							<Label>Logo</Label>
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
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="org-name">Name</Label>
							<Input
								id="org-name"
								value={name}
								onChange={(e) => setName(e.target.value)}
								disabled={!isAdmin || isSavingName}
								placeholder="Organization name"
							/>
						</div>
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
				</CardContent>
			</Card>

			<Card className="border-destructive/40">
				<CardHeader>
					<CardTitle className="text-destructive">Danger Zone</CardTitle>
					<CardDescription>
						Permanently delete this organization, its dashboards, alerts, API keys, and all
						associated data. Telemetry already sent to Maple will age out per its retention
						policy. This cannot be undone.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="flex items-center justify-between gap-4">
						<div className="text-xs text-muted-foreground">
							{isAdmin
								? `Delete "${organization.name}" and remove every member's access.`
								: "Only org admins can delete the organization."}
						</div>
						<Button
							variant="destructive"
							size="sm"
							disabled={!isAdmin}
							onClick={() => setDeleteOpen(true)}
						>
							Delete organization
						</Button>
					</div>
				</CardContent>
			</Card>

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
		</div>
	)
}

function DataRegionRow({ metadata }: { metadata: unknown }) {
	const region = organizationHomeRegion(metadata)
	return (
		<div className="space-y-1.5">
			<Label>Data region</Label>
			<div className="flex items-center gap-2 text-sm">
				<RegionBadge region={region} />
				<span>{MAPLE_REGION_LABELS[region].name}</span>
			</div>
			<p className="text-xs text-muted-foreground">
				Chosen when the organization was created. All of its telemetry is stored and processed in this
				region.
			</p>
		</div>
	)
}
