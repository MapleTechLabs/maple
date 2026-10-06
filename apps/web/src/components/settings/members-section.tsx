// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
import { useOrganization, useAuth } from "@clerk/clerk-react"
import { useState } from "react"
import { toastManager } from "@maple/ui/components/ui/toast"

import { Button } from "@maple/ui/components/ui/button"
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@maple/ui/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { Avatar, AvatarFallback, AvatarImage } from "@maple/ui/components/ui/avatar"
import { Badge } from "@maple/ui/components/ui/badge"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { Skeleton, SkeletonList } from "@maple/ui/components/ui/skeleton"
import { toastAccountError } from "@/components/account/account-errors"
import { AccountSectionSkeleton } from "@/components/account/account-section-skeleton"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { PlusIcon, DotsVerticalIcon, TrashIcon, ShieldIcon, UserIcon, EnvelopeIcon } from "@/components/icons"

function getInitials(firstName?: string | null, lastName?: string | null) {
	const first = firstName?.[0] ?? ""
	const last = lastName?.[0] ?? ""
	return (first + last).toUpperCase() || "?"
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	year: "numeric",
})

function formatDate(date: Date) {
	return dateFormatter.format(date)
}

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
	const [inviteLoading, setInviteLoading] = useState(false)

	const [removeDialogOpen, setRemoveDialogOpen] = useState(false)
	const [memberToRemove, setMemberToRemove] = useState<{
		id: string
		name: string
		destroy: () => Promise<unknown>
	} | null>(null)
	const [removeLoading, setRemoveLoading] = useState(false)

	const isAdmin = orgRole === "org:admin"

	async function handleInvite() {
		if (!organization || !inviteEmail.trim()) return
		setInviteLoading(true)
		try {
			await organization.inviteMember({
				emailAddress: inviteEmail.trim(),
				role: inviteRole as "org:admin" | "org:member",
			})
			toastManager.add({ title: `Invitation sent to ${inviteEmail}`, type: "success" })
			setInviteEmail("")
			setInviteRole("org:member")
			setInviteOpen(false)
			invitations?.revalidate?.()
		} catch (err: unknown) {
			toastAccountError(err, "Failed to send invitation")
		} finally {
			setInviteLoading(false)
		}
	}

	async function handleRoleChange(
		currentRole: string,
		update: (params: { role: string }) => Promise<unknown>,
	) {
		const newRole = currentRole === "org:admin" ? "org:member" : "org:admin"
		try {
			await update({ role: newRole })
			toastManager.add({
				title: `Role updated to ${newRole === "org:admin" ? "Admin" : "Member"}`,
				type: "success",
			})
			memberships?.revalidate?.()
		} catch (err: unknown) {
			toastAccountError(err, "Failed to update role")
		}
	}

	async function handleRemoveMember() {
		if (!memberToRemove) return
		setRemoveLoading(true)
		try {
			await memberToRemove.destroy()
			toastManager.add({ title: `${memberToRemove.name} has been removed`, type: "success" })
			memberships?.revalidate?.()
		} catch (err: unknown) {
			toastAccountError(err, "Failed to remove member")
		} finally {
			setRemoveLoading(false)
			setRemoveDialogOpen(false)
			setMemberToRemove(null)
		}
	}

	async function handleRevokeInvitation(revoke: () => Promise<unknown>, email: string) {
		try {
			await revoke()
			toastManager.add({ title: `Invitation to ${email} revoked`, type: "success" })
			invitations?.revalidate?.()
		} catch (err: unknown) {
			toastAccountError(err, "Failed to revoke invitation")
		}
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

	return (
		<div className="space-y-6">
			<Card>
				<CardHeader>
					<CardTitle>Team Members</CardTitle>
					{isAdmin && (
						<CardAction>
							<Button size="sm" onClick={() => setInviteOpen(true)}>
								<PlusIcon size={14} />
								Invite
							</Button>
						</CardAction>
					)}
				</CardHeader>
				<CardContent>
					{memberList.length === 0 ? (
						<Empty>
							<EmptyHeader>
								<EmptyMedia>
									<UserIcon size={20} />
								</EmptyMedia>
								<EmptyTitle>No members</EmptyTitle>
								<EmptyDescription>This organization has no members yet.</EmptyDescription>
							</EmptyHeader>
							{isAdmin && (
								<Button size="sm" onClick={() => setInviteOpen(true)}>
									<PlusIcon size={14} />
									Invite
								</Button>
							)}
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
											<TableCell>
												<div className="flex items-center gap-3">
													<Avatar className="size-6">
														<AvatarImage src={userData?.imageUrl} />
														<AvatarFallback>
															{getInitials(
																userData?.firstName,
																userData?.lastName,
															)}
														</AvatarFallback>
													</Avatar>
													<div className="min-w-0">
														<div className="text-xs font-medium truncate">
															{memberName}
															{isCurrentUser && (
																<span className="text-muted-foreground ml-1">
																	(you)
																</span>
															)}
														</div>
														<div className="text-muted-foreground text-xs truncate">
															{userData?.identifier}
														</div>
													</div>
												</div>
											</TableCell>
											<TableCell>{roleBadge(member.role)}</TableCell>
											<TableCell className="text-muted-foreground text-xs">
												{formatDate(member.createdAt)}
											</TableCell>
											{isAdmin && (
												<TableCell>
													{!isCurrentUser && (
														<DropdownMenu>
															<DropdownMenuTrigger
																render={
																	<Button
																		variant="ghost"
																		size="icon"
																		className="size-7"
																	/>
																}
															>
																<DotsVerticalIcon size={14} />
															</DropdownMenuTrigger>
															<DropdownMenuContent align="end">
																<DropdownMenuItem
																	onClick={() =>
																		handleRoleChange(
																			member.role,
																			(params) => member.update(params),
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
															</DropdownMenuContent>
														</DropdownMenu>
													)}
												</TableCell>
											)}
										</TableRow>
									)
								})}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>

			{invitationList.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle>Pending Invitations</CardTitle>
						<CardDescription>
							Invitations that have been sent but not yet accepted.
						</CardDescription>
					</CardHeader>
					<CardContent>
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
										<TableCell>
											<div className="flex items-center gap-3">
												<Avatar className="size-6">
													<AvatarFallback>
														<EnvelopeIcon size={12} />
													</AvatarFallback>
												</Avatar>
												<span className="text-xs">{invitation.emailAddress}</span>
											</div>
										</TableCell>
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
														handleRevokeInvitation(
															() => invitation.revoke(),
															invitation.emailAddress,
														)
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
					</CardContent>
				</Card>
			)}

			<Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Invite member</DialogTitle>
						<DialogDescription>Send an invitation to join {organization.name}.</DialogDescription>
					</DialogHeader>
					<div className="space-y-4 px-6 py-2">
						<div className="space-y-2">
							<Label htmlFor="invite-email" className="text-xs font-medium">
								Email address
							</Label>
							<Input
								id="invite-email"
								type="email"
								placeholder="colleague@example.com"
								value={inviteEmail}
								onChange={(e) => setInviteEmail(e.target.value)}
								onKeyDown={(e) => e.stopPropagation()}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="invite-role" className="text-xs font-medium">
								Role
							</Label>
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
						</div>
					</div>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setInviteOpen(false)}
							disabled={inviteLoading}
						>
							Cancel
						</Button>
						<Button onClick={handleInvite} loading={inviteLoading} disabled={!inviteEmail.trim()}>
							Send invitation
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<ConfirmDialog
				open={removeDialogOpen}
				onOpenChange={setRemoveDialogOpen}
				title="Remove member?"
				description={`${memberToRemove?.name ?? ""} will lose access to this organization immediately. This action cannot be undone.`}
				confirmLabel="Remove member"
				pending={removeLoading}
				onConfirm={() => void handleRemoveMember()}
			/>
		</div>
	)
}
