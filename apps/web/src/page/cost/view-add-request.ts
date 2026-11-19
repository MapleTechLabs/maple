import { COST_SOURCE_REQUEST_PROVIDER_MAX_LENGTH } from "@maple/domain/http"
import { String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import * as DialogView from "@maple/views/ui/dialog-view"
import * as Field from "@maple/views/ui/field"
import { field, fieldDescription, fieldError, type FieldIds, fieldLabel, input } from "@maple/views/ui/field"
import { formDialogForm } from "@maple/views/ui/form-dialog"
import { vstack } from "@maple/views/ui/stack"
import { textarea } from "@maple/views/ui/textarea"
import { Message } from "./message"
import type { Model } from "./model"

type H = HtmlBuilder<Message>

const PROVIDER_IDS: FieldIds = {
	control: "cost-request-provider",
	label: "cost-request-provider-label",
	error: "cost-request-provider-error",
	description: "cost-request-provider-description",
}

const NOTE_DESCRIPTION_ID = "cost-request-note-description"

const NOTE_IDS: FieldIds = {
	control: "cost-request-note",
	label: "cost-request-note-label",
	error: "cost-request-note-error",
	description: NOTE_DESCRIPTION_ID,
}

const providerField = (h: H, model: Model, isSaving: boolean): Html => {
	const state = Field.stateOf(model.requestProviderDraft, model.requestError !== null)
	return field(h, { state }, [
		fieldLabel(h, { ids: PROVIDER_IDS, state }, "Provider"),
		input(h, {
			ids: PROVIDER_IDS,
			state,
			attributes: [
				h.Placeholder("Hetzner, Datadog, Snowflake…"),
				h.Attribute("autocomplete", "off"),
				h.Attribute("maxlength", String(COST_SOURCE_REQUEST_PROVIDER_MAX_LENGTH)),
				...(isSaving ? [h.Disabled(true)] : []),
				...Field.controlAttributes(h, model.requestProviderDraft, (message) =>
					Message.GotRequestProviderMessage({ message }),
				),
			],
		}),
		...(model.requestError === null
			? []
			: [
					fieldError(h, { ids: PROVIDER_IDS, state, attributes: [h.Role("alert")] }, [
						model.requestError,
					]),
				]),
	])
}

const noteField = (h: H, model: Model, isSaving: boolean): Html => {
	const state = Field.stateOf(Field.init(model.requestNote), false)
	return field(h, { state }, [
		fieldLabel(h, { ids: NOTE_IDS, state }, "What would you want to see? (optional)"),
		textarea(h, {
			id: NOTE_IDS.control,
			isDisabled: isSaving,
			defaultValue: model.requestNote,
			attributes: [
				h.AriaLabelledBy(NOTE_IDS.label),
				h.AriaDescribedBy(NOTE_DESCRIPTION_ID),
				h.Rows(3),
				h.OnInput((value) => Message.ChangedRequestNote({ value })),
			],
		}),
		fieldDescription(h, { ids: NOTE_IDS, state }, [
			"For example the products, projects or accounts you would split the cost by.",
		]),
	])
}

/**
 * The dialog's request step: the provider someone wants Maple to read cost from, and why. Opened
 * from the providers, with the search that found nothing as the provider.
 */
export const requestStep = (h: H, model: Model, id: string): ReadonlyArray<Html> => {
	const isSaving = model.sourceWrite === "Saving"
	const canSubmit = !isSaving && Str.trim(model.requestProviderDraft.value) !== ""
	return [
		formDialogForm(h, canSubmit ? Message.SubmittedRequest() : undefined, [
			DialogView.dialogHeader(h, "dialog", [
				DialogView.dialogTitle(h, "dialog", id, "Request a provider"),
				DialogView.dialogDescription(
					h,
					"dialog",
					id,
					"Tell us where else your money goes. Requests decide which source Maple reads next.",
				),
			]),
			DialogView.dialogPanel(h, "dialog", id, [
				vstack(h, { gap: "4" }, [providerField(h, model, isSaving), noteField(h, model, isSaving)]),
			]),
			DialogView.dialogFooter(h, "dialog", [
				button(
					h,
					{
						variant: "outline",
						isDisabled: isSaving,
						attributes: [h.OnClick(Message.ClickedBackToProviders())],
					},
					["Back"],
				),
				button(h, { type: "submit", isLoading: isSaving, isDisabled: !canSubmit }, ["Send request"]),
			]),
		]),
	]
}
