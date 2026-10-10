// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
import { useOrganization, useAuth } from "@clerk/clerk-react"
import { useState } from "react"
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
import { Avatar, AvatarFallback, AvatarImage } from "@maple/ui/components/ui/avatar"
import { Badge } from "@maple/ui/components/ui/badge"
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
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { PlusIcon, TrashIcon, ShieldIcon, UserIcon, EnvelopeIcon } from "@/components/icons"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatDateInTimezone } from "@/lib/timezone-format"
import { useAsyncAction } from "@/hooks/use-mutation-action"

function roleBadge(role: string) {
	if (role === "org:admin") {
		return <Badge variant="outline">Admin</Badge>
	}
	return <Badge variant="secondary">Member</Badge>
}

export function MembersSection() {
	const { orgRole, userId } = useAuth()
	const { organization, memberships, invitations, isLoaded } = useOrganization({
		memberships: { infinite: true },
		invitations: { infinite: true, status: ["pending"] },
	})

	const [inviteOpen, setInviteOpen] = useState(false)
	const [inviteEmail, setInviteEmail] = useState("")
	const [inviteRole, setInviteRole] = useState<string>("org:member")
	const [withInviteLoading, inviteLoading] = useAsyncAction((task: () => Promise<void>) => task())

	const [removeDialogOpen, setRemoveDialogOpen] = useState(false)
	const [memberToRemove, setMemberToRemove] = useState<{
		id: string
		name: string
		destroy: () => Promise<unknown>
	} | null>(null)
	const [withRemoveLoading, removeLoading] = useAsyncAction((task: () => Promise<void>) => task())

	const [invitationToRevoke, setInvitationToRevoke] = useState<{
		email: string
		revoke: () => Promise<unknown>
	} | null>(null)
	const [withRevokeLoading, revokeLoading] = useAsyncAction((task: () => Promise<void>) => task())
	const { effectiveTimezone } = useTimezonePreference()

	const isAdmin = orgRole === "org:admin"

	function handleInvite() {
		if (!organization || !inviteEmail.trim()) return
		return withInviteLoading(async () => {
			const ok = await settleClerk(
				organization.inviteMember({
					emailAddress: inviteEmail.trim(),
					role: inviteRole === "org:admin" ? "org:admin" : "org:member",
				}),
				{ success: `Invitation sent to ${inviteEmail}`, error: "Failed to send invitation" },
			)
			if (!ok) return
			setInviteEmail("")
			setInviteRole("org:member")
			setInviteOpen(false)
			invitations?.revalidate?.()
		})
	}

	async function handleRoleChange(
		currentRole: string,
		update: (params: { role: string }) => Promise<unknown>,
	) {
		const newRole = currentRole === "org:admin" ? "org:member" : "org:admin"
		const ok = await settleClerk(update({ role: newRole }), {
			success: `Role updated to ${newRole === "org:admin" ? "Admin" : "Member"}`,
			error: "Failed to update role",
		})
		if (ok) memberships?.revalidate?.()
	}

	function handleRemoveMember() {
		if (!memberToRemove) return
		return withRemoveLoading(async () => {
			// On failure the confirmation stays open with its member selected so the admin can retry.
			const ok = await settleClerk(memberToRemove.destroy(), {
				success: `${memberToRemove.name} has been removed`,
				error: "Failed to remove member",
			})
			if (!ok) return
			memberships?.revalidate?.()
			setRemoveDialogOpen(false)
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
			invitations?.revalidate?.()
			setInvitationToRevoke(null)
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
			<div>
				<Empty>
					<EmptyHeader>
						<EmptyMedia>
							<UserIcon size={20} />
						</EmptyMedia>
						<EmptyTitle>No organization</EmptyTitle>
						<EmptyDescription>
							Select or create an organization to manage members.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			</div>
		)
	}

	const memberList = memberships?.data ?? []
	const invitationList = invitations?.data ?? []

	const inviteButton = isAdmin ? (
		<Button size="sm" onClick={() => setInviteOpen(true)}>
			<PlusIcon data-icon="inline-start" />
			Invite member
		</Button>
	) : null

	return (
		<SettingsSections>
			<SettingsSection
				title="Team members"
				actions={memberList.length > 0 ? inviteButton : undefined}
				padded={memberList.length === 0}
			>
				{memberList.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia>
								<UserIcon size={20} />
							</EmptyMedia>
							<EmptyTitle>No members</EmptyTitle>
							<EmptyDescription>This organization has no members yet.</EmptyDescription>
						</EmptyHeader>
						{inviteButton}
					</Empty>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>User</TableHead>
								<TableHead>Role</TableHead>
								<TableHead>Joined</TableHead>
								{isAdmin && <TableHead className="w-10" />}
							</TableRow>
						</TableHeader>
						<TableBody>
							{memberList.map((member) => {
								const userData = member.publicUserData
								const isCurrentUser = userData?.userId === userId
								const memberName =
									[userData?.firstName, userData?.lastName].filter(Boolean).join(" ") ||
									userData?.identifier ||
									"Unknown"

								return (
									<TableRow key={member.id}>
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
															<span className="text-muted-foreground ml-1 shrink-0">
																(you)
															</span>
														)}
													</div>
													<TruncatedText
														text={userData?.identifier ?? ""}
														className="text-muted-foreground text-xs"
													/>
												</div>
											</div>
										</TruncatedCell>
										<TableCell>{roleBadge(member.role)}</TableCell>
										<TableCell className="text-muted-foreground text-xs">
											{formatDateInTimezone(member.createdAt, {
												timeZone: effectiveTimezone,
											})}
										</TableCell>
										{isAdmin && (
											<TableCell>
												{!isCurrentUser && (
													<RowActionsMenu label={`Actions for ${memberName}`}>
														<DropdownMenuItem
															onClick={() =>
																handleRoleChange(member.role, (params) =>
																	member.update(params),
																)
															}
														>
															<ShieldIcon size={14} />
															{member.role === "org:admin"
																? "Change to Member"
																: "Change to Admin"}
														</DropdownMenuItem>
														<DropdownMenuItem
															variant="destructive"
															onClick={() => {
																setMemberToRemove({
																	id: member.id,
																	name: memberName,
																	destroy: () => member.destroy(),
																})
																setRemoveDialogOpen(true)
															}}
														>
															<TrashIcon size={14} />
															Remove member
														</DropdownMenuItem>
													</RowActionsMenu>
												)}
											</TableCell>
										)}
									</TableRow>
								)
							})}
						</TableBody>
					</Table>
				)}
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
					title="Pending invitations"
					description="Invitations that have been sent but not yet accepted."
					padded={false}
				>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Email</TableHead>
								<TableHead>Role</TableHead>
								<TableHead>Status</TableHead>
								{isAdmin && <TableHead className="w-10" />}
							</TableRow>
						</TableHeader>
						<TableBody>
							{invitationList.map((invitation) => (
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
									<TableCell>{roleBadge(invitation.role)}</TableCell>
									<TableCell>
										<Badge variant="secondary">Pending</Badge>
									</TableCell>
									{isAdmin && (
										<TableCell>
											<Button
												variant="ghost"
												size="sm"
												className="text-destructive hover:text-destructive text-xs"
												onClick={() =>
													setInvitationToRevoke({
														email: invitation.emailAddress,
														revoke: () => invitation.revoke(),
													})
												}
											>
												Revoke
											</Button>
										</TableCell>
									)}
								</TableRow>
							))}
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
					<Select value={inviteRole} onValueChange={(val) => val && setInviteRole(val)}>
						<SelectTrigger id="invite-role" className="w-full">
							<SelectValue placeholder="Select role">
								{inviteRole === "org:admin" ? "Admin" : "Member"}
							</SelectValue>
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
				open={removeDialogOpen}
				onOpenChange={setRemoveDialogOpen}
				title="Remove member?"
				description={`${memberToRemove?.name ?? ""} will lose access to this organization immediately. This action cannot be undone.`}
				confirmLabel="Remove member"
				pending={removeLoading}
				onConfirm={() => void handleRemoveMember()}
			/>
		</SettingsSections>
	)
}
