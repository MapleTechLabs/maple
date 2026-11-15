import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import * as Menu from "@maple/views/ui/menu"
import * as Select from "@maple/views/ui/select"

// The Domains tab: the active Clerk organization's verified domains, read and written through
// clerk-js. Free on every plan; enterprise SSO builds on the domains verified here.

/** Who joins from a verified domain, as Clerk holds it. */
export const ClerkEnrollment = Schema.Literals([
	"automatic_invitation",
	"automatic_suggestion",
	"manual_invitation",
])
export type ClerkEnrollment = typeof ClerkEnrollment.Type

/**
 * The modes this tab offers. `automatic_suggestion` files membership requests the dashboard has
 * no page to approve; a domain already on it shows so, and can be moved off it.
 */
export const Enrollment = Schema.Literals(["automatic_invitation", "manual_invitation"])
export type Enrollment = typeof Enrollment.Type

export const DomainRow = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	isVerified: Schema.Boolean,
	enrollment: ClerkEnrollment,
	/** The address the last code went to, `null` before one was sent. */
	affiliationEmail: Schema.NullOr(Schema.String),
})
export type DomainRow = typeof DomainRow.Type

export const DomainsData = AsyncData.Schema(Schema.Array(DomainRow), LoadFailure)

/** The verify dialog: the address step, then the code step once Clerk has sent one. */
export const Verifying = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	step: Schema.Literals(["email", "code"]),
	email: Schema.String,
})
export type Verifying = typeof Verifying.Type

export const Model = Schema.Struct({
	/** `null` until clerk-js answers. */
	hasOrganization: Schema.NullOr(Schema.Boolean),
	domains: DomainsData.schema,
	addDialog: Dialog.Model,
	domainField: Field.Model,
	isAdding: Schema.Boolean,
	verifying: Schema.NullOr(Verifying),
	verifyDialog: Dialog.Model,
	emailField: Field.Model,
	codeField: Field.Model,
	isVerifyPending: Schema.Boolean,
	enrollmentSelects: Schema.Record(Schema.String, Select.Model),
	savingEnrollment: Schema.Array(Schema.String),
	rowMenus: Schema.Record(Schema.String, Menu.Model),
	removing: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })),
	removeDialog: Dialog.Model,
	isRemoving: Schema.Boolean,
})
export type Model = typeof Model.Type

const done = { result: Schema.Result(Schema.Void, Schema.String) }

export const Message = defineMessageUnion({
	CompletedFetchOrganization: { hasOrganization: Schema.Boolean },
	CompletedFetchDomains: { result: Schema.Result(Schema.Array(DomainRow), LoadFailure) },
	ClickedRetry: {},
	ClickedAdd: {},
	GotAddDialogMessage: { message: Dialog.Message },
	GotDomainFieldMessage: { message: Field.Message },
	SubmittedAdd: {},
	CompletedAdd: { result: Schema.Result(DomainRow, Schema.String) },
	ClickedVerify: { id: Schema.String },
	GotVerifyDialogMessage: { message: Dialog.Message },
	GotEmailFieldMessage: { message: Field.Message },
	GotCodeFieldMessage: { message: Field.Message },
	SubmittedVerify: {},
	CompletedSendCode: { id: Schema.String, email: Schema.String, ...done },
	ClickedResendCode: {},
	ClickedChangeEmail: {},
	CompletedAttemptCode: { id: Schema.String, name: Schema.String, ...done },
	GotEnrollmentSelectMessage: { id: Schema.String, message: Select.Message },
	CompletedEnrollment: { id: Schema.String, name: Schema.String, next: Enrollment, ...done },
	GotRowMenuMessage: { menuId: Schema.String, id: Schema.String, message: Menu.Message },
	GotRemoveDialogMessage: { message: Dialog.Message },
	ClickedConfirmRemove: {},
	CompletedRemove: { name: Schema.String, ...done },
})
export type Message = typeof Message.Type
