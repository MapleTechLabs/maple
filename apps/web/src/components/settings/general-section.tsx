import { useAtomSet } from "@/lib/effect-atom"
import { useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useOrganization, useOrganizationList, useUser } from "@clerk/clerk-react"
import { toastManager } from "@maple/ui/components/ui/toast"
import { Panel } from "@maple/ui/components/ui/panel"
import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { UserIcon } from "@/components/icons"
import { ImageDropzone, TypeToConfirmField } from "@/components/common/image-dropzone"
import { settleClerk } from "@/components/account/account-errors"
import { SettingsSection, SettingsSections } from "@/components/settings/settings-section"
import { SettingsSaveBar } from "@/components/settings/settings-save-bar"
import { AdminOnlyNotice } from "@/components/settings/admin-only-notice"
import { useSettingsDraft } from "@/components/settings/settings-draft"
import { leaveEligibility } from "@/components/settings/org-membership"
import { AccountSectionSkeleton } from "@/components/account/account-section-skeleton"
import { toastExit } from "@/lib/error-toast"
import { OrgAvatar } from "@/components/dashboard/org-switcher-menu"
import { RegionBadge } from "@/components/region/region-badge"
import { organizationHomeRegion } from "@maple/domain/organization-regions"
import { MAPLE_REGION_LABELS } from "@/lib/region"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"

/**
 * What deleting an organization does, checked against `OrganizationService.delete`: the purged
 * tables, telemetry left to its retention, and what it keeps (the audit log, billing records and
 * UNPURGED_ORG_SCOPED_TABLES).
 */
const DELETION_FACTS = [
	{
		key: "Deleted",
		value: "Dashboards and share links, alert rules and destinations, API and ingest keys, MCP connections, integrations, error issues, scrape targets, code reviews and the data platform connection.",
		destructive: true,
	},
	{ key: "Ages out", value: "Telemetry already sent, under its retention.", destructive: false },
	{
		key: "Kept",
		value: "The audit log, billing records, and some history and settings: investigations, anomaly history, AI triage and escalation settings, attribute mappings and sampling.",
		destructive: false,
	},
] as const

function DeletionFacts() {
	return (
		<dl className="flex flex-col gap-1 text-xs">
			{DELETION_FACTS.map((fact) => (
				<div key={fact.key} className="flex gap-2">
					<dt
						className={
							fact.destructive
								? "w-16 shrink-0 text-destructive"
								: "w-16 shrink-0 text-muted-foreground"
						}
					>
						{fact.key}
					</dt>
					<dd className="text-foreground">{fact.value}</dd>
				</div>
			))}
		</dl>
	)
}

export function GeneralSection() {
	const { organization, isLoaded } = useOrganization()
	// Same params as AdminOnlyNotice, so both read one cached page; `count` is the admin total.
	const { memberships: admins } = useOrganization({ memberships: { role: ["org:admin"], pageSize: 1 } })
	const { setActive, userMemberships } = useOrganizationList({
		userMemberships: { infinite: true },
	})
	const { user } = useUser()
	const navigate = useNavigate()

	const isAdmin = useIsOrgAdmin()

	const nameDraft = useSettingsDraft(organization?.name ?? "")
	const [withSavingName, isSavingName] = useAsyncAction((task: () => Promise<boolean>) => task())
	const [withSavingLogo, isSavingLogo] = useAsyncAction((task: () => Promise<boolean>) => task())
	const [deleteOpen, setDeleteOpen] = useState(false)
	const [leaveOpen, setLeaveOpen] = useState(false)
	const [confirmText, setConfirmText] = useState("")
	const [withDeleting, isDeleting] = useAsyncAction((task: () => Promise<void>) => task())
	const [withLeaving, isLeaving] = useAsyncAction((task: () => Promise<void>) => task())

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

	const trimmedName = nameDraft.draft.trim()
	const confirmMatches = confirmText.trim() === organization.name
	const leave = leaveEligibility({ isAdmin, adminCount: admins?.count })

	/** After the org is gone for this user, switch to another one (or none) and go home. */
	async function switchAway(orgId: string) {
		// The org is gone, so a dirty name must not trip the unsaved changes guard on the way out.
		nameDraft.discard()
		const next =
			(userMemberships?.data ?? []).find((m) => m.organization.id !== orgId)?.organization.id ?? null
		// A failed switch falls through to navigation; Clerk's session refreshes on next load.
		if (setActive) await setActive({ organization: next }).catch(() => undefined)
		void navigate({ to: "/", ignoreBlocker: true })
	}

	function handleSaveName() {
		if (!organization || trimmedName.length === 0) return
		const sent = trimmedName
		return withSavingName(async () => {
			const submitted = nameDraft.submit()
			const ok = await settleClerk(organization.update({ name: sent }), {
				success: "Organization renamed",
				error: "Failed to rename organization",
			})
			if (ok) nameDraft.commit({ submitted, sent })
			else nameDraft.abort()
			return ok
		})
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
				toastManager.add({ title: "Organization deleted", type: "success" })
				setDeleteOpen(false)
				setConfirmText("")
				await switchAway(organization.id)
			}
		})
	}

	function handleLeave() {
		if (!organization || !user || leave !== "allowed") return
		return withLeaving(async () => {
			const ok = await settleClerk(user.leaveOrganization(organization.id), {
				success: `You left ${organization.name}`,
				error: "Failed to leave organization",
			})
			if (!ok) return
			setLeaveOpen(false)
			await switchAway(organization.id)
		})
	}

	function handleDeleteDialogChange(open: boolean) {
		setDeleteOpen(open)
		if (!open) setConfirmText("")
	}

	return (
		<SettingsSections>
			<AdminOnlyNotice subject="organization settings" />

			<SettingsSection
				title="Organization"
				description="Logo and name are visible to every member."
				padded={false}
			>
				<div className="divide-y">
					<div className="p-4">
						<ImageDropzone
							title="Logo"
							hint={
								isAdmin
									? "Saved as soon as you upload. PNG, JPG, WEBP or GIF, up to 10 MB."
									: null
							}
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
							readOnly={!isAdmin}
							targetLabel="Change organization logo"
							changeLabel="Change logo"
						/>
					</div>
					<div className="flex items-start gap-4 p-4">
						<div className="flex w-48 shrink-0 flex-col gap-1 pt-1.5">
							<Label htmlFor="org-name" className="text-sm font-medium">
								Name
							</Label>
							<p className="text-xs text-muted-foreground">
								Shown in the organization switcher.
							</p>
						</div>
						{isAdmin ? (
							<Input
								id="org-name"
								className="flex-1"
								value={nameDraft.draft}
								onChange={(e) => nameDraft.setDraft(e.target.value)}
								maxLength={100}
								disabled={isSavingName}
								placeholder="Organization name"
							/>
						) : (
							<p id="org-name" className="flex-1 pt-1.5 text-sm text-foreground">
								{organization.name}
							</p>
						)}
					</div>
				</div>
			</SettingsSection>

			<DataRegionSection metadata={organization.publicMetadata} />

			<SettingsSection title="Danger zone" framed={false}>
				<Panel className="divide-y border-destructive/40">
					<div className="flex items-center justify-between gap-4 p-4">
						<div className="space-y-1">
							<p className="text-sm font-medium text-foreground">Leave organization</p>
							<p className="text-xs text-muted-foreground">
								{leave === "last-admin"
									? "You are the only admin. Make another member an admin before you leave."
									: "You lose access until someone invites you again."}
							</p>
						</div>
						<Button
							variant="outline"
							size="sm"
							disabled={leave !== "allowed" || !user}
							onClick={() => setLeaveOpen(true)}
						>
							Leave organization
						</Button>
					</div>
					{isAdmin ? (
						<div className="flex items-start justify-between gap-6 p-4">
							<div className="flex flex-1 flex-col gap-2">
								<p className="text-sm font-medium text-foreground">Delete organization</p>
								<p className="text-xs text-muted-foreground">
									Permanently deletes "{organization.name}" and removes every member's
									access. This cannot be undone.
								</p>
								<DeletionFacts />
							</div>
							<Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
								Delete organization
							</Button>
						</div>
					) : null}
				</Panel>
			</SettingsSection>

			<SettingsSaveBar
				dirty={nameDraft.isDirty}
				pending={isSavingName}
				saveDisabled={trimmedName.length === 0}
				onDiscard={nameDraft.discard}
				onSave={() => void handleSaveName()}
			/>

			<ConfirmDialog
				open={leaveOpen}
				onOpenChange={setLeaveOpen}
				title={`Leave ${organization.name}?`}
				description="You lose access to its dashboards, alerts and settings until someone invites you again."
				confirmLabel="Leave organization"
				pending={isLeaving}
				onConfirm={() => void handleLeave()}
			/>

			<ConfirmDialog
				open={deleteOpen}
				onOpenChange={handleDeleteDialogChange}
				title="Delete organization?"
				description={`Permanently deletes "${organization.name}" and removes every member's access. This cannot be undone.`}
				confirmLabel="Delete organization"
				pending={isDeleting}
				confirmDisabled={!confirmMatches}
				onConfirm={() => void handleDelete()}
			>
				<div className="space-y-4">
					<DeletionFacts />
					<TypeToConfirmField
						id="org-delete-confirm"
						expected={organization.name}
						value={confirmText}
						onChange={setConfirmText}
					/>
				</div>
			</ConfirmDialog>
		</SettingsSections>
	)
}

function DataRegionSection({ metadata }: { metadata: unknown }) {
	const region = organizationHomeRegion(metadata)
	return (
		<SettingsSection
			title="Data region"
			description="Where this organization's telemetry is stored and processed."
		>
			<div className="flex items-center justify-between gap-4">
				<div className="flex items-center gap-2 text-sm">
					<RegionBadge region={region} />
					<span>{MAPLE_REGION_LABELS[region].name}</span>
				</div>
				<p className="text-xs text-muted-foreground">
					Set when the organization was created. It cannot be changed.
				</p>
			</div>
		</SettingsSection>
	)
}
