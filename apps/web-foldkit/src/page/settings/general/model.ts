import { MapleRegion } from "@maple/domain/organization-regions"
import { Schema } from "effect"
import { AsyncData, File } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import * as Dialog from "../../../ui/dialog"
import { DraftState } from "../kit/draft"

// The General tab: the active Clerk organization's logo and name, its data region and the danger zone.

export const OrgInfo = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	hasImage: Schema.Boolean,
	region: MapleRegion,
})
export type OrgInfo = typeof OrgInfo.Type

/** One filtered page of admins: the count gates leaving, the first name fills the notice. */
export const AdminsInfo = Schema.Struct({ count: Schema.Number, firstAdminName: Schema.NullOr(Schema.String) })
export type AdminsInfo = typeof AdminsInfo.Type

/** `null`: no active organization (the empty state). */
export const OrgData = AsyncData.Schema(Schema.NullOr(OrgInfo), LoadFailure)
export const AdminsData = AsyncData.Schema(AdminsInfo, LoadFailure)

export const Model = Schema.Struct({
	isAdmin: Schema.Boolean,
	org: OrgData.schema,
	admins: AdminsData.schema,
	name: DraftState(Schema.String),
	isSavingName: Schema.Boolean,
	isSavingLogo: Schema.Boolean,
	isDragging: Schema.Boolean,
	leaveDialog: Dialog.Model,
	isLeaving: Schema.Boolean,
	deleteDialog: Dialog.Model,
	confirmText: Schema.String,
	isDeleting: Schema.Boolean,
})
export type Model = typeof Model.Type

const done = <A extends Schema.Top>(schema: A) => ({ result: Schema.Result(schema, Schema.String) })

export const Message = defineMessageUnion({
	CompletedFetchOrganization: { result: Schema.Result(Schema.NullOr(OrgInfo), LoadFailure) },
	CompletedFetchAdmins: { result: Schema.Result(AdminsInfo, LoadFailure) },
	ChangedName: { value: Schema.String },
	ClickedDiscardName: {},
	ClickedSaveName: {},
	CompletedSaveName: { submitted: Schema.String, sent: Schema.String, ...done(Schema.Void) },
	ClickedPickLogo: {},
	CompletedPickLogo: {},
	DraggedOverLogo: {},
	LeftLogo: {},
	PickedLogo: { files: Schema.Array(File.File) },
	ClickedRemoveLogo: {},
	CompletedSetLogo: { isRemoved: Schema.Boolean, ...done(Schema.Void) },
	ClickedLeave: {},
	GotLeaveDialogMessage: { message: Dialog.Message },
	ClickedConfirmLeave: {},
	CompletedLeave: done(Schema.Void),
	ClickedDelete: {},
	GotDeleteDialogMessage: { message: Dialog.Message },
	ChangedConfirmText: { value: Schema.String },
	ClickedConfirmDelete: {},
	CompletedDelete: { result: Schema.Result(Schema.Void, LoadFailure) },
	CompletedSwitchAway: {},
})
export type Message = typeof Message.Type
