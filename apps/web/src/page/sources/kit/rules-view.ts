import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import * as Checkbox from "../../../ui/checkbox"
import { type FieldIds, type FieldState, field, fieldDescription, fieldLabel } from "../../../ui/field"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { input } from "../../../ui/input"
import { inputGroup, inputGroupAddon, inputGroupInput, inputGroupText } from "../../../ui/input-group"
import * as ToggleGroup from "../../../ui/toggle-group"
import {
	type AttributeDraft,
	expiryChoicesOf,
	MAX_ATTRIBUTES,
	MAX_RATE_LIMIT_RPS,
	Message,
	type Model,
	modeGroupLabel,
	rulesOutcome,
	toggleModel,
} from "./rules"
import { MODE_LABELS, SIGNALS } from "./shared"

// `RulesFields` and `AttributeRows`.

export type RulesViewConfig<P> = Readonly<{
	model: Model
	toParentMessage: (message: Message) => P
	/** Prefix for control ids, unique on the page. */
	idPrefix: string
	/** `Date.now()` for the "Expires in" hint. */
	nowMs: number
}>

/** A Base UI field outside a form: never dirty, touched or focused in a capture. */
const STATIC: FieldState = {
	isInvalid: false,
	isDirty: false,
	isFilled: false,
	isFocused: false,
	isTouched: false,
}

const idsOf = (prefix: string, name: string): FieldIds => ({
	control: `${prefix}-${name}`,
	label: `${prefix}-${name}-label`,
	error: `${prefix}-${name}-error`,
	description: `${prefix}-${name}-description`,
})

const signalCard = <P>(
	h: HtmlBuilder<P>,
	config: RulesViewConfig<P>,
	signal: (typeof SIGNALS)[number],
): Html => {
	const isChecked = config.model.signals.includes(signal.value)
	const inputId = `${config.idPrefix}-signal-${signal.value}`
	return h.label(
		[
			h.Key(signal.value),
			h.Id(Checkbox.labelId(inputId)),
			h.Class(
				cn(
					"flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 transition-colors",
					isChecked ? "border-primary/60 bg-primary/[0.06]" : "hover:bg-muted/50",
				),
			),
		],
		[
			...Checkbox.view(h, {
				model: { isChecked },
				toParentMessage: () =>
					config.toParentMessage(Message.ToggledSignal({ signal: signal.value })),
				id: `${inputId}-root`,
				inputId,
				className: "mt-0.5",
			}),
			h.span(
				[h.Class("flex flex-col gap-0.5")],
				[
					h.span([h.Class(cn("text-sm", !isChecked && "text-muted-foreground"))], [signal.label]),
					h.span([h.Class("text-muted-foreground font-mono text-2xs")], [signal.hint]),
				],
			),
		],
	)
}

const attributeRow = <P>(h: HtmlBuilder<P>, config: RulesViewConfig<P>, attribute: AttributeDraft): Html => {
	const { toParentMessage } = config
	const rowId = attribute.rowId
	const changed = (fieldName: "key" | "value") => (value: string) =>
		toParentMessage(Message.ChangedAttribute({ rowId, field: fieldName, value }))
	return h.div(
		[h.Key(rowId), h.Class("flex flex-wrap items-center gap-2 sm:flex-nowrap")],
		[
			input(h, {
				id: `${config.idPrefix}-attr-${rowId}-key`,
				className: "w-full min-w-0 font-mono text-xs sm:w-auto sm:flex-1",
				attributes: [
					h.AriaLabel("Attribute key"),
					h.Placeholder("service.name"),
					h.Value(attribute.key),
					h.OnInput(changed("key")),
				],
			}),
			input(h, {
				id: `${config.idPrefix}-attr-${rowId}-value`,
				className: "w-full min-w-0 font-mono text-xs sm:w-auto sm:flex-1",
				attributes: [
					h.AriaLabel("Attribute value"),
					h.Placeholder("value"),
					h.Value(attribute.value),
					h.OnInput(changed("value")),
				],
			}),
			ToggleGroup.view(h, {
				model: toggleModel(modeGroupLabel(attribute), ["set", "default"], attribute.mode),
				toParentMessage: (message) => toParentMessage(Message.GotModeMessage({ rowId, message })),
				variant: "outline",
				size: "sm",
				className: "w-44 shrink-0",
				items: [
					{ value: "set", label: MODE_LABELS.set, className: "flex-1" },
					{ value: "default", label: MODE_LABELS.default, className: "flex-1" },
				],
			}),
			iconButton(
				h,
				{
					label: "Remove attribute",
					className: "text-muted-foreground hover:text-foreground shrink-0",
					attributes: [h.OnClick(toParentMessage(Message.ClickedRemoveAttribute({ rowId })))],
				},
				[icon(h, "XmarkIcon")],
			),
		],
	)
}

/** Editable key, value and mode rows, with the first validation problem inline. */
const attributeRows = <P>(h: HtmlBuilder<P>, config: RulesViewConfig<P>): Html => {
	const { attributeProblem } = rulesOutcome(config.model)
	const isDisabled = config.model.attributes.length >= MAX_ATTRIBUTES
	return h.div(
		[h.Class("flex flex-col gap-2")],
		[
			...config.model.attributes.map((attribute) => attributeRow(h, config, attribute)),
			h.div(
				[h.Class("flex items-center gap-3")],
				[
					button(
						h,
						{
							variant: "ghost",
							size: "sm",
							className: "text-primary -ml-2",
							isDisabled,
							attributes: [h.OnClick(config.toParentMessage(Message.ClickedAddAttribute()))],
						},
						[
							icon(h, "PlusIcon", { attributes: [h.DataAttribute("icon", "inline-start")] }),
							"Add attribute",
						],
					),
					...(attributeProblem === null
						? []
						: [
								h.span(
									[h.Class("text-destructive text-xs"), h.Role("alert")],
									[attributeProblem],
								),
							]),
				],
			),
		],
	)
}

/** Signals, rate limit, expiry and resource attributes for a push source. */
export const view = <P>(h: HtmlBuilder<P>, config: RulesViewConfig<P>): Html => {
	const { model, toParentMessage, idPrefix } = config
	const { rateLimitValid } = rulesOutcome(model)
	const existing = model.existing
	const choices = expiryChoicesOf(model)
	const signalsIds = idsOf(idPrefix, "signals")
	const rateIds = idsOf(idPrefix, "rate-limit")
	const expiryIds = idsOf(idPrefix, "expires")
	const attributeIds = idsOf(idPrefix, "attributes")
	return h.fieldset(
		[h.Class("flex min-w-0 flex-col gap-6")],
		[
			field(h, { state: STATIC }, [
				fieldLabel(h, { ids: signalsIds, state: STATIC }, "Signals"),
				h.div(
					[h.Class("grid gap-2 sm:grid-cols-2")],
					SIGNALS.map((signal) => signalCard(h, config, signal)),
				),
				fieldDescription(
					h,
					{ ids: signalsIds, state: STATIC },
					model.signals.length === 0
						? "Allow at least one signal."
						: "Anything else is rejected with a 403.",
				),
			]),
			field(h, { state: STATIC }, [
				fieldLabel(h, { ids: rateIds, state: STATIC }, "Rate limit"),
				inputGroup(h, { className: "w-44" }, [
					inputGroupInput(h, {
						id: rateIds.control,
						controlClassName: "font-mono tabular-nums",
						attributes: [
							h.Attribute("inputmode", "numeric"),
							h.Placeholder("No limit"),
							h.Value(model.rateLimitText),
							h.OnInput((value) => toParentMessage(Message.ChangedRateLimit({ value }))),
						],
					}),
					inputGroupAddon(h, { align: "inline-end" }, [inputGroupText(h, {}, ["req/s"])]),
				]),
				fieldDescription(
					h,
					{ ids: rateIds, state: STATIC },
					rateLimitValid
						? "Leave empty for no limit. Requests over the limit get a 429."
						: `Enter a whole number between 1 and ${MAX_RATE_LIMIT_RPS}, or leave it empty.`,
				),
			]),
			field(h, { state: STATIC }, [
				fieldLabel(h, { ids: expiryIds, state: STATIC }, "Expires"),
				ToggleGroup.view(h, {
					model: toggleModel(
						"Expires",
						choices.map((choice) => choice.value),
						model.expiry,
					),
					toParentMessage: (message) => toParentMessage(Message.GotExpiryMessage({ message })),
					variant: "outline",
					size: "sm",
					items: choices.map((choice) => ({ value: choice.value, label: choice.label })),
				}),
				...(existing !== null && existing.expires_at !== null && model.expiry === "keep"
					? [
							fieldDescription(h, { ids: expiryIds, state: STATIC }, [
								existing.status === "expired" ? "Expired" : "Expires",
								" ",
								formatRelativeTime(existing.expires_at, config.nowMs),
								".",
							]),
						]
					: []),
			]),
			field(h, { state: STATIC }, [
				fieldLabel(h, { ids: attributeIds, state: STATIC }, "Resource attributes"),
				fieldDescription(
					h,
					{ ids: attributeIds, state: STATIC },
					"Written on everything this source sends.",
				),
				attributeRows(h, config),
			]),
		],
	)
}
