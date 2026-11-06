import { Option, Array as Arr } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { fieldDescription, fieldError, fieldLabel, type FieldIds, input } from "@maple/views/ui/field"
import { formDialog } from "@maple/views/ui/form-dialog"
import type { FieldState } from "@maple/views/ui/input"
import { panel } from "@maple/views/ui/panel"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import type { V2AlertSilenceMatchers } from "@maple/domain/http/v2"
import {
	isFormReady,
	Message,
	type Model,
	type ScopeField,
	type SilenceDuration,
	silenceEndMs,
	untilError,
} from "./dialog"
import { formatSilenceTime } from "../shared/silences"

type H = HtmlBuilder<Message>

const DURATIONS: ReadonlyArray<{ value: SilenceDuration; label: string }> = [
	{ value: "1h", label: "1 hour" },
	{ value: "4h", label: "4 hours" },
	{ value: "morning", label: "Until 09:00" },
	{ value: "custom", label: "Pick time" },
]

/** "Silence for 1 hour", or the end it will stop at: "Silence until Nov 7, 18:30". */
const submitLabel = (model: Model): string =>
	model.duration === "1h"
		? "Silence for 1 hour"
		: model.duration === "4h"
			? "Silence for 4 hours"
			: Option.match(silenceEndMs(model.duration, model.until, model.nowMs, model.timeZone), {
					onNone: () => "Silence",
					onSome: (endMs) =>
						`Silence until ${formatSilenceTime(endMs, model.nowMs, model.timeZone)}`,
				})

const stateOf = (value: string, isInvalid = false): FieldState => ({
	isInvalid,
	isDirty: false,
	isFilled: value !== "",
	isFocused: false,
	isTouched: false,
})

const ids = (name: string, hasDescription = false): FieldIds => ({
	control: `silence-${name}`,
	label: `silence-${name}-label`,
	error: `silence-${name}-error`,
	...(hasDescription ? { description: `silence-${name}-description` } : undefined),
})

const textField = (
	h: H,
	options: Readonly<{
		name: string
		label: string
		value: string
		placeholder: string
		onInput: (value: string) => Message
		type?: string
		description?: string
		error?: Option.Option<string>
	}>,
): Html => {
	const fieldIds = ids(options.name, options.description !== undefined)
	const error = options.error ?? Option.none()
	const state = stateOf(options.value, Option.isSome(error))
	return vstack(h, { gap: "1.5" }, [
		fieldLabel(h, { ids: fieldIds, className: "text-xs", state }, [options.label]),
		input(h, {
			ids: fieldIds,
			state,
			attributes: [
				h.Value(options.value),
				h.Placeholder(options.placeholder),
				h.OnInput(options.onInput),
				h.Attribute("autocomplete", "off"),
				...(options.type === undefined ? [] : [h.Type(options.type)]),
			],
		}),
		...(options.description === undefined
			? []
			: [fieldDescription(h, { ids: fieldIds, state }, [options.description])]),
		...Option.toArray(
			Option.map(error, (message) =>
				fieldError(h, { ids: fieldIds, state, attributes: [h.Role("alert")] }, [message]),
			),
		),
	])
}

const SCOPE_FIELDS: ReadonlyArray<{ field: ScopeField; label: string; placeholder: string }> = [
	{ field: "services", label: "Services", placeholder: "checkout, payments" },
	{ field: "environments", label: "Environments", placeholder: "production" },
	{ field: "tags", label: "Tags", placeholder: "database" },
]

/** What a scope fixed by a rule or an incident covers, in a sentence. */
const fixedScopeLine = (matchers: V2AlertSilenceMatchers): string => {
	const groups = [...(matchers.services ?? []), ...(matchers.environments ?? [])]
	return groups.length > 0
		? `Only the ${Arr.join(groups, ", ")} group of this rule`
		: "Every notification of this rule"
}

const scopeSection = (h: H, model: Model): Html =>
	vstack(h, { gap: "2" }, [
		eyebrow(h, { variant: "label", as: "div" }, ["Covers"]),
		model.scope._tag === "Fixed"
			? panel(h, { padded: true, className: "gap-1" }, [
					typography(h, { size: "sm", weight: "medium" }, [model.scope.label]),
					typography(h, { size: "xs", tone: "muted" }, [fixedScopeLine(model.scope.matchers)]),
				])
			: panel(h, { padded: true, className: "gap-3" }, [
					...Arr.map(SCOPE_FIELDS, ({ field, label, placeholder }) =>
						textField(h, {
							name: field,
							label,
							value: model.scope._tag === "Typed" ? model.scope[field] : "",
							placeholder,
							onInput: (value) => Message.ChangedScopeField({ field, value }),
						}),
					),
					typography(h, { size: "xs", tone: "muted" }, [
						"Fill in at least one. Every listed field must match: a rule's services and environments all listed, and one of its tags.",
					]),
				]),
	])

const durationSection = (h: H, model: Model): Html =>
	vstack(h, { gap: "2" }, [
		eyebrow(h, { variant: "label", as: "div" }, ["For"]),
		segmentedSelect(h, {
			ariaLabel: "Silence duration",
			options: DURATIONS,
			value: model.duration,
			onChange: (duration) => Message.ChangedDuration({ duration }),
			size: "sm",
			className: "max-w-full overflow-x-auto",
		}),
		...(model.duration === "custom"
			? [
					textField(h, {
						name: "until",
						label: "Ends",
						value: model.until,
						placeholder: "",
						type: "datetime-local",
						onInput: (value) => Message.ChangedUntil({ value }),
						description: `In ${model.timeZone}. At most 30 days from now.`,
						error: untilError(model),
					}),
				]
			: []),
	])

/** The "Silence notifications" dialog: what it covers, for how long, and why. */
export const view = Submodel.defineView<Model, Message, { id: string }>((model, inputs, h) =>
	formDialog(h, {
		slotId: `${inputs.id}-dialog`,
		model: model.dialog,
		toParentMessage: (message) => Message.GotDialogMessage({ message }),
		className: "sm:max-w-lg",
		title: "Silence notifications",
		description:
			"Rules keep checking and incidents still open and resolve, but no one is paged. If an incident is still open when the silence ends, its page goes out then.",
		panelClassName: "space-y-5",
		fields: [
			scopeSection(h, model),
			durationSection(h, model),
			textField(h, {
				name: "reason",
				label: "Reason",
				value: model.reason,
				placeholder: "Deploying checkout v2.3",
				onInput: (value) => Message.ChangedReason({ value }),
			}),
		],
		onSubmit: Message.ClickedSave(),
		submitLabel: submitLabel(model),
		isPending: model.isSaving,
		isSubmitDisabled: !isFormReady(model),
	}),
)
