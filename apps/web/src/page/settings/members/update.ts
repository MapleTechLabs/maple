import { toOrgRole } from "../../../components/settings/org-membership"
import { Array, Effect, Option, Result, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import type {
	ClerkInvitationResource,
	ClerkMembershipResource,
	ClerkOrganizationResource,
} from "../../../platform/clerk"
import { ClerkActionError, clerkTry, currentClerkOrganization } from "../../../platform/clerk"
import * as Dialog from "../../../ui/dialog"
import * as Field from "../../../ui/field"
import * as Menu from "../../../ui/menu"
import * as Select from "../../../ui/select"
import { PageOutMessage, type PageReturn } from "../../contract"
import { revisitData } from "../kit/revisit"
import { memberDisplayName, otherAdminName } from "../kit/members"
import { type InvitationRow, type MemberRow, Message, type Model, OrgRole } from "./model"

type Return = PageReturn<Model, Message>

/** Clerk's default page size for `useOrganization`'s infinite lists. */
const PAGE_SIZE = 10

const settleClerk =
	<B>(toMessage: (result: Result.Result<void, string>) => B) =>
	<A>(effect: Effect.Effect<A, ClerkActionError>) =>
		effect.pipe(
			Effect.asVoid,
			Effect.mapError((error) => error.message),
			Effect.result,
			Effect.map(toMessage),
		)

export const FetchOrganization = Command.define("FetchMembersOrganization", {
	messages: [Message.CompletedFetchOrganization],
	execute: Effect.sync(() =>
		Message.CompletedFetchOrganization({ name: window.Clerk?.organization?.name ?? null }),
	),
})

const FetchAdminName = Command.define("FetchMembersAdminName", {
	messages: [Message.CompletedFetchAdminName],
	execute: currentClerkOrganization.pipe(
		Effect.flatMap((organization) =>
			clerkTry("", () => organization.getMemberships({ role: ["org:admin"], pageSize: 2 })),
		),
		Effect.map((page) => otherAdminName(page.data, window.Clerk?.user?.id)),
		Effect.orElseSucceed(() => null),
		Effect.map((name) => Message.CompletedFetchAdminName({ name })),
	),
})

const memberRow = (member: ClerkMembershipResource, userId: string | null): MemberRow => ({
	id: member.id,
	name: memberDisplayName(member.publicUserData) ?? "Unknown",
	identifier: member.publicUserData?.identifier ?? "",
	// Clerk's generated silhouette is not the member's; the warm initials tile stands in.
	imageUrl: member.publicUserData?.hasImage === true ? member.publicUserData.imageUrl : "",
	role: member.role,
	createdAtMs: member.createdAt.getTime(),
	isCurrentUser: userId !== null && member.publicUserData?.userId === userId,
})

const invitationRow = (invitation: ClerkInvitationResource): InvitationRow => ({
	id: invitation.id,
	email: invitation.emailAddress,
	role: invitation.role,
	createdAtMs: invitation.createdAt.getTime(),
})

const membershipsPage = (organization: ClerkOrganizationResource, page: number) =>
	clerkTry("Couldn't load members", () =>
		organization.getMemberships({ initialPage: page, pageSize: PAGE_SIZE }),
	)

const invitationsPage = (organization: ClerkOrganizationResource, page: number) =>
	clerkTry("Couldn't load invitations", () =>
		organization.getInvitations({ initialPage: page, pageSize: PAGE_SIZE, status: ["pending"] }),
	)

const FetchMembers = Command.define("FetchClerkMemberships", {
	args: { page: Schema.Number, generation: Schema.Number },
	messages: [Message.CompletedFetchMembers],
	execute: ({ page, generation }) =>
		currentClerkOrganization.pipe(
			Effect.flatMap((organization) => membershipsPage(organization, page)),
			Effect.map((result) => {
				const userId = window.Clerk?.user?.id ?? null
				return {
					rows: result.data.map((member) => memberRow(member, userId)),
					total: result.total_count,
				}
			}),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchMembers({ page, generation, result })),
		),
})

const FetchInvitations = Command.define("FetchClerkInvitations", {
	args: { page: Schema.Number, generation: Schema.Number },
	messages: [Message.CompletedFetchInvitations],
	execute: ({ page, generation }) =>
		currentClerkOrganization.pipe(
			Effect.flatMap((organization) => invitationsPage(organization, page)),
			Effect.map((result) => ({ rows: result.data.map(invitationRow), total: result.total_count })),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchInvitations({ page, generation, result })),
		),
})

/** The resource behind a row: the list pages are read again until the id turns up. */
const findInPages = <A extends { readonly id: string }>(
	read: (
		page: number,
	) => Effect.Effect<{ readonly data: ReadonlyArray<A>; readonly total_count: number }, ClerkActionError>,
	id: string,
	page = 1,
): Effect.Effect<Option.Option<A>, ClerkActionError> =>
	Effect.flatMap(read(page), (result) => {
		const found = Array.findFirst(result.data, (item) => item.id === id)
		return Option.isSome(found) || page * PAGE_SIZE >= result.total_count
			? Effect.succeed(found)
			: findInPages(read, id, page + 1)
	})

const gone = (message: string) => new ClerkActionError({ message, cause: undefined })

const withMembership = <A>(
	id: string,
	use: (member: ClerkMembershipResource) => Effect.Effect<A, ClerkActionError>,
) =>
	currentClerkOrganization.pipe(
		Effect.flatMap((organization) => findInPages((page) => membershipsPage(organization, page), id)),
		Effect.flatMap(
			Option.match({
				onNone: () => Effect.fail(gone("That member is no longer in the organization")),
				onSome: use,
			}),
		),
	)

const withInvitation = <A>(
	id: string,
	use: (invitation: ClerkInvitationResource) => Effect.Effect<A, ClerkActionError>,
) =>
	currentClerkOrganization.pipe(
		Effect.flatMap((organization) => findInPages((page) => invitationsPage(organization, page), id)),
		Effect.flatMap(
			Option.match({
				onNone: () => Effect.fail(gone("That invitation is no longer pending")),
				onSome: use,
			}),
		),
	)

const InviteMember = Command.define("InviteClerkMember", {
	args: { email: Schema.String, role: OrgRole },
	messages: [Message.CompletedInvite],
	execute: ({ email, role }) =>
		currentClerkOrganization.pipe(
			Effect.flatMap((organization) =>
				clerkTry("Failed to send invitation", () =>
					organization.inviteMember({ emailAddress: email, role }),
				),
			),
			settleClerk((result) => Message.CompletedInvite({ email, result })),
		),
})

const ChangeRole = Command.define("ChangeClerkMemberRole", {
	args: { memberId: Schema.String, name: Schema.String, next: OrgRole },
	messages: [Message.CompletedRoleChange],
	execute: ({ memberId, name, next }) =>
		withMembership(memberId, (member) =>
			clerkTry("Failed to change role", () => member.update({ role: next })),
		).pipe(settleClerk((result) => Message.CompletedRoleChange({ name, next, result }))),
})

const RemoveMember = Command.define("RemoveClerkMember", {
	args: { memberId: Schema.String, name: Schema.String },
	messages: [Message.CompletedRemove],
	execute: ({ memberId, name }) =>
		withMembership(memberId, (member) =>
			clerkTry("Failed to remove member", () => member.destroy()),
		).pipe(settleClerk((result) => Message.CompletedRemove({ name, result }))),
})

const RevokeInvitation = Command.define("RevokeClerkInvitation", {
	args: { id: Schema.String, email: Schema.String },
	messages: [Message.CompletedRevoke],
	execute: ({ id, email }) =>
		withInvitation(id, (invitation) =>
			clerkTry("Failed to revoke invitation", () => invitation.revoke()),
		).pipe(settleClerk((result) => Message.CompletedRevoke({ email, result }))),
})

/** Clerk has no resend: revoke the old invitation, then invite the same email with the same role. */
const ResendInvitation = Command.define("ResendClerkInvitation", {
	args: { id: Schema.String, email: Schema.String, role: OrgRole },
	messages: [Message.CompletedResend],
	execute: ({ id, email, role }) =>
		Effect.gen(function* () {
			const revoked = yield* withInvitation(id, (invitation) =>
				clerkTry("Failed to resend invitation", () => invitation.revoke()),
			).pipe(Effect.result)
			if (Result.isFailure(revoked))
				return Message.CompletedResend({
					id,
					email,
					isRevoked: false,
					result: Result.fail(revoked.failure.message),
				})
			const sent = yield* currentClerkOrganization.pipe(
				Effect.flatMap((organization) =>
					clerkTry(
						`The old invitation was revoked but a new one could not be sent. Invite ${email} again.`,
						() => organization.inviteMember({ emailAddress: email, role }),
					),
				),
				settleClerk((result) => result),
			)
			return Message.CompletedResend({ id, email, isRevoked: true, result: sent })
		}),
})

const ROLE_VALUES = ["org:member", "org:admin"] as const

export const roleSelectFor = (model: Model, member: MemberRow): Select.Model =>
	model.roleSelects[member.id] ?? roleSelect(`member-role-${member.id}`, toOrgRole(member.role))

const roleSelect = (id: string, role: OrgRole): Select.Model =>
	Select.init(id, { value: role, selectedIndex: ROLE_VALUES.indexOf(role) })

export const init = (isAdmin: boolean): Return => ({
	model: {
		isAdmin,
		adminName: null,
		hasOrganization: null,
		orgName: "",
		members: AsyncData.Loading(),
		invitations: AsyncData.Loading(),
		membersGeneration: 0,
		invitationsGeneration: 0,
		inviteDialog: Dialog.init("invite-member", "dialog"),
		inviteEmail: Field.init(),
		inviteRole: roleSelect("invite-role", "org:member"),
		isInviting: false,
		roleSelects: {},
		pendingRole: null,
		isRoleSaving: false,
		rowMenus: {},
		removing: null,
		removeDialog: Dialog.init("member-remove", "alert-dialog"),
		isRemoving: false,
		revoking: null,
		revokeDialog: Dialog.init("invitation-revoke", "alert-dialog"),
		isRevoking: false,
		resending: [],
	},
	commands: [
		FetchOrganization(),
		FetchMembers({ page: 1, generation: 0 }),
		FetchInvitations({ page: 1, generation: 0 }),
		...(isAdmin ? [] : [FetchAdminName()]),
	],
})

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

const lift =
	<K extends "inviteDialog" | "removeDialog" | "revokeDialog">(
		key: K,
		wrap: (message: Dialog.Message) => Message,
	) =>
	(model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
		model: { ...model, [key]: step.model },
		commands: Command.mapMessages(step.commands ?? [], wrap),
	})

const liftInvite = lift("inviteDialog", (message) => Message.GotInviteDialogMessage({ message }))
const liftRemove = lift("removeDialog", (message) => Message.GotRemoveDialogMessage({ message }))
const liftRevoke = lift("revokeDialog", (message) => Message.GotRevokeDialogMessage({ message }))

/** A Load more in flight is abandoned: its answer is for the rows before the mutation. */
const stopPaging = <A extends { readonly isFetchingMore: boolean }, E>(data: AsyncData.AsyncData<A, E>) =>
	AsyncData.map(data, (list) => ({ ...list, isFetchingMore: false }))

/** `memberships.revalidate()`: the list reads again from its first page, dropping older answers. */
const revalidateMembers = (model: Model): Return => {
	const members = stopPaging(model.members)
	const generation = model.membersGeneration + 1
	return {
		model: {
			...model,
			members: Option.getOrElse(AsyncData.revalidate(members), () => members),
			membersGeneration: generation,
		},
		commands: [FetchMembers({ page: 1, generation })],
	}
}

const revalidateInvitations = (model: Model): Return => {
	const invitations = stopPaging(model.invitations)
	const generation = model.invitationsGeneration + 1
	return {
		model: {
			...model,
			invitations: Option.getOrElse(AsyncData.revalidate(invitations), () => invitations),
			invitationsGeneration: generation,
		},
		commands: [FetchInvitations({ page: 1, generation })],
	}
}

/** A page answer: the first page replaces the list, a later one appends to it. */
const mergePage = <A, E>(
	current: AsyncData.AsyncData<{ readonly rows: ReadonlyArray<A>; readonly total: number }, E>,
	page: number,
	next: { readonly rows: ReadonlyArray<A>; readonly total: number },
) => {
	const previous =
		page === 1
			? []
			: Option.match(AsyncData.getData(current), { onNone: () => [], onSome: (data) => data.rows })
	return { rows: [...previous, ...next.rows], total: next.total, page, isFetchingMore: false }
}

/**
 * A page answer: page 1 settles the slot; a failed later page keeps the rows and stops the
 * spinner, as Clerk's `fetchNext` does, so Load more can be pressed again.
 */
const settlePage = <A, E>(
	current: AsyncData.AsyncData<
		{
			readonly rows: ReadonlyArray<A>
			readonly total: number
			readonly page: number
			readonly isFetchingMore: boolean
		},
		E
	>,
	page: number,
	result: Result.Result<{ readonly rows: ReadonlyArray<A>; readonly total: number }, E>,
) =>
	page > 1 && Result.isFailure(result)
		? Option.match(AsyncData.getData(current), {
				onNone: () =>
					AsyncData.settle(
						current,
						Result.map(result, (next) => mergePage(current, page, next)),
					),
				onSome: (data) => AsyncData.Success({ data: { ...data, isFetchingMore: false } }),
			})
		: AsyncData.settle(
				current,
				Result.map(result, (next) => mergePage(current, page, next)),
			)

export const hasMore = (data: { readonly rows: ReadonlyArray<unknown>; readonly total: number }): boolean =>
	data.rows.length < data.total

const inviteRoleOf = (model: Model): OrgRole => toOrgRole(model.inviteRole.value)

const pickedRowAction = (model: Model, menuId: string, value: string): Return => {
	const memberId = menuId.startsWith("member-actions-") ? menuId.slice("member-actions-".length) : null
	if (memberId !== null) {
		const member = Option.flatMap(AsyncData.getData(model.members), (data) =>
			Array.findFirst(data.rows, (row) => row.id === memberId),
		)
		return Option.match(member, {
			onNone: () => ({ model }),
			onSome: (row) =>
				liftRemove(
					{ ...model, removing: { id: row.id, name: row.name } },
					Dialog.open(model.removeDialog),
				),
		})
	}
	const invitationId = menuId.slice("invitation-actions-".length)
	const invitation = Option.flatMap(AsyncData.getData(model.invitations), (data) =>
		Array.findFirst(data.rows, (row) => row.id === invitationId),
	)
	return Option.match(invitation, {
		onNone: () => ({ model }),
		onSome: (row) =>
			value === "revoke"
				? liftRevoke({ ...model, revoking: row }, Dialog.open(model.revokeDialog))
				: model.resending.includes(row.id)
					? { model }
					: {
							model: { ...model, resending: [...model.resending, row.id] },
							commands: [
								ResendInvitation({ id: row.id, email: row.email, role: toOrgRole(row.role) }),
							],
						},
	})
}

/** Back on the tab: members, invitations and the organization's name stay up while they load again. */
export const revisit = (model: Model): Return => {
	// A later page still in flight would append to a refreshed page 1, so that list waits for it.
	const isPaging = <A, E>(data: AsyncData.AsyncData<{ readonly isFetchingMore: boolean } & A, E>) =>
		Option.exists(AsyncData.getData(data), (list) => list.isFetchingMore)
	// Each page-1 read takes a new generation, so an older read can never land over a newer one.
	const members = isPaging(model.members)
		? { data: model.members, commands: [] }
		: revisitData(model.members, () => FetchMembers({ page: 1, generation: model.membersGeneration + 1 }))
	const invitations = isPaging(model.invitations)
		? { data: model.invitations, commands: [] }
		: revisitData(model.invitations, () =>
				FetchInvitations({ page: 1, generation: model.invitationsGeneration + 1 }),
			)
	return {
		model: {
			...model,
			members: members.data,
			invitations: invitations.data,
			membersGeneration: model.membersGeneration + (members.commands.length === 0 ? 0 : 1),
			invitationsGeneration: model.invitationsGeneration + (invitations.commands.length === 0 ? 0 : 1),
		},
		// The organization may have been renamed on General meanwhile.
		commands: [
			...members.commands,
			...invitations.commands,
			FetchOrganization(),
			...(model.isAdmin ? [] : [FetchAdminName()]),
		],
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		CompletedFetchOrganization: ({ name }) => ({
			model: { ...model, hasOrganization: name !== null, orgName: name ?? "" },
		}),
		CompletedFetchAdminName: ({ name }) => ({ model: { ...model, adminName: name } }),
		CompletedFetchMembers: ({ page, generation, result }) =>
			generation === model.membersGeneration
				? { model: { ...model, members: settlePage(model.members, page, result) } }
				: { model },
		CompletedFetchInvitations: ({ page, generation, result }) =>
			generation === model.invitationsGeneration
				? { model: { ...model, invitations: settlePage(model.invitations, page, result) } }
				: { model },
		ClickedLoadMoreMembers: () =>
			Option.match(AsyncData.getData(model.members), {
				onNone: () => ({ model }),
				onSome: (data) =>
					// While page 1 reads again (a revisit, a mutation) a later page would append to the wrong rows.
					data.isFetchingMore || AsyncData.isRefreshing(model.members)
						? { model }
						: {
								model: {
									...model,
									members: AsyncData.Success({ data: { ...data, isFetchingMore: true } }),
								},
								commands: [
									FetchMembers({
										page: data.page + 1,
										generation: model.membersGeneration,
									}),
								],
							},
			}),
		ClickedLoadMoreInvitations: () =>
			Option.match(AsyncData.getData(model.invitations), {
				onNone: () => ({ model }),
				onSome: (data) =>
					// While page 1 reads again (a revisit, a mutation) a later page would append to the wrong rows.
					data.isFetchingMore || AsyncData.isRefreshing(model.invitations)
						? { model }
						: {
								model: {
									...model,
									invitations: AsyncData.Success({
										data: { ...data, isFetchingMore: true },
									}),
								},
								commands: [
									FetchInvitations({
										page: data.page + 1,
										generation: model.invitationsGeneration,
									}),
								],
							},
			}),
		ClickedInvite: () => liftInvite(model, Dialog.open(model.inviteDialog)),
		GotInviteDialogMessage: ({ message: child }) =>
			liftInvite(model, Dialog.update(model.inviteDialog, child)),
		GotInviteEmailMessage: ({ message: child }) => {
			const step = Field.update(model.inviteEmail, child)
			return {
				model: { ...model, inviteEmail: step.model },
				commands: Command.mapMessages(step.commands ?? [], (inner) =>
					Message.GotInviteEmailMessage({ message: inner }),
				),
			}
		},
		GotInviteRoleMessage: ({ message: child }) => {
			const step = Select.update(model.inviteRole, child)
			return {
				model: { ...model, inviteRole: step.model },
				commands: Command.mapMessages(step.commands ?? [], (inner) =>
					Message.GotInviteRoleMessage({ message: inner }),
				),
			}
		},
		SubmittedInvite: () => {
			const email = model.inviteEmail.value.trim()
			if (model.isInviting || email.length === 0) return { model }
			return {
				model: { ...model, isInviting: true },
				commands: [InviteMember({ email, role: inviteRoleOf(model) })],
			}
		},
		CompletedInvite: ({ email, result }) =>
			Result.match(result, {
				onSuccess: () => {
					const reset = {
						...model,
						isInviting: false,
						inviteEmail: Field.init(),
						inviteRole: roleSelect("invite-role", "org:member"),
					}
					const closed = liftInvite(reset, Dialog.close(model.inviteDialog))
					const refreshed = revalidateInvitations(closed.model)
					return {
						model: refreshed.model,
						commands: [...(closed.commands ?? []), ...(refreshed.commands ?? [])],
						outMessage: toast("success", `Invitation sent to ${email}`),
					}
				},
				onFailure: (error) => ({
					model: { ...model, isInviting: false },
					outMessage: toast("error", error),
				}),
			}),
		GotRoleSelectMessage: ({ memberId, message: child }) =>
			Option.match(
				Option.flatMap(AsyncData.getData(model.members), (data) =>
					Array.findFirst(data.rows, (row) => row.id === memberId),
				),
				{
					onNone: () => ({ model }),
					onSome: (member) => {
						const step = Select.update(roleSelectFor(model, member), child)
						const next = {
							...model,
							roleSelects: { ...model.roleSelects, [memberId]: step.model },
						}
						const commands = Command.mapMessages(step.commands ?? [], (inner) =>
							Message.GotRoleSelectMessage({ memberId, message: inner }),
						)
						const picked = Option.flatMap(Option.fromNullishOr(step.outMessage), (out) =>
							Schema.decodeUnknownOption(OrgRole)(out.value),
						)
						return Option.match(picked, {
							onNone: () => ({ model: next, commands }),
							onSome: (role) =>
								role === toOrgRole(member.role)
									? { model: next, commands }
									: {
											model: {
												...next,
												pendingRole: { memberId, name: member.name, next: role },
											},
											commands,
										},
						})
					},
				},
			),
		ClickedCancelRole: () =>
			model.isRoleSaving ? { model } : { model: { ...model, pendingRole: null } },
		ClickedConfirmRole: () => {
			const pending = model.pendingRole
			if (pending === null || model.isRoleSaving) return { model }
			return { model: { ...model, isRoleSaving: true }, commands: [ChangeRole(pending)] }
		},
		CompletedRoleChange: ({ name, next, result }) =>
			Result.match(result, {
				onSuccess: () => ({
					...revalidateMembers({
						...model,
						isRoleSaving: false,
						pendingRole: null,
						roleSelects: {},
					}),
					outMessage: toast(
						"success",
						`${name} is now ${next === "org:admin" ? "an admin" : "a member"}`,
					),
				}),
				onFailure: (error) => ({
					model: { ...model, isRoleSaving: false },
					outMessage: toast("error", error),
				}),
			}),
		GotRowMenuMessage: ({ menuId, message: child }) => {
			const step = Menu.update(model.rowMenus[menuId] ?? Menu.init(menuId), child)
			const next = { ...model, rowMenus: { ...model.rowMenus, [menuId]: step.model } }
			const commands = Command.mapMessages(step.commands ?? [], (inner) =>
				Message.GotRowMenuMessage({ menuId, message: inner }),
			)
			if (step.outMessage?._tag !== "SelectedItem") return { model: next, commands }
			const after = pickedRowAction(next, menuId, step.outMessage.value)
			return { ...after, commands: [...commands, ...(after.commands ?? [])] }
		},
		GotRemoveDialogMessage: ({ message: child }) =>
			model.isRemoving ? { model } : liftRemove(model, Dialog.update(model.removeDialog, child)),
		ClickedConfirmRemove: () =>
			model.removing === null || model.isRemoving
				? { model }
				: {
						model: { ...model, isRemoving: true },
						commands: [RemoveMember({ memberId: model.removing.id, name: model.removing.name })],
					},
		CompletedRemove: ({ name, result }) =>
			Result.match(result, {
				onSuccess: () => {
					const closed = liftRemove(
						{ ...model, isRemoving: false, removing: null },
						Dialog.close(model.removeDialog),
					)
					const refreshed = revalidateMembers(closed.model)
					return {
						model: refreshed.model,
						commands: [...(closed.commands ?? []), ...(refreshed.commands ?? [])],
						outMessage: toast("success", `${name} removed`),
					}
				},
				// The confirmation stays open with its member selected so the admin can retry.
				onFailure: (error) => ({
					model: { ...model, isRemoving: false },
					outMessage: toast("error", error),
				}),
			}),
		GotRevokeDialogMessage: ({ message: child }) =>
			model.isRevoking ? { model } : liftRevoke(model, Dialog.update(model.revokeDialog, child)),
		ClickedConfirmRevoke: () =>
			model.revoking === null || model.isRevoking
				? { model }
				: {
						model: { ...model, isRevoking: true },
						commands: [RevokeInvitation({ id: model.revoking.id, email: model.revoking.email })],
					},
		CompletedRevoke: ({ email, result }) =>
			Result.match(result, {
				onSuccess: () => {
					const closed = liftRevoke(
						{ ...model, isRevoking: false, revoking: null },
						Dialog.close(model.revokeDialog),
					)
					const refreshed = revalidateInvitations(closed.model)
					return {
						model: refreshed.model,
						commands: [...(closed.commands ?? []), ...(refreshed.commands ?? [])],
						outMessage: toast("success", `Invitation to ${email} revoked`),
					}
				},
				onFailure: (error) => ({
					model: { ...model, isRevoking: false },
					outMessage: toast("error", error),
				}),
			}),
		CompletedResend: ({ id, email, isRevoked, result }) => {
			const next = { ...model, resending: model.resending.filter((entry) => entry !== id) }
			const outMessage = Result.match(result, {
				onSuccess: () => toast("success", `Invitation resent to ${email}`),
				onFailure: (error) => toast("error", error),
			})
			return isRevoked ? { ...revalidateInvitations(next), outMessage } : { model: next, outMessage }
		},
	})
