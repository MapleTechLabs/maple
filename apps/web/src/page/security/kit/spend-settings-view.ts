import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "../../../ui/alert"
import * as Field from "../../../ui/field"
import { formDialog } from "../../../ui/form-dialog"
import { icon } from "../../../ui/icon"
import { inputGroup, inputGroupAddon, inputGroupInput } from "../../../ui/input-group"
import { meter } from "../../../ui/meter"
import { formatUsd } from "./format"
import { modelPicker } from "./model-picker"
import { DIALOG_ID, draftLimitOf, errorsOf, Message, type Model, NO_ERRORS } from "./spend-settings"

// The Spend & models form inside the shared FormDialog.

type H = HtmlBuilder<Message>

const ids: Field.FieldIds = {
	control: `${DIALOG_ID}-limit`,
	label: `${DIALOG_ID}-limit-label`,
	description: `${DIALOG_ID}-limit-description`,
	error: `${DIALOG_ID}-limit-error`,
}

const monthDay = (epochMs: number): string =>
	new Date(epochMs).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

/** This month's spend against the limit as typed, so raising it shows the room it makes. */
const usage = (h: H, model: Model): ReadonlyArray<Html> => {
	const current = model.current
	const limit = draftLimitOf(model)
	if (current === null || limit === null) return []
	return [
		h.div(
			[h.Class("flex w-full flex-col gap-1.5 pt-1")],
			[
				meter(h, {
					value: Math.min(current.spentUsd, limit),
					max: limit,
					tone: current.spentUsd >= limit ? "warn" : undefined,
					label: `${formatUsd(current.spentUsd)} of ${formatUsd(limit)} spent this month`,
				}),
				h.div(
					[h.Class("flex w-full items-center justify-between gap-3 text-xs")],
					[
						h.span([], [`${formatUsd(current.spentUsd)} spent since ${monthDay(current.since)}`]),
						h.span([h.Class("text-muted-foreground")], [`resets ${monthDay(current.resetsAt)}`]),
					],
				),
			],
		),
	]
}

const limitField = (h: H, model: Model, error?: string): Html => {
	const state = { ...Field.stateOf(model.limit, error !== undefined), isFilled: model.limit.value !== "" }
	return Field.field(h, { state }, [
		Field.fieldLabel(h, { ids, state }, "Monthly spend limit"),
		inputGroup(h, { className: "max-w-64" }, [
			inputGroupAddon(h, {}, ["$"]),
			inputGroupInput(h, {
				id: ids.control,
				attributes: [
					h.AriaLabelledBy(ids.label),
					h.AriaDescribedBy(error === undefined ? (ids.description ?? "") : ids.error),
					...(error === undefined ? [] : [h.AriaInvalid(true)]),
					h.Attribute("inputmode", "numeric"),
					h.Attribute("autocomplete", "off"),
					...Field.controlAttributes(h, model.limit, (message) =>
						Message.GotLimitMessage({ message }),
					),
				],
			}),
			inputGroupAddon(h, { align: "inline-end" }, [
				h.span([h.Class("whitespace-nowrap")], ["per month"]),
			]),
		]),
		...usage(h, model),
		Field.fieldDescription(
			h,
			{ ids, state },
			"Paid in AI credits: each agent's model cost plus a small sandbox fee. When the org reaches the limit, running audits stop and list what they did not cover. Raise it to run again.",
		),
		...(error === undefined
			? []
			: [Field.fieldError(h, { ids, state, attributes: [h.Role("alert")] }, error)]),
	])
}

const modelsField = (h: H, model: Model, error?: string): Html =>
	h.div(
		[h.Class("flex flex-col gap-3 border-t pt-5")],
		[
			h.div(
				[h.Class("flex flex-col gap-1")],
				[
					h.span([h.Class("text-sm font-medium")], ["Default models"]),
					h.span(
						[h.Class("text-xs text-muted-foreground")],
						[
							"Verification runs on a different model than hunting, so it does not share the hunter's blind spots. A target can override both.",
						],
					),
				],
			),
			h.div(
				[h.Class("grid grid-cols-2 gap-2")],
				[
					modelPicker(h, {
						stage: "discovery",
						model: model.discovery,
						idPrefix: DIALOG_ID,
						wrap: (message) => Message.GotDiscoveryMessage({ message }),
					}),
					modelPicker(h, {
						stage: "validation",
						model: model.validation,
						idPrefix: DIALOG_ID,
						wrap: (message) => Message.GotValidationMessage({ message }),
					}),
				],
			),
			...(error === undefined
				? []
				: [h.p([h.Role("alert"), h.Class("text-xs text-destructive")], [error])]),
		],
	)

const failureAlert = (h: H, model: Model): ReadonlyArray<Html> =>
	model.failure === null
		? []
		: [
				alert(h, { variant: "crit" }, [
					icon(h, "CircleWarningIcon"),
					alertTitle(h, [model.failure.title]),
					alertDescription(h, [model.failure.message]),
				]),
			]

const spendSettingsDialog = (h: H, model: Model): Html => {
	const errors = model.isSubmitted ? errorsOf(model) : NO_ERRORS
	return formDialog(h, {
		slotId: DIALOG_ID,
		model: model.dialog,
		toParentMessage: (message) => Message.GotDialogMessage({ message }),
		title: "Spend & models",
		description: "Applies to every security audit in this organization.",
		onSubmit: Message.Submitted(),
		submitLabel: model.isPending ? "Saving…" : "Save changes",
		isSubmitDisabled: model.isPending,
		panelClassName: "flex flex-col gap-5",
		fields: [
			...failureAlert(h, model),
			limitField(h, model, errors.limit),
			modelsField(h, model, errors.validation),
		],
	})
}

export const spendSettingsView = Submodel.defineView<Model, Message, Readonly<Record<never, never>>>(
	(model, _inputs, h) => spendSettingsDialog(h, model),
)
