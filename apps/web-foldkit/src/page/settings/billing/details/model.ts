import { BillingProfile, BillingTaxId } from "@maple/domain/http"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../../data/load-failure"
import * as Combobox from "../../../../ui/combobox"
import * as Dialog from "../../../../ui/dialog"
import * as Select from "../../../../ui/select"

// `BillingDetailsDialog` and `BillingTaxIdsEditor` (apps/web/src/components/settings/): company
// name and address saved together, tax IDs saved one by one as they are added or removed.

export const AddressField = Schema.Literals(["name", "line1", "line2", "city", "state", "postalCode"])
export type AddressField = typeof AddressField.Type

export const Model = Schema.Struct({
	dialog: Dialog.Model,
	name: Schema.String,
	line1: Schema.String,
	line2: Schema.String,
	city: Schema.String,
	state: Schema.String,
	postalCode: Schema.String,
	/** ISO-3166 alpha-2, `null` for none. */
	country: Schema.NullOr(Schema.String),
	countryBox: Combobox.Model,
	isSaving: Schema.Boolean,
	taxType: Select.Model,
	taxValue: Schema.String,
	isMissingTaxValue: Schema.Boolean,
	isAddingTax: Schema.Boolean,
	removingTax: Schema.NullOr(BillingTaxId),
	removeDialog: Dialog.Model,
	removingTaxIds: Schema.Array(Schema.String),
})
export type Model = typeof Model.Type

const done = { result: Schema.Result(BillingProfile, LoadFailure) }

/** What the removal toast names. */
export const TaxIdRef = Schema.Struct({ id: Schema.String, type: Schema.String, value: Schema.String })

export const Message = defineMessageUnion({
	GotDialogMessage: { message: Dialog.Message },
	ChangedField: { field: AddressField, value: Schema.String },
	GotCountryMessage: { message: Combobox.Message },
	SubmittedDetails: {},
	CompletedSave: done,
	GotTaxTypeMessage: { message: Select.Message },
	ChangedTaxValue: { value: Schema.String },
	PressedTaxKey: { key: Schema.String },
	ClickedAddTax: {},
	CompletedAddTax: done,
	ClickedRemoveTax: { taxId: BillingTaxId },
	GotRemoveDialogMessage: { message: Dialog.Message },
	ClickedConfirmRemoveTax: {},
	CompletedRemoveTax: { taxId: TaxIdRef, ...done },
})
export type Message = typeof Message.Type
