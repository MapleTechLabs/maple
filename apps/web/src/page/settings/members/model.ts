import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import * as Dialog from "../../../ui/dialog"
import * as Field from "../../../ui/field"
import * as Menu from "../../../ui/menu"
import * as Select from "../../../ui/select"

// The Members tab: the active Clerk organization's memberships and pending invitations, read and
// written through clerk-js.

export const OrgRole = Schema.Literals(["org:admin", "org:member"])
export type OrgRole = typeof OrgRole.Type

export const MemberRow = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	identifier: Schema.String,
	/** `publicUserData.imageUrl`, `""` without one. */
	imageUrl: Schema.String,
	role: Schema.String,
	createdAtMs: Schema.Number,
	isCurrentUser: Schema.Boolean,
})
export type MemberRow = typeof MemberRow.Type

export const InvitationRow = Schema.Struct({
	id: Schema.String,
	email: Schema.String,
	role: Schema.String,
	createdAtMs: Schema.Number,
})
export type InvitationRow = typeof InvitationRow.Type

/** One page of a Clerk paginated list and the list's total. */
const PageOf = <S extends Schema.Top>(row: S) =>
	Schema.Struct({ rows: Schema.Array(row), total: Schema.Number })
export const MembersPage = PageOf(MemberRow)
export const InvitationsPage = PageOf(InvitationRow)

/** `useOrganization({ memberships: { infinite: true } })`: the pages loaded so far, flattened. */
const ListOf = <S extends Schema.Top>(row: S) =>
	Schema.Struct({
		rows: Schema.Array(row),
		total: Schema.Number,
		page: Schema.Number,
		isFetchingMore: Schema.Boolean,
	})
export const MembersData = AsyncData.Schema(ListOf(MemberRow), LoadFailure)
export const InvitationsData = AsyncData.Schema(ListOf(InvitationRow), LoadFailure)

/** A role change waiting on the inline confirm strip under the member's row. */
export const PendingRoleChange = Schema.Struct({
	memberId: Schema.String,
	name: Schema.String,
	next: OrgRole,
})

export const Model = Schema.Struct({
	isAdmin: Schema.Boolean,
	/** The org's first admin, named by the notice members see. */
	adminName: Schema.NullOr(Schema.String),
	hasOrganization: Schema.NullOr(Schema.Boolean),
	orgName: Schema.String,
	members: MembersData.schema,
	invitations: InvitationsData.schema,
	/** Bumped by each read from page 1: a page answer for an older one is dropped. */
	membersGeneration: Schema.Number,
	invitationsGeneration: Schema.Number,
	inviteDialog: Dialog.Model,
	inviteEmail: Field.Model,
	inviteRole: Select.Model,
	isInviting: Schema.Boolean,
	roleSelects: Schema.Record(Schema.String, Select.Model),
	pendingRole: Schema.NullOr(PendingRoleChange),
	isRoleSaving: Schema.Boolean,
	rowMenus: Schema.Record(Schema.String, Menu.Model),
	removing: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })),
	removeDialog: Dialog.Model,
	isRemoving: Schema.Boolean,
	revoking: Schema.NullOr(InvitationRow),
	revokeDialog: Dialog.Model,
	isRevoking: Schema.Boolean,
	resending: Schema.Array(Schema.String),
})
export type Model = typeof Model.Type

const done = <A extends Schema.Top>(schema: A) => ({ result: Schema.Result(schema, Schema.String) })

export const Message = defineMessageUnion({
	CompletedFetchOrganization: { name: Schema.NullOr(Schema.String) },
	CompletedFetchAdminName: { name: Schema.NullOr(Schema.String) },
	CompletedFetchMembers: {
		page: Schema.Number,
		generation: Schema.Number,
		result: Schema.Result(MembersPage, LoadFailure),
	},
	CompletedFetchInvitations: {
		page: Schema.Number,
		generation: Schema.Number,
		result: Schema.Result(InvitationsPage, LoadFailure),
	},
	ClickedLoadMoreMembers: {},
	ClickedLoadMoreInvitations: {},
	ClickedInvite: {},
	GotInviteDialogMessage: { message: Dialog.Message },
	GotInviteEmailMessage: { message: Field.Message },
	GotInviteRoleMessage: { message: Select.Message },
	SubmittedInvite: {},
	CompletedInvite: { email: Schema.String, ...done(Schema.Void) },
	GotRoleSelectMessage: { memberId: Schema.String, message: Select.Message },
	ClickedCancelRole: {},
	ClickedConfirmRole: {},
	CompletedRoleChange: { name: Schema.String, next: OrgRole, ...done(Schema.Void) },
	GotRowMenuMessage: { menuId: Schema.String, message: Menu.Message },
	GotRemoveDialogMessage: { message: Dialog.Message },
	ClickedConfirmRemove: {},
	CompletedRemove: { name: Schema.String, ...done(Schema.Void) },
	GotRevokeDialogMessage: { message: Dialog.Message },
	ClickedConfirmRevoke: {},
	CompletedRevoke: { email: Schema.String, ...done(Schema.Void) },
	/** `revoked` false: the old invitation still stands; true: it is gone and the new one may not be. */
	CompletedResend: {
		id: Schema.String,
		email: Schema.String,
		isRevoked: Schema.Boolean,
		...done(Schema.Void),
	},
})
export type Message = typeof Message.Type
