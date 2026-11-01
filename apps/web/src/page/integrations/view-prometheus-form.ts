import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { confirmDialog } from "../../ui/confirm-dialog"
import * as DialogView from "../../ui/dialog-view"
import * as Field from "../../ui/field"
import * as SelectView from "../../ui/select-view"
import { Message } from "./message"
import type { Model } from "./model"
import type { FormFieldName } from "./prometheus"
import { isFormValid, parsedInterval, prometheusTargets } from "./update-prometheus"

// `ScrapeTargetsSection`'s `FormDialog` (add and edit) and its delete `ConfirmDialog`.

type H = HtmlBuilder<Message>

const AUTH_ENTRIES: ReadonlyArray<SelectView.SelectEntry> = [
	{ _tag: "Item", item: { value: "none", label: "None" } },
	{ _tag: "Item", item: { value: "bearer", label: "Bearer token" } },
	{ _tag: "Item", item: { value: "basic", label: "Basic auth" } },
]

const idsOf = (control: string, hasDescription = false): Field.FieldIds => ({
	control,
	label: `${control}-label`,
	error: `${control}-error`,
	description: hasDescription ? `${control}-description` : undefined,
})

export const textField = (
	h: H,
	model: Model,
	options: Readonly<{
		field: FormFieldName
		id: string
		label: string
		placeholder: string
		type?: "password" | "number"
		description?: string
		error?: string
		extra?: ReadonlyArray<ReturnType<H["Attribute"]>>
		/** At the label's end: a "Where to find this" link. */
		aside?: Html
	}>,
): Html => {
	const fieldModel = model.prometheusCard.form[options.field]
	const isInvalid = options.error !== undefined
	const state = Field.stateOf(fieldModel, isInvalid)
	const ids = idsOf(options.id, options.description !== undefined)
	const label = Field.fieldLabel(h, { ids, state }, options.label)
	return Field.field(h, { state }, [
		options.aside === undefined
			? label
			: h.div([h.Class("flex items-center justify-between gap-2")], [label, options.aside]),
		Field.input(h, {
			ids,
			state,
			attributes: [
				...(options.type === undefined ? [] : [h.Type(options.type)]),
				h.Placeholder(options.placeholder),
				...(options.extra ?? []),
				...Field.controlAttributes(h, fieldModel, (message) =>
					Message.GotFormFieldMessage({ field: options.field, message }),
				),
			],
		}),
		...(options.description === undefined
			? []
			: [Field.fieldDescription(h, { ids, state }, options.description)]),
		...(options.error === undefined
			? []
			: [Field.fieldError(h, { ids, state, attributes: [h.Role("alert")] }, options.error)]),
	])
}

const keepPlaceholder = (model: Model, authType: "bearer" | "basic", fallback: string): string => {
	const editing = prometheusTargets(model).find((target) => target.id === model.prometheusCard.editingId)
	return editing !== undefined && editing.has_credentials && editing.auth_type === authType
		? "Leave blank to keep existing"
		: fallback
}

export const authField = (h: H, model: Model): Html => {
	const ids = idsOf("scrape-auth-type")
	const state = Field.stateOf(Field.init(), false)
	return Field.field(h, { state }, [
		Field.fieldLabel(h, { ids, state }, "Authentication"),
		h.submodel({
			slotId: "scrape-auth-type",
			model: model.prometheusCard.authSelect,
			view: SelectView.view,
			viewInputs: {
				entries: AUTH_ENTRIES,
				ariaLabel: "Authentication",
				className: "w-full",
				toView: (parts) => h.div([h.Class("contents")], parts),
			},
			toParentMessage: (message) => Message.GotAuthSelectMessage({ message }),
		}),
	])
}

/** The bearer token or basic auth fields the picked auth type asks for. */
export const credentialFields = (h: H, model: Model): ReadonlyArray<Html> => {
	const form = model.prometheusCard.form
	return [
		...(form.authType === "bearer"
			? [
					textField(h, model, {
						field: "token",
						id: "scrape-auth-token",
						label: "Bearer token",
						type: "password",
						placeholder: keepPlaceholder(model, "bearer", "Enter bearer token"),
					}),
				]
			: []),
		...(form.authType === "basic"
			? [
					textField(h, model, {
						field: "username",
						id: "scrape-auth-username",
						label: "Username",
						placeholder: keepPlaceholder(model, "basic", "Enter username"),
					}),
					textField(h, model, {
						field: "password",
						id: "scrape-auth-password",
						label: "Password",
						type: "password",
						placeholder: keepPlaceholder(model, "basic", "Enter password"),
					}),
				]
			: []),
	]
}

const formFields = (h: H, model: Model): ReadonlyArray<Html> => {
	const form = model.prometheusCard.form
	const intervalInvalid = parsedInterval(form) === null
	return [
		textField(h, model, {
			field: "name",
			id: "scrape-name",
			label: "Name",
			placeholder: "e.g. Node Exporter",
		}),
		textField(h, model, {
			field: "serviceName",
			id: "scrape-service-name",
			label: "Service name",
			placeholder: "e.g. my-api-server",
			description: "Metrics will appear under this service name. Defaults to the target name if empty.",
		}),
		textField(h, model, {
			field: "url",
			id: "scrape-url",
			label: "URL",
			placeholder: "e.g. https://myapp.com:9090/metrics",
		}),
		textField(h, model, {
			field: "interval",
			id: "scrape-interval",
			label: "Scrape interval (seconds)",
			placeholder: "",
			type: "number",
			extra: [h.Attribute("min", "5"), h.Attribute("max", "300")],
			error: intervalInvalid ? "Scrape interval must be an integer from 5 to 300 seconds." : undefined,
		}),
		authField(h, model),
		...credentialFields(h, model),
	]
}

const formDialog = (h: H, model: Model): Html => {
	const card = model.prometheusCard
	const isEditing = card.editingId !== null
	const id = card.formDialog.id
	return h.submodel({
		slotId: "scrape-target-form",
		model: card.formDialog,
		view: DialogView.view,
		viewInputs: {
			hasTrigger: false,
			toView: ({ portal }) => portal ?? h.empty,
			toContent: (close) => [
				h.form(
					[h.Class("contents"), h.OnSubmit(Message.SubmittedTargetForm())],
					[
						DialogView.dialogHeader(h, "dialog", [
							DialogView.dialogTitle(
								h,
								"dialog",
								id,
								isEditing ? "Edit scrape target" : "Add scrape target",
							),
							DialogView.dialogDescription(
								h,
								"dialog",
								id,
								isEditing
									? "Update the scrape target configuration."
									: "Enter the URL of a Prometheus exporter endpoint. Maple will periodically scrape this endpoint for metrics.",
							),
						]),
						DialogView.dialogPanel(h, "dialog", id, formFields(h, model), cn("space-y-4")),
						DialogView.dialogFooter(h, "dialog", [
							button(
								h,
								{
									variant: "outline",
									isDisabled: card.isSaving,
									slot: "dialog-close",
									attributes: card.isSaving ? [] : close,
								},
								["Cancel"],
							),
							button(
								h,
								{
									type: "submit",
									isLoading: card.isSaving,
									isDisabled: card.isSaving || !isFormValid(card.form),
								},
								[isEditing ? "Save changes" : "Add target"],
							),
						]),
					],
				),
			],
		},
		toParentMessage: (message) => Message.GotFormDialogMessage({ message }),
	})
}

export const targetDialogs = (h: H, model: Model): ReadonlyArray<Html> => {
	const card = model.prometheusCard
	const target = prometheusTargets(model).find((entry) => entry.id === card.deleteId)
	return [
		formDialog(h, model),
		confirmDialog(h, {
			slotId: "scrape-target-delete",
			model: card.deleteDialog,
			toParentMessage: (message) => Message.GotTargetDeleteDialogMessage({ message }),
			title: "Delete scrape target?",
			description: [
				"Maple stops scraping ",
				h.span([h.Class("font-medium text-foreground")], [target?.name ?? ""]),
				" and removes it from Sources. This cannot be undone.",
			],
			confirmLabel: "Delete scrape target",
			isPending: card.isDeleting,
			onConfirm: Message.ConfirmedTargetDelete(),
		}),
	]
}
