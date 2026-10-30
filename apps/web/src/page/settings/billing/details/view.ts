import { taxIdExampleFor, taxIdLabel } from "@maple/domain/billing-tax-ids"
import type { BillingProfile, BillingTaxId } from "@maple/domain/http"
import { verificationBadge } from "../../../../lib/billing/billing-profile"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../../ui/button"
import { view as comboboxView } from "../../../../ui/combobox-view"
import { confirmDialog } from "../../../../ui/confirm-dialog"
import { badge } from "../../../../ui/display"
import { field, fieldError, fieldLabel, type FieldState } from "../../../../ui/field"
import { formDialog } from "../../../../ui/form-dialog"
import { icon } from "../../../../ui/icon"
import { iconButton } from "../../../../ui/icon-button"
import { input } from "../../../../ui/input"
import * as SelectView from "../../../../ui/select-view"
import { fieldIds, stateFor, textField } from "../../account/fields"
import { type AddressField, Message, type Model } from "./model"
import { COUNTRY_NAMES, TYPE_OPTIONS } from "./update"

type H = HtmlBuilder<Message>

const IDLE: FieldState = stateFor("")

const changed = (field: AddressField) => (value: string) => Message.ChangedField({ field, value })

/** A tax ID as it prints: value, type and Stripe's verification badge. */
export const taxIdValue = <M>(h: HtmlBuilder<M>, taxId: BillingTaxId): Html => {
	const verification = verificationBadge(taxId.verificationStatus)
	return h.span(
		[h.Class("flex min-w-0 items-center gap-3")],
		[
			h.span([h.Class("font-mono tabular-nums")], [taxId.value]),
			h.span([h.Class("truncate text-muted-foreground")], [taxIdLabel(taxId.type)]),
			...(verification === null ? [] : [badge(h, { size: "sm", variant: verification.variant }, [verification.label])]),
		],
	)
}

const countryField = (h: H, model: Model): Html => {
	const state = stateFor(model.country ?? "")
	return field(h, { state }, [
		fieldLabel(h, { ids: { control: "billing-country-input", label: "billing-country-label", error: "billing-country-error" }, state }, "Country"),
		h.submodel({
			slotId: "billing-country",
			model: model.countryBox,
			view: comboboxView,
			toParentMessage: (message) => Message.GotCountryMessage({ message }),
			viewInputs: {
				items: COUNTRY_NAMES,
				placeholder: "Search countries…",
				emptyText: "No country found.",
				className: "h-8 w-full",
				toView: ({ field: control, rest }) => h.div([h.Class("contents")], [control, ...rest]),
			},
		}),
	])
}

const addTaxRow = (h: H, model: Model, profile: BillingProfile): Html => {
	const state = stateFor(model.taxValue, model.isMissingTaxValue)
	return field(h, { state, className: "gap-1.5" }, [
		h.div(
			[h.Class("flex flex-wrap items-center gap-2")],
			[
				h.submodel({
					slotId: "billing-tax-type",
					model: model.taxType,
					view: SelectView.view,
					toParentMessage: (message) => Message.GotTaxTypeMessage({ message }),
					viewInputs: {
						entries: TYPE_OPTIONS.map((item): SelectView.SelectEntry => ({ _tag: "Item", item })),
						ariaLabel: "Tax ID type",
						size: "sm",
						className: "w-48",
						toView: (parts) => h.div([h.Class("contents")], parts),
					},
				}),
				input(h, {
					id: "billing-tax-value",
					className: "min-w-0 flex-1 font-mono",
					attributes: [
						h.AriaLabel("Tax ID"),
						h.Value(model.taxValue),
						h.Placeholder(taxIdExampleFor(model.taxType.value, profile.address?.country)),
						h.OnInput((value) => Message.ChangedTaxValue({ value })),
						h.OnKeyDownPreventDefault((key) =>
							key === "Enter" ? Option.some(Message.PressedTaxKey({ key })) : Option.none(),
						),
					],
				}),
				button(
					h,
					{
						size: "sm",
						variant: "outline",
						isLoading: model.isAddingTax,
						attributes: [h.OnClick(Message.ClickedAddTax())],
					},
					["Add"],
				),
			],
		),
		...(model.isMissingTaxValue
			? [fieldError(h, { ids: fieldIds("billing-tax-value"), state }, "Enter the tax ID first.")]
			: []),
	])
}

/** `BillingTaxIdsEditor`: saved as they are added or removed, each its own Stripe object. */
const taxIdsEditor = (h: H, model: Model, profile: BillingProfile): Html =>
	field(h, { state: IDLE, className: "gap-2" }, [
		fieldLabel(h, { ids: fieldIds("billing-tax-ids"), state: IDLE }, "Tax IDs"),
		...(!profile.linked
			? [h.p([h.Class("text-xs text-muted-foreground")], ["Available once your organization has a plan."])]
			: [
					...(profile.taxIds.length === 0
						? []
						: [
								h.ul(
									[h.Class("divide-y divide-border/60 text-sm")],
									profile.taxIds.map((taxId) =>
										h.li(
											[h.Key(taxId.id), h.Class("flex items-center gap-3 py-1.5")],
											[
												taxIdValue(h, taxId),
												iconButton(
													h,
													{
														size: "icon-xs",
														label: `Remove ${taxIdLabel(taxId.type)} ${taxId.value}`,
														className: "ml-auto text-muted-foreground",
														isDisabled: model.removingTaxIds.includes(taxId.id),
														attributes: [h.OnClick(Message.ClickedRemoveTax({ taxId }))],
													},
													[icon(h, "XmarkIcon")],
												),
											],
										),
									),
								),
							]),
					addTaxRow(h, model, profile),
					h.p(
						[h.Class("text-2xs leading-4 text-muted-foreground")],
						[
							"Tax IDs save as you add or remove them. EU, UK and Australian numbers are checked against the official registry; the ID is printed on invoices either way.",
						],
					),
				]),
		confirmDialog(h, {
			slotId: "billing-tax-remove",
			model: model.removeDialog,
			toParentMessage: (message) => Message.GotRemoveDialogMessage({ message }),
			title: "Remove tax ID?",
			...(model.removingTax !== null && {
				description: `${taxIdLabel(model.removingTax.type)} ${model.removingTax.value} will no longer print on invoices.`,
			}),
			confirmLabel: "Remove tax ID",
			onConfirm: Message.ClickedConfirmRemoveTax(),
		}),
	])

export const detailsDialog = (h: H, model: Model, profile: BillingProfile): Html =>
	formDialog(h, {
		slotId: "billing-details",
		model: model.dialog,
		toParentMessage: (message) => Message.GotDialogMessage({ message }),
		className: "max-w-[480px]",
		title: "Billing details",
		onSubmit: Message.SubmittedDetails(),
		submitLabel: "Save details",
		isPending: model.isSaving,
		fields: [
			textField(h, {
				id: "billing-name",
				label: "Company name",
				value: model.name,
				onInput: changed("name"),
				placeholder: "Legal entity as it should appear on invoices",
				autoComplete: "organization",
				attributes: [h.Maxlength(150)],
			}),
			textField(h, {
				id: "billing-line1",
				label: "Address",
				value: model.line1,
				onInput: changed("line1"),
				placeholder: "Street and number",
				autoComplete: "address-line1",
				after: [
					input(h, {
						id: "billing-line2",
						attributes: [
							h.AriaLabel("Address line 2"),
							h.Value(model.line2),
							h.Placeholder("Suite, floor, c/o (optional)"),
							h.Autocomplete("address-line2"),
							h.OnInput(changed("line2")),
						],
					}),
				],
			}),
			h.div(
				[h.Class("grid grid-cols-[1fr_2fr] gap-2")],
				[
					textField(h, {
						id: "billing-postal",
						label: "Postal code",
						value: model.postalCode,
						onInput: changed("postalCode"),
						autoComplete: "postal-code",
					}),
					textField(h, {
						id: "billing-city",
						label: "City",
						value: model.city,
						onInput: changed("city"),
						autoComplete: "address-level2",
					}),
				],
			),
			h.div(
				[h.Class("grid grid-cols-2 gap-2")],
				[
					textField(h, {
						id: "billing-state",
						label: "State / region",
						value: model.state,
						onInput: changed("state"),
						placeholder: "Optional",
						autoComplete: "address-level1",
					}),
					countryField(h, model),
				],
			),
			h.p(
				[h.Class("text-2xs leading-4 text-muted-foreground")],
				["Name and address are stored on your Stripe customer and printed on every invoice from the next one on."],
			),
			taxIdsEditor(h, model, profile),
		],
	})

export const view = Submodel.defineView<Model, Message, Readonly<{ profile: BillingProfile }>>((model, inputs, h) =>
	detailsDialog(h, model, inputs.profile),
)
