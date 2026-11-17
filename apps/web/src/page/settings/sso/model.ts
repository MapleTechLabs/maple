import {
	AttachResult,
	EnterpriseSsoDocument,
	ScimTokenIssued,
	SsoMappedRole,
	SsoProvider,
} from "@maple/domain/http"
import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import * as Menu from "@maple/views/ui/menu"
import * as Select from "@maple/views/ui/select"

// The SSO & SCIM tab: verified domains, the org's identity provider, break-glass users and SCIM
// provisioning, all read and written through `/internal/enterprise-sso`.

export const DocumentData = AsyncData.Schema(EnterpriseSsoDocument, LoadFailure)

/** An org member the break-glass picker offers. */
export const MemberOption = Schema.Struct({
	userId: Schema.String,
	name: Schema.String,
	identifier: Schema.String,
})
export type MemberOption = typeof MemberOption.Type
export const MembersData = AsyncData.Schema(Schema.Array(MemberOption), LoadFailure)

/** Each write the tab makes; it names the toast and which dialog closes on success. */
export const WriteAction = Schema.Literals([
	"addDomain",
	"verifyDomain",
	"removeDomain",
	"createConnection",
	"updateConnection",
	"enforce",
	"unenforce",
	"deleteConnection",
	"createDirectory",
	"rotateToken",
	"pause",
	"resume",
	"deleteDirectory",
	"saveMappings",
	"addBypass",
	"removeBypass",
])
export type WriteAction = typeof WriteAction.Type

/** The two self-serve add-ons the tab sells: single sign-on, and SCIM provisioning on top. */
export const AddOn = Schema.Literals(["sso", "scim"])
export type AddOn = typeof AddOn.Type

export const SamlMode = Schema.Literals(["metadata", "manual"])
export type SamlMode = typeof SamlMode.Type

/** The connection dialog's text fields. */
export const DraftField = Schema.Literals([
	"name",
	"metadataUrl",
	"ssoUrl",
	"entityId",
	"certificate",
	"discoveryUrl",
	"clientId",
	"clientSecret",
])
export type DraftField = typeof DraftField.Type

export const ConnectionDraft = Schema.Struct({
	mode: Schema.Literals(["create", "edit"]),
	provider: SsoProvider,
	domains: Schema.Array(Schema.String),
	samlMode: SamlMode,
	fields: Schema.Record(DraftField, Field.Model),
})
export type ConnectionDraft = typeof ConnectionDraft.Type

/** One role-mapping row being edited; `key` keeps the row's identity across reorders. */
export const MappingDraft = Schema.Struct({
	key: Schema.String,
	groupId: Schema.String,
	role: SsoMappedRole,
})
export type MappingDraft = typeof MappingDraft.Type

export const Model = Schema.Struct({
	/** The viewer holds `sso:manage`; everyone else reads. */
	canManage: Schema.Boolean,
	document: DocumentData.schema,
	members: MembersData.schema,
	/** The write in flight, one at a time. */
	pending: Schema.NullOr(WriteAction),
	copies: Schema.Record(Schema.String, CopyButton.Model),
	selects: Schema.Record(Schema.String, Select.Model),
	domainMenus: Schema.Record(Schema.String, Menu.Model),
	addDomainDialog: Dialog.Model,
	domainField: Field.Model,
	removingDomain: Schema.NullOr(Schema.String),
	removeDomainDialog: Dialog.Model,
	connectionDialog: Dialog.Model,
	draft: Schema.NullOr(ConnectionDraft),
	enforceDialog: Dialog.Model,
	removeConnectionDialog: Dialog.Model,
	bypassDialog: Dialog.Model,
	bypassPick: Schema.NullOr(Schema.String),
	removingBypass: Schema.NullOr(Schema.String),
	removeBypassDialog: Dialog.Model,
	removeDirectoryDialog: Dialog.Model,
	rotateDialog: Dialog.Model,
	tokenDialog: Dialog.Model,
	/** The SCIM token, only while its reveal dialog is open. */
	issuedToken: Schema.NullOr(Schema.String),
	/** The add-on the confirm dialog offers, while it is open or its checkout is starting. */
	addOn: Schema.NullOr(AddOn),
	addOnDialog: Dialog.Model,
	isAttachingAddOn: Schema.Boolean,
	/** `null` while the rows match the saved mappings. */
	mappings: Schema.NullOr(Schema.Array(MappingDraft)),
	nextMappingKey: Schema.Number,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	CompletedFetchDocument: { result: Schema.Result(EnterpriseSsoDocument, LoadFailure) },
	CompletedFetchMembers: { result: Schema.Result(Schema.Array(MemberOption), LoadFailure) },
	ClickedRetry: {},
	CompletedWrite: { action: WriteAction, result: Schema.Result(EnterpriseSsoDocument, LoadFailure) },
	CompletedIssueToken: { action: WriteAction, result: Schema.Result(ScimTokenIssued, LoadFailure) },
	GotCopyMessage: { key: Schema.String, message: CopyButton.Message },
	GotSelectMessage: { key: Schema.String, message: Select.Message },
	// Domains
	ClickedAddDomain: {},
	GotAddDomainDialogMessage: { message: Dialog.Message },
	GotDomainFieldMessage: { message: Field.Message },
	SubmittedAddDomain: {},
	ClickedVerifyDomain: { domain: Schema.String },
	GotDomainMenuMessage: { domain: Schema.String, message: Menu.Message },
	GotRemoveDomainDialogMessage: { message: Dialog.Message },
	ClickedConfirmRemoveDomain: {},
	// Identity provider
	ClickedConnect: {},
	ClickedEditConnection: {},
	GotConnectionDialogMessage: { message: Dialog.Message },
	GotDraftFieldMessage: { field: DraftField, message: Field.Message },
	PickedSamlMode: { mode: SamlMode },
	ToggledDraftDomain: { domain: Schema.String },
	SubmittedConnection: {},
	ToggledEnforcement: {},
	GotEnforceDialogMessage: { message: Dialog.Message },
	ClickedConfirmEnforce: {},
	ClickedRemoveConnection: {},
	GotRemoveConnectionDialogMessage: { message: Dialog.Message },
	ClickedConfirmRemoveConnection: {},
	// Break-glass
	ClickedAddBypass: {},
	GotBypassDialogMessage: { message: Dialog.Message },
	SubmittedBypass: {},
	ClickedRemoveBypass: { userId: Schema.String },
	GotRemoveBypassDialogMessage: { message: Dialog.Message },
	ClickedConfirmRemoveBypass: {},
	// SCIM
	ClickedSetUpScim: {},
	ClickedTogglePaused: {},
	ClickedRotateToken: {},
	GotRotateDialogMessage: { message: Dialog.Message },
	ClickedConfirmRotate: {},
	GotTokenDialogMessage: { message: Dialog.Message },
	ClickedRemoveDirectory: {},
	GotRemoveDirectoryDialogMessage: { message: Dialog.Message },
	ClickedConfirmRemoveDirectory: {},
	ClickedAddAddOn: { addOn: AddOn },
	GotAddOnDialogMessage: { message: Dialog.Message },
	ClickedConfirmAddOn: {},
	CompletedAttachAddOn: { result: Schema.Result(AttachResult, LoadFailure) },
	CompletedOpenAddOnCheckout: {},
	ClickedAddMapping: {},
	ClickedMoveMapping: { key: Schema.String, by: Schema.Literals([-1, 1]) },
	ClickedRemoveMapping: { key: Schema.String },
	ClickedDiscardMappings: {},
	ClickedSaveMappings: {},
})
export type Message = typeof Message.Type
