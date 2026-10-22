import { TAX_ID_TYPES, defaultTaxIdTypeFor, isTaxIdType, taxIdLabel } from "@maple/domain/billing-tax-ids"
import {
	AddBillingTaxIdRequest,
	BillingAddress,
	type BillingProfile,
	UpdateBillingProfileRequest,
} from "@maple/domain/http"
import { fieldOrNull } from "../../../../lib/billing/billing-profile"
import { countryName, sortedCountryCodes } from "../../../../lib/billing/countries"
import { Effect, Option, Result } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../../data/load-failure"
import { MapleInternalApiClient } from "../../../../platform/api-clients"
import * as Combobox from "../../../../ui/combobox"
import * as Dialog from "../../../../ui/dialog"
import * as Select from "../../../../ui/select"
import { PageOutMessage, type PageReturn } from "../../../contract"
import { Message, type Model, TaxIdRef } from "./model"

type Return = PageReturn<Model, Message>

/** A step plus whether the profile changed (the tab reads it again: `BILLING_PROFILE_KEY`). */
export type Step = Readonly<{ step: Return; isProfileStale: boolean }>

// Type picker order: the handful most customers want, then the rest by label.
const FEATURED_TYPES: ReadonlyArray<string> = [
	"eu_vat",
	"gb_vat",
	"ch_vat",
	"us_ein",
	"ca_gst_hst",
	"au_abn",
	"in_gst",
]
export const TYPE_OPTIONS = [
	...FEATURED_TYPES.flatMap((type) => TAX_ID_TYPES.filter((info) => info.type === type)),
	...TAX_ID_TYPES.filter((info) => !FEATURED_TYPES.includes(info.type)).sort((a, b) =>
		a.label.localeCompare(b.label),
	),
].map((info) => ({ value: info.type, label: info.label }))

/** Countries by name, in the picker's order; the combobox filters on the name. */
export const COUNTRY_CODES = sortedCountryCodes()
export const COUNTRY_NAMES = COUNTRY_CODES.map(countryName)
const codeOfName = (name: string): string | null => {
	const index = COUNTRY_NAMES.indexOf(name)
	return index === -1 ? null : (COUNTRY_CODES[index] ?? null)
}

const SaveDetails = Command.define("UpdateBillingProfile", {
	args: { payload: UpdateBillingProfileRequest },
	messages: [Message.CompletedSave],
	execute: ({ payload }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.billing.updateBillingProfile({ payload }),
		).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedSave({ result })),
		),
})

const AddTaxId = Command.define("AddBillingTaxId", {
	args: { payload: AddBillingTaxIdRequest },
	messages: [Message.CompletedAddTax],
	execute: ({ payload }) =>
		Effect.flatMap(MapleInternalApiClient, (client) => client.billing.addBillingTaxId({ payload })).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedAddTax({ result })),
		),
})

const RemoveTaxId = Command.define("RemoveBillingTaxId", {
	args: { taxId: TaxIdRef },
	messages: [Message.CompletedRemoveTax],
	execute: ({ taxId }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.billing.removeBillingTaxId({ params: { taxIdId: taxId.id } }),
		).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedRemoveTax({ taxId, result })),
		),
})

const taxTypeSelect = (type: string): Select.Model =>
	Select.init("billing-tax-type", {
		value: type,
		selectedIndex: Math.max(
			0,
			TYPE_OPTIONS.findIndex((option) => option.value === type),
		),
	})

const countryBox = (code: string | null): Combobox.Model =>
	Combobox.init("billing-country", "single", { selected: code === null ? [] : [countryName(code)] })

export const init = (): Model => ({
	dialog: Dialog.init("billing-details", "dialog"),
	name: "",
	line1: "",
	line2: "",
	city: "",
	state: "",
	postalCode: "",
	country: null,
	countryBox: countryBox(null),
	isSaving: false,
	taxType: taxTypeSelect("eu_vat"),
	taxValue: "",
	isMissingTaxValue: false,
	isAddingTax: false,
	removingTax: null,
	removeDialog: Dialog.init("billing-tax-remove", "alert-dialog"),
	removingTaxIds: [],
})

const liftDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, dialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotDialogMessage({ message })),
})

/** "Edit": the form starts from the profile on file, every time it opens. */
export const open = (model: Model, profile: BillingProfile): Return => {
	const address = profile.address
	const country = address?.country?.toUpperCase() ?? null
	return liftDialog(
		{
			...init(),
			name: profile.name ?? "",
			line1: address?.line1 ?? "",
			line2: address?.line2 ?? "",
			city: address?.city ?? "",
			state: address?.state ?? "",
			postalCode: address?.postalCode ?? "",
			country,
			countryBox: countryBox(country),
			taxType: taxTypeSelect(defaultTaxIdTypeFor(address?.country) ?? "eu_vat"),
			dialog: model.dialog,
		},
		Dialog.open(model.dialog),
	)
}

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

const fresh = (step: Return): Step => ({ step, isProfileStale: false })
const stale = (step: Return): Step => ({ step, isProfileStale: true })

const liftRemove = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: {
		...model,
		removeDialog: step.model,
		...(step.outMessage?._tag === "Closed" && { removingTax: null }),
	},
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotRemoveDialogMessage({ message }),
	),
})

const addTax = (model: Model): Return => {
	const value = model.taxValue.trim()
	const type = model.taxType.value
	if (model.isAddingTax || !isTaxIdType(type)) return { model }
	if (value.length === 0) return { model: { ...model, isMissingTaxValue: true } }
	return {
		model: { ...model, isAddingTax: true },
		commands: [AddTaxId({ payload: new AddBillingTaxIdRequest({ type, value }) })],
	}
}

export const update = (model: Model, message: Message): Step =>
	Message.match<Step>(message, {
		GotDialogMessage: ({ message: child }) =>
			fresh(liftDialog(model, Dialog.update(model.dialog, child))),
		ChangedField: ({ field, value }) => fresh({ model: { ...model, [field]: value } }),
		GotCountryMessage: ({ message: child }) => {
			const step = Combobox.update(model.countryBox, child)
			const picked =
				step.outMessage?._tag === "ChangedValue" ? codeOfName(step.outMessage.value) : undefined
			return fresh({
				model: { ...model, countryBox: step.model, ...(picked !== undefined && { country: picked }) },
				commands: Command.mapMessages(step.commands ?? [], (inner) =>
					Message.GotCountryMessage({ message: inner }),
				),
			})
		},
		SubmittedDetails: () => {
			if (model.isSaving) return fresh({ model })
			const fields = {
				line1: fieldOrNull(model.line1),
				line2: fieldOrNull(model.line2),
				city: fieldOrNull(model.city),
				state: fieldOrNull(model.state),
				postalCode: fieldOrNull(model.postalCode),
				country: model.country,
			}
			const anyAddress = Object.values(fields).some((value) => value !== null)
			// All-empty clears the address; otherwise every line is sent so a removed one is cleared.
			const payload = new UpdateBillingProfileRequest({
				name: fieldOrNull(model.name),
				address: anyAddress ? new BillingAddress(fields) : null,
			})
			return fresh({ model: { ...model, isSaving: true }, commands: [SaveDetails({ payload })] })
		},
		CompletedSave: ({ result }) =>
			Result.match(result, {
				onSuccess: () =>
					stale({
						...liftDialog({ ...model, isSaving: false }, Dialog.close(model.dialog)),
						outMessage: toast("success", "Billing details saved"),
					}),
				onFailure: (error) =>
					fresh({
						model: { ...model, isSaving: false },
						outMessage: toast("error", "Billing details could not be saved.", error.message),
					}),
			}),
		GotTaxTypeMessage: ({ message: child }) => {
			const step = Select.update(model.taxType, child)
			return fresh({
				model: { ...model, taxType: step.model },
				commands: Command.mapMessages(step.commands ?? [], (inner) =>
					Message.GotTaxTypeMessage({ message: inner }),
				),
			})
		},
		ChangedTaxValue: ({ value }) =>
			fresh({ model: { ...model, taxValue: value, isMissingTaxValue: false } }),
		// Inside the details form, Enter adds the ID instead of submitting the form.
		PressedTaxKey: ({ key }) => fresh(key === "Enter" ? addTax(model) : { model }),
		ClickedAddTax: () => fresh(addTax(model)),
		CompletedAddTax: ({ result }) =>
			Result.match(result, {
				onSuccess: () =>
					stale({
						model: { ...model, isAddingTax: false, taxValue: "" },
						outMessage: toast("success", "Tax ID added. Stripe is verifying it."),
					}),
				onFailure: (error) =>
					fresh({
						model: { ...model, isAddingTax: false },
						outMessage: toast("error", "The tax ID could not be added.", error.message),
					}),
			}),
		ClickedRemoveTax: ({ taxId }) =>
			fresh(liftRemove({ ...model, removingTax: taxId }, Dialog.open(model.removeDialog))),
		GotRemoveDialogMessage: ({ message: child }) =>
			fresh(liftRemove(model, Dialog.update(model.removeDialog, child))),
		ClickedConfirmRemoveTax: () =>
			Option.match(Option.fromNullishOr(model.removingTax), {
				onNone: () => fresh({ model }),
				onSome: (taxId) => {
					const closed = liftRemove(
						{ ...model, removingTaxIds: [...model.removingTaxIds, taxId.id] },
						Dialog.close(model.removeDialog),
					)
					return fresh({
						...closed,
						commands: [
							...(closed.commands ?? []),
							RemoveTaxId({ taxId: { id: taxId.id, type: taxId.type, value: taxId.value } }),
						],
					})
				},
			}),
		CompletedRemoveTax: ({ taxId, result }) => {
			const next = { ...model, removingTaxIds: model.removingTaxIds.filter((id) => id !== taxId.id) }
			return Result.match(result, {
				onSuccess: () =>
					stale({
						model: next,
						outMessage: toast("success", `Removed ${taxIdLabel(taxId.type)} ${taxId.value}`),
					}),
				onFailure: (error) =>
					fresh({
						model: next,
						outMessage: toast("error", "The tax ID could not be removed.", error.message),
					}),
			})
		},
	})
