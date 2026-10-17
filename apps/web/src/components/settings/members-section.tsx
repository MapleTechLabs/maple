// BOUNDARY: Clerk resource methods resolve to opaque results that are only awaited, never read.
import { useOrganization, useAuth } from "@clerk/clerk-react"
import { Fragment, useState } from "react"
import { Field, FieldLabel } from "@maple/ui/components/ui/field"

import { Button } from "@maple/ui/components/ui/button"
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
import { LoadMoreButton } from "@maple/ui/components/ui/list-footer"
import { initialsFrom } from "@maple/ui/lib/initials"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { Avatar, AvatarFallback, AvatarImage } from "@maple/ui/components/ui/avatar"
import { FormDialog } from "@maple/ui/components/ui/form-dialog"
import { Input } from "@maple/ui/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { DropdownMenuItem } from "@maple/ui/components/ui/dropdown-menu"
import { RowActionsMenu } from "@maple/ui/components/ui/row-actions-menu"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { Skeleton, SkeletonList } from "@maple/ui/components/ui/skeleton"
import { settleClerk } from "@/components/account/account-errors"
import { AccountSectionSkeleton } from "@/components/account/account-section-skeleton"
import { SettingsSection, SettingsSections } from "@/components/settings/settings-section"
import { AdminOnlyNotice, memberDisplayName } from "@/components/settings/admin-only-notice"
import { orgRoleLabel, roleChangePrompt, toOrgRole, type OrgRole } from "@/components/settings/org-membership"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import {
	ArrowRotateAnticlockwiseIcon,
	CircleInfoIcon,
	EnvelopeIcon,
	PlusIcon,
	TrashIcon,
	UserIcon,
} from "@/components/icons"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatDateInTimezone } from "@/lib/timezone-format"
import { useAsyncAction, useKeyedAsyncAction } from "@/hooks/use-mutation-action"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"

/** A role change waiting on the inline confirm strip under the member's row. */
interface PendingRoleChange {
	readonly memberId: string
	readonly name: string
	readonly next: OrgRole
	readonly update: (params: { role: OrgRole }) => Promise<unknown>
}

interface MemberToRemove {
	readonly name: string
	readonly destroy: () => Promise<unknown>
}

interface InvitationTarget {
	readonly email: string
	readonly id: string
	readonly role: OrgRole
	readonly revoke: () => Promise<unknown>
}

function RoleText({ role }: { role: string }) {
	return <span className="px-2.5 text-xs text-foreground">{orgRoleLabel(role)}</span>
}

export function MembersSection() {
	const { userId } = useAuth()
	const { organization, memberships, invitations, isLoaded } = useOrganization({
		memberships: { infinite: true },
		invitations: { infinite: true, status: ["pending"] },
	})

	const [inviteOpen, setInviteOpen] = useState(false)
	const [inviteEmail, setInviteEmail] = useState("")
	const [inviteRole, setInviteRole] = useState<OrgRole>("org:member")
	const [withInviteLoading, inviteLoading] = useAsyncAction((task: () => Promise<void>) => task())

	const [pendingRole, setPendingRole] = useState<PendingRoleChange | null>(null)
	const [withRoleSaving, roleSaving] = useAsyncAction((task: () => Promise<void>) => task())

	const [memberToRemove, setMemberToRemove] = useState<MemberToRemove | null>(null)
	const [withRemoveLoading, removeLoading] = useAsyncAction((task: () => Promise<void>) => task())

	const [invitationToRevoke, setInvitationToRevoke] = useState<InvitationTarget | null>(null)
	const [withRevokeLoading, revokeLoading] = useAsyncAction((task: () => Promise<void>) => task())
	const resending = useKeyedAsyncAction((_invitationId: string, task: () => Promise<void>) => task())
	const { effectiveTimezone } = useTimezonePreference()

	const isAdmin = useIsOrgAdmin()

	function handleInvite() {
		if (!organization || !inviteEmail.trim()) return
		return withInviteLoading(async () => {
			const ok = await settleClerk(
				organization.inviteMember({ emailAddress: inviteEmail.trim(), role: inviteRole }),
				{ success: `Invitation sent to ${inviteEmail}`, error: "Failed to send invitation" },
			)
			if (!ok) return
			setInviteEmail("")
			setInviteRole("org:member")
			setInviteOpen(false)
			void invitations?.revalidate?.()
		})
	}

	function handleConfirmRole() {
		if (!pendingRole) return
		return withRoleSaving(async () => {
			const ok = await settleClerk(pendingRole.update({ role: pendingRole.next }), {
				success: `${pendingRole.name} is now ${pendingRole.next === "org:admin" ? "an admin" : "a member"}`,
				error: "Failed to change role",
			})
			if (!ok) return
			setPendingRole(null)
			void memberships?.revalidate?.()
		})
	}

	function handleRemoveMember() {
		if (!memberToRemove) return
		return withRemoveLoading(async () => {
			// On failure the confirmation stays open with its member selected so the admin can retry.
			const ok = await settleClerk(memberToRemove.destroy(), {
				success: `${memberToRemove.name} removed`,
				error: "Failed to remove member",
			})
			if (!ok) return
			void memberships?.revalidate?.()
			setMemberToRemove(null)
		})
	}

	function handleRevokeInvitation() {
		if (!invitationToRevoke) return
		return withRevokeLoading(async () => {
			const ok = await settleClerk(invitationToRevoke.revoke(), {
				success: `Invitation to ${invitationToRevoke.email} revoked`,
				error: "Failed to revoke invitation",
			})
			if (!ok) return
			void invitations?.revalidate?.()
			setInvitationToRevoke(null)
		})
	}

	/** Clerk has no resend: revoke the old invitation, then invite the same email with the same role. */
	function handleResend(target: InvitationTarget) {
		if (!organization || resending.isPending(target.id)) return
		return resending.run(target.id, async () => {
			const revoked = await settleClerk(target.revoke(), { error: "Failed to resend invitation" })
			if (!revoked) return
			await settleClerk(organization.inviteMember({ emailAddress: target.email, role: target.role }), {
				success: `Invitation resent to ${target.email}`,
				error: `The old invitation was revoked but a new one could not be sent. Invite ${target.email} again.`,
			})
			void invitations?.revalidate?.()
		})
	}

	if (!isLoaded) {
		return (
			<AccountSectionSkeleton>
				<SkeletonList
					rows={3}
					gap="3"
					renderRow={() => (
						<div className="flex items-center gap-3">
							<Skeleton className="size-8 rounded-full" />
							<div className="space-y-1.5">
								<Skeleton className="h-3.5 w-32" />
								<Skeleton className="h-3 w-48" />
							</div>
						</div>
					)}
				/>
			</AccountSectionSkeleton>
		)
	}

	if (!organization) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyMedia>
						<UserIcon size={20} />
					</EmptyMedia>
					<EmptyTitle>No organization</EmptyTitle>
					<EmptyDescription>Select or create an organization to manage members.</EmptyDescription>
				</EmptyHeader>
			</Empty>
		)
	}

	const memberList = memberships?.data ?? []
	const invitationList = invitations?.data ?? []
	const columnCount = isAdmin ? 4 : 3
	const membersLoading =
		memberList.length === 0 && (memberships?.isLoading === true || memberships?.isFetching === true)

	const inviteButton = isAdmin ? (
		<Button size="sm" onClick={() => setInviteOpen(true)}>
			<PlusIcon data-icon="inline-start" />
			Invite member
		</Button>
	) : null

	return (
		<SettingsSections width="wide">
			<AdminOnlyNotice subject="members" />

			<SettingsSection
				width="wide"
				title="Members"
				description="Admins manage billing, keys and members."
				actions={inviteButton}
				padded={false}
			>
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Member</TableHead>
							<TableHead className="w-36">Role</TableHead>
							<TableHead className="w-36">Joined</TableHead>
							{isAdmin && <TableHead className="w-12" />}
						</TableRow>
					</TableHeader>
					<TableBody>
						{membersLoading &&
							Array.from({ length: 3 }, (_, index) => (
								<TableRow key={`skeleton-${index}`}>
									<TableCell>
										<div className="flex items-center gap-3">
											<Skeleton className="size-6 rounded-full" />
											<div className="space-y-1.5">
												<Skeleton className="h-3 w-32" />
												<Skeleton className="h-3 w-48" />
											</div>
										</div>
									</TableCell>
									<TableCell>
										<Skeleton className="h-3 w-16" />
									</TableCell>
									<TableCell>
										<Skeleton className="h-3 w-20" />
									</TableCell>
									{isAdmin && <TableCell />}
								</TableRow>
							))}
						{memberList.map((member) => {
							const userData = member.publicUserData
							const isCurrentUser = userData?.userId === userId
							const memberName = memberDisplayName(userData) ?? "Unknown"
							const canManage = isAdmin && !isCurrentUser
							const confirming = pendingRole?.memberId === member.id ? pendingRole : null
							const prompt = confirming ? roleChangePrompt(memberName, confirming.next) : null

							return (
								<Fragment key={member.id}>
									<TableRow>
										<TruncatedCell>
											<div className="flex items-center gap-3">
												<Avatar className="size-6 shrink-0">
													<AvatarImage src={userData?.imageUrl} />
													<AvatarFallback>
														{initialsFrom(memberName)}
													</AvatarFallback>
												</Avatar>
												<div className="min-w-0">
													<div className="flex min-w-0 text-xs font-medium">
														<TruncatedText text={memberName} />
														{isCurrentUser && (
															<span className="ml-1 shrink-0 text-muted-foreground">
																(you)
															</span>
														)}
													</div>
													<TruncatedText
														text={userData?.identifier ?? ""}
														className="text-xs text-muted-foreground"
													/>
												</div>
											</div>
										</TruncatedCell>
										<TableCell>
											{canManage ? (
												<Select
													value={toOrgRole(member.role)}
													onValueChange={(value) => {
														if (
															value === null ||
															value === toOrgRole(member.role)
														)
															return
														setPendingRole({
															memberId: member.id,
															name: memberName,
															next: toOrgRole(value),
															update: (params) => member.update(params),
														})
													}}
												>
													<SelectTrigger
														size="sm"
														aria-label={`Role of ${memberName}`}
														className={cn(
															"w-full min-w-0",
															confirming && "border-primary",
														)}
													>
														<SelectValue>{orgRoleLabel(member.role)}</SelectValue>
													</SelectTrigger>
													<SelectContent>
														<SelectItem value="org:member">Member</SelectItem>
														<SelectItem value="org:admin">Admin</SelectItem>
													</SelectContent>
												</Select>
											) : (
												<RoleText role={member.role} />
											)}
										</TableCell>
										<TableCell className="text-xs text-muted-foreground">
											{formatDateInTimezone(member.createdAt, {
												timeZone: effectiveTimezone,
											})}
										</TableCell>
										{isAdmin && (
											<TableCell>
												{canManage && (
													<RowActionsMenu label={`Actions for ${memberName}`}>
														<DropdownMenuItem
															variant="destructive"
															onClick={() =>
																setMemberToRemove({
																	name: memberName,
																	destroy: () => member.destroy(),
																})
															}
														>
															<TrashIcon />
															Remove
														</DropdownMenuItem>
													</RowActionsMenu>
												)}
											</TableCell>
										)}
									</TableRow>
									{confirming && prompt && (
										<TableRow className="border-l-2 border-l-primary bg-muted/40 hover:bg-muted/40">
											<TableCell colSpan={columnCount}>
												<div className="flex items-center justify-between gap-4 pl-9">
													<p className="flex items-center gap-2 text-xs text-foreground">
														<CircleInfoIcon className="size-3.5 shrink-0 text-primary" />
														{prompt.question}
													</p>
													<div className="flex shrink-0 items-center gap-1.5">
														<Button
															variant="ghost"
															size="sm"
															disabled={roleSaving}
															onClick={() => setPendingRole(null)}
														>
															Cancel
														</Button>
														<Button
															size="sm"
															loading={roleSaving}
															onClick={() => void handleConfirmRole()}
														>
															{prompt.confirmLabel}
														</Button>
													</div>
												</div>
											</TableCell>
										</TableRow>
									)}
								</Fragment>
							)
						})}
					</TableBody>
				</Table>
				{memberships?.hasNextPage && (
					<div className="flex justify-center border-t p-2">
						<LoadMoreButton
							variant="ghost"
							loading={memberships.isFetching}
							onClick={() => memberships.fetchNext?.()}
						/>
					</div>
				)}
			</SettingsSection>

			{invitationList.length > 0 && (
				<SettingsSection
					width="wide"
					title="Invitations"
					description="Sent but not yet accepted. Resend issues a fresh invitation and revokes the old one."
					padded={false}
				>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Email</TableHead>
								<TableHead className="w-36">Role</TableHead>
								<TableHead className="w-36">Invited</TableHead>
								{isAdmin && <TableHead className="w-12" />}
							</TableRow>
						</TableHeader>
						<TableBody>
							{invitationList.map((invitation) => {
								const target: InvitationTarget = {
									id: invitation.id,
									email: invitation.emailAddress,
									role: toOrgRole(invitation.role),
									revoke: () => invitation.revoke(),
								}
								const isResending = resending.isPending(invitation.id)
								return (
									<TableRow key={invitation.id}>
										<TruncatedCell>
											<div className="flex items-center gap-3">
												<Avatar className="size-6 shrink-0">
													<AvatarFallback>
														<EnvelopeIcon size={12} />
													</AvatarFallback>
												</Avatar>
												<TruncatedText
													text={invitation.emailAddress}
													className="text-xs"
												/>
											</div>
										</TruncatedCell>
										<TableCell>
											<RoleText role={invitation.role} />
										</TableCell>
										<TableCell className="text-xs text-muted-foreground">
											{formatRelativeTime(invitation.createdAt)}
										</TableCell>
										{isAdmin && (
											<TableCell>
												<RowActionsMenu
													label={`Actions for ${invitation.emailAddress}`}
												>
													<DropdownMenuItem
														disabled={isResending}
														onClick={() => void handleResend(target)}
													>
														<ArrowRotateAnticlockwiseIcon />
														{isResending ? "Resending" : "Resend"}
													</DropdownMenuItem>
													<DropdownMenuItem
														variant="destructive"
														disabled={isResending}
														onClick={() => setInvitationToRevoke(target)}
													>
														<TrashIcon />
														Revoke
													</DropdownMenuItem>
												</RowActionsMenu>
											</TableCell>
										)}
									</TableRow>
								)
							})}
						</TableBody>
					</Table>
					{invitations?.hasNextPage && (
						<div className="flex justify-center border-t p-2">
							<LoadMoreButton
								variant="ghost"
								loading={invitations.isFetching}
								onClick={() => invitations.fetchNext?.()}
							/>
						</div>
					)}
				</SettingsSection>
			)}

			<FormDialog
				open={inviteOpen}
				onOpenChange={setInviteOpen}
				title="Invite member"
				description={`Send an invitation to join ${organization.name}.`}
				onSubmit={() => void handleInvite()}
				submitLabel="Send invitation"
				pending={inviteLoading}
				submitDisabled={!inviteEmail.trim()}
			>
				<Field>
					<FieldLabel htmlFor="invite-email">Email address</FieldLabel>
					<Input
						id="invite-email"
						type="email"
						placeholder="colleague@example.com"
						value={inviteEmail}
						onChange={(e) => setInviteEmail(e.target.value)}
						onKeyDown={(e) => e.stopPropagation()}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor="invite-role">Role</FieldLabel>
					<Select value={inviteRole} onValueChange={(val) => val && setInviteRole(toOrgRole(val))}>
						<SelectTrigger id="invite-role" className="w-full">
							<SelectValue placeholder="Select role">{orgRoleLabel(inviteRole)}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="org:member">Member</SelectItem>
							<SelectItem value="org:admin">Admin</SelectItem>
						</SelectContent>
					</Select>
				</Field>
			</FormDialog>

			<ConfirmDialog
				open={invitationToRevoke !== null}
				onOpenChange={(open) => (open ? undefined : setInvitationToRevoke(null))}
				title="Revoke invitation?"
				description={`The invitation to ${invitationToRevoke?.email ?? ""} will stop working. You can invite them again later.`}
				confirmLabel="Revoke invitation"
				pending={revokeLoading}
				onConfirm={() => void handleRevokeInvitation()}
			/>

			<ConfirmDialog
				open={memberToRemove !== null}
				onOpenChange={(open) => (open ? undefined : setMemberToRemove(null))}
				title="Remove member?"
				description={`${memberToRemove?.name ?? ""} will lose access to this organization immediately. You can invite them again later.`}
				confirmLabel="Remove member"
				pending={removeLoading}
				onConfirm={() => void handleRemoveMember()}
			/>
		</SettingsSections>
	)
}
