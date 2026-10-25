import { truncatedCellStyles } from "@maple/ui/styles/ui/table"
import { initialsFrom } from "@maple/ui/lib/initials"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { orgRoleLabel, roleChangePrompt, toOrgRole } from "../../../components/settings/org-membership"
import { formatDateInTimezone } from "@maple/web-data/lib/timezone-format"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { confirmDialog } from "../../../ui/confirm-dialog"
import { warmAvatarTone } from "../../../ui/avatar-tone"
import { avatarFallback } from "../../../ui/display"
import { field, type FieldIds, fieldLabel, input, type FieldState } from "../../../ui/field"
import * as Field from "../../../ui/field"
import { formDialog } from "../../../ui/form-dialog"
import { icon } from "../../../ui/icon"
import * as Menu from "../../../ui/menu"
import { rowActionsMenu } from "../../../ui/row-actions-menu"
import * as SelectView from "../../../ui/select-view"
import { skeleton, skeletonList } from "../../../ui/skeleton"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { truncatedText } from "../../../ui/truncated-text"
import { accountSectionSkeleton, noOrganization } from "../kit/account-skeleton"
import { adminOnlyNotice } from "../kit/members"
import { settingsSection, settingsSections } from "../kit/section"
import { type InvitationRow, type MemberRow, Message, type Model } from "./model"
import { hasMore, roleSelectFor } from "./update"

type H = HtmlBuilder<Message>
type Inputs = Readonly<{ nowMs: number; timeZone: string; isKnownMember: boolean }>

const ROLE_ENTRIES: ReadonlyArray<SelectView.SelectEntry> = [
	{ _tag: "Item", item: { value: "org:member", label: "Member" } },
	{ _tag: "Item", item: { value: "org:admin", label: "Admin" } },
]

/** `isInset`: the column also holds role selects, so plain values and the header sit at their text inset. */
const roleText = (h: H, role: string, isInset: boolean): Html =>
	h.span([h.Class(cn("text-xs text-foreground", isInset && "px-2.5"))], [orgRoleLabel(role)])

const roleHead = (h: H, isInset: boolean): Html =>
	tableHead(h, [h.span([h.Class(cn(isInset && "px-2.5"))], ["Role"])], COLUMN.role)

/** One set of column widths for the members and invitations tables, on a fixed layout. */
const COLUMN = { role: "w-36", date: "w-36", actions: "w-12" } as const

/** Without the actions column the date column ends the row, so it sits flush right. */
const dateAlign = (isAdmin: boolean): string | undefined => (isAdmin ? undefined : "text-right")

const truncatedCell = (h: H, children: ReadonlyArray<Html>, className?: string): Html =>
	tableCell(h, children, cn(truncatedCellStyles, className))

const loadMore = (h: H, isLoading: boolean, onClick: Message): Html =>
	h.div(
		[h.Class("flex justify-center border-t p-2")],
		[
			button(h, { variant: "ghost", size: "sm", isLoading, attributes: [h.OnClick(onClick)] }, [
				"Load more",
			]),
		],
	)

const skeletonRow = (h: H, isAdmin: boolean, index: number): Html =>
	tableRow(
		h,
		[
			tableCell(h, [
				h.div(
					[h.Class("flex items-center gap-3")],
					[
						skeleton(h, "size-6 rounded-full"),
						h.div([h.Class("space-y-1.5")], [skeleton(h, "h-3 w-32"), skeleton(h, "h-3 w-48")]),
					],
				),
			]),
			tableCell(h, [skeleton(h, "h-3 w-16")]),
			tableCell(h, [skeleton(h, cn("h-3 w-20", !isAdmin && "ml-auto"))]),
			...(isAdmin ? [tableCell(h, [])] : []),
		],
		undefined,
		[h.Key(`skeleton-${index}`)],
	)

const roleCell = (h: H, model: Model, member: MemberRow, canManage: boolean): Html => {
	if (!canManage) return tableCell(h, [roleText(h, member.role, model.isAdmin)])
	const isConfirming = model.pendingRole?.memberId === member.id
	return tableCell(h, [
		h.submodel({
			slotId: `member-role-${member.id}`,
			model: { ...roleSelectFor(model, member), value: toOrgRole(member.role) },
			view: SelectView.view,
			toParentMessage: (message) => Message.GotRoleSelectMessage({ memberId: member.id, message }),
			viewInputs: {
				entries: ROLE_ENTRIES,
				ariaLabel: `Role of ${member.name}`,
				size: "sm",
				className: cn("w-full min-w-0", isConfirming && "border-primary"),
				renderValue: () => [orgRoleLabel(member.role)],
				toView: (parts) => h.div([h.Class("contents")], parts),
			},
		}),
	])
}

const memberRows = (h: H, model: Model, member: MemberRow, inputs: Inputs): ReadonlyArray<Html> => {
	const canManage = model.isAdmin && !member.isCurrentUser
	const pending = model.pendingRole?.memberId === member.id ? model.pendingRole : null
	const columnCount = model.isAdmin ? 4 : 3
	const menuId = `member-actions-${member.id}`
	const row = tableRow(
		h,
		[
			truncatedCell(h, [
				h.div(
					[h.Class("flex items-center gap-3")],
					[
						personAvatar(h, member.name, member.imageUrl),
						h.div(
							[h.Class("min-w-0")],
							[
								h.div(
									[h.Class("flex min-w-0 text-xs font-medium")],
									[
										truncatedText(h, { text: member.name }),
										...(member.isCurrentUser
											? [
													h.span(
														[h.Class("ml-1 shrink-0 text-muted-foreground")],
														["(you)"],
													),
												]
											: []),
									],
								),
								truncatedText(h, {
									text: member.identifier,
									className: "text-xs text-muted-foreground",
								}),
							],
						),
					],
				),
			]),
			roleCell(h, model, member, canManage),
			tableCell(
				h,
				[formatDateInTimezone(member.createdAtMs, { timeZone: inputs.timeZone })],
				cn("text-xs text-muted-foreground", dateAlign(model.isAdmin)),
			),
			...(model.isAdmin
				? [
						tableCell(
							h,
							canManage
								? [
										rowActionsMenu(h, {
											slotId: menuId,
											model: model.rowMenus[menuId] ?? Menu.init(menuId),
											label: `Actions for ${member.name}`,
											entries: [
												{
													_tag: "Item",
													value: "remove",
													label: "Remove",
													icon: "TrashIcon",
													variant: "destructive",
												},
											],
											toParentMessage: (message) =>
												Message.GotRowMenuMessage({ menuId, message }),
										}),
									]
								: [],
						),
					]
				: []),
		],
		undefined,
		[h.Key(member.id)],
	)
	if (pending === null) return [row]
	const prompt = roleChangePrompt(member.name, pending.next)
	return [
		row,
		tableRow(
			h,
			[
				tableCell(
					h,
					[
						h.div(
							[h.Class("flex items-center justify-between gap-4 pl-9")],
							[
								h.p(
									[h.Class("flex items-center gap-2 text-xs text-foreground")],
									[
										icon(h, "CircleInfoIcon", {
											className: "size-3.5 shrink-0 text-primary",
										}),
										prompt.question,
									],
								),
								h.div(
									[h.Class("flex shrink-0 items-center gap-1.5")],
									[
										button(
											h,
											{
												variant: "ghost",
												size: "sm",
												isDisabled: model.isRoleSaving,
												attributes: [h.OnClick(Message.ClickedCancelRole())],
											},
											["Cancel"],
										),
										button(
											h,
											{
												size: "sm",
												isLoading: model.isRoleSaving,
												attributes: [h.OnClick(Message.ClickedConfirmRole())],
											},
											[prompt.confirmLabel],
										),
									],
								),
							],
						),
					],
					undefined,
					[h.Colspan(columnCount)],
				),
			],
			"border-l-2 border-l-primary bg-muted/40 hover:bg-muted/40",
			[h.Key(`${member.id}-confirm`)],
		),
	]
}

/** The warm initials tile the sidebar draws, or the member's own uploaded image. */
const personAvatar = (h: H, seed: string, imageUrl: string): Html =>
	avatarFallback(
		h,
		{
			className: "size-6 shrink-0",
			fallbackClassName: `font-medium ${warmAvatarTone(seed)}`,
			imageUrl,
		},
		initialsFrom(seed),
	)

export const description = "Admins manage billing, keys and members."

/** The tab's primary action, drawn in the settings page header beside the `<h1>`. */
export const headerActions = Submodel.defineView<Model, Message, Readonly<{}>>((model, _inputs, h) =>
	model.isAdmin
		? button(h, { size: "sm", attributes: [h.OnClick(Message.ClickedInvite())] }, [
				icon(h, "PlusIcon", { attributes: [h.DataAttribute("icon", "inline-start")] }),
				"Invite member",
			])
		: h.empty,
)

const membersSection = (h: H, model: Model, inputs: Inputs): Html => {
	const data = AsyncData.getOrElse(model.members, () => null)
	const rows = data?.rows ?? []
	// Only before the first answer: a loaded list, even an empty one, stays while it reads again.
	const isLoading = rows.length === 0 && AsyncData.isLoading(model.members)
	return settingsSection(
		h,
		{
			id: "settings-members",
			title: "Members",
			isLead: true,
			padded: false,
		},
		[
			table(h, { className: "table-fixed" }, [
				tableHeader(h, [
					tableRow(h, [
						tableHead(h, ["Member"]),
						roleHead(h, model.isAdmin),
						tableHead(h, ["Joined"], cn(COLUMN.date, dateAlign(model.isAdmin))),
						...(model.isAdmin ? [tableHead(h, [], COLUMN.actions)] : []),
					]),
				]),
				tableBody(h, [
					...(isLoading ? [0, 1, 2].map((index) => skeletonRow(h, model.isAdmin, index)) : []),
					...rows.flatMap((member) => memberRows(h, model, member, inputs)),
				]),
			]),
			...(data !== null && hasMore(data)
				? [loadMore(h, data.isFetchingMore, Message.ClickedLoadMoreMembers())]
				: []),
		],
	)
}

const invitationRow = (h: H, model: Model, invitation: InvitationRow, inputs: Inputs): Html => {
	const menuId = `invitation-actions-${invitation.id}`
	const isResending = model.resending.includes(invitation.id)
	return tableRow(
		h,
		[
			truncatedCell(h, [
				h.div(
					[h.Class("flex items-center gap-3")],
					[
						personAvatar(h, invitation.email, ""),
						truncatedText(h, { text: invitation.email, className: "text-xs" }),
					],
				),
			]),
			tableCell(h, [roleText(h, invitation.role, false)]),
			tableCell(
				h,
				[formatRelativeTime(invitation.createdAtMs, inputs.nowMs)],
				cn("text-xs text-muted-foreground", dateAlign(model.isAdmin)),
			),
			...(model.isAdmin
				? [
						tableCell(h, [
							rowActionsMenu(h, {
								slotId: menuId,
								model: model.rowMenus[menuId] ?? Menu.init(menuId),
								label: `Actions for ${invitation.email}`,
								entries: [
									{
										_tag: "Item",
										value: "resend",
										label: isResending ? "Resending" : "Resend",
										icon: "ArrowRotateAnticlockwiseIcon",
										isDisabled: isResending,
									},
									{
										_tag: "Item",
										value: "revoke",
										label: "Revoke",
										icon: "TrashIcon",
										variant: "destructive",
										isDisabled: isResending,
									},
								],
								toParentMessage: (message) => Message.GotRowMenuMessage({ menuId, message }),
							}),
						]),
					]
				: []),
		],
		undefined,
		[h.Key(invitation.id)],
	)
}

const invitationsSection = (h: H, model: Model, inputs: Inputs): ReadonlyArray<Html> => {
	const data = AsyncData.getOrElse(model.invitations, () => null)
	if (data === null || data.rows.length === 0) return []
	return [
		settingsSection(
			h,
			{
				id: "settings-invitations",
				title: "Invitations",
				description: [
					"Sent but not yet accepted. Resend issues a fresh invitation and revokes the old one.",
				],
				padded: false,
			},
			[
				table(h, { className: "table-fixed" }, [
					tableHeader(h, [
						tableRow(h, [
							tableHead(h, ["Email"]),
							roleHead(h, false),
							tableHead(h, ["Invited"], cn(COLUMN.date, dateAlign(model.isAdmin))),
							...(model.isAdmin ? [tableHead(h, [], COLUMN.actions)] : []),
						]),
					]),
					tableBody(
						h,
						data.rows.map((invitation) => invitationRow(h, model, invitation, inputs)),
					),
				]),
				...(hasMore(data)
					? [loadMore(h, data.isFetchingMore, Message.ClickedLoadMoreInvitations())]
					: []),
			],
		),
	]
}

const IDLE: FieldState = {
	isInvalid: false,
	isDirty: false,
	isFilled: false,
	isFocused: false,
	isTouched: false,
}
const EMAIL_IDS: FieldIds = {
	control: "invite-email",
	label: "invite-email-label",
	error: "invite-email-error",
}

const inviteDialog = (h: H, model: Model): Html => {
	const emailState = Field.stateOf(model.inviteEmail, false)
	const roleState: FieldState = { ...IDLE, isFilled: true }
	return formDialog(h, {
		slotId: "invite-member",
		model: model.inviteDialog,
		toParentMessage: (message) => Message.GotInviteDialogMessage({ message }),
		title: "Invite member",
		description: `Send an invitation to join ${model.orgName}.`,
		onSubmit: Message.SubmittedInvite(),
		submitLabel: "Send invitation",
		isPending: model.isInviting,
		isSubmitDisabled: model.inviteEmail.value.trim().length === 0,
		fields: [
			field(h, { state: emailState }, [
				fieldLabel(h, { ids: EMAIL_IDS, state: emailState }, "Email address"),
				input(h, {
					ids: EMAIL_IDS,
					state: emailState,
					attributes: [
						h.Type("email"),
						h.Placeholder("colleague@example.com"),
						...Field.controlAttributes(h, model.inviteEmail, (message) =>
							Message.GotInviteEmailMessage({ message }),
						),
					],
				}),
			]),
			h.submodel({
				slotId: "invite-role",
				model: model.inviteRole,
				view: SelectView.view,
				toParentMessage: (message) => Message.GotInviteRoleMessage({ message }),
				viewInputs: {
					entries: ROLE_ENTRIES,
					labelledBy: "invite-role-label",
					className: "w-full",
					renderValue: (value) => [orgRoleLabel(value)],
					toView: (parts) =>
						field(h, { state: roleState }, [
							fieldLabel(
								h,
								{
									ids: {
										control: "invite-role-trigger",
										label: "invite-role-label",
										error: "invite-role-error",
									},
									state: roleState,
								},
								"Role",
							),
							...parts,
						]),
				},
			}),
		],
	})
}

const dialogs = (h: H, model: Model): ReadonlyArray<Html> => [
	inviteDialog(h, model),
	confirmDialog(h, {
		slotId: "invitation-revoke",
		model: model.revokeDialog,
		toParentMessage: (message) => Message.GotRevokeDialogMessage({ message }),
		title: "Revoke invitation?",
		description: `The invitation to ${model.revoking?.email ?? ""} will stop working. You can invite them again later.`,
		confirmLabel: "Revoke invitation",
		isPending: model.isRevoking,
		onConfirm: Message.ClickedConfirmRevoke(),
	}),
	confirmDialog(h, {
		slotId: "member-remove",
		model: model.removeDialog,
		toParentMessage: (message) => Message.GotRemoveDialogMessage({ message }),
		title: "Remove member?",
		description: `${model.removing?.name ?? ""} will lose access to this organization immediately. You can invite them again later.`,
		confirmLabel: "Remove member",
		isPending: model.isRemoving,
		onConfirm: Message.ClickedConfirmRemove(),
	}),
]

const loadingSkeleton = (h: H): Html =>
	accountSectionSkeleton(h, [
		skeletonList(h, {
			rows: 3,
			gap: "3",
			renderRow: () =>
				h.div(
					[h.Class("flex items-center gap-3")],
					[
						skeleton(h, "size-8 rounded-full"),
						h.div([h.Class("space-y-1.5")], [skeleton(h, "h-3.5 w-32"), skeleton(h, "h-3 w-48")]),
					],
				),
		}),
	])

export const view = Submodel.defineView<Model, Message, Inputs>((model, inputs, h) => {
	if (model.hasOrganization === null) return loadingSkeleton(h)
	if (!model.hasOrganization)
		return noOrganization(h, "Select or create an organization to manage members.")
	return settingsSections(h, [
		...adminOnlyNotice(h, {
			isKnownMember: inputs.isKnownMember && !model.isAdmin,
			subject: "members",
			adminName: model.adminName,
		}),
		membersSection(h, model, inputs),
		...invitationsSection(h, model, inputs),
		...dialogs(h, model),
	])
})
