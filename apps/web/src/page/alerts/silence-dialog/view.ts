import { Option, Array as Arr } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { formDialog } from "@maple/views/ui/form-dialog"
import { panel } from "@maple/views/ui/panel"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import type { V2AlertSilenceMatchers } from "@maple/domain/http/v2"
import { isFormReady, Message, type Model, type SilenceDuration, silenceEndMs, untilError } from "./dialog"
import { dialogTextField, type DialogTextFieldOptions, matcherFields } from "../shared/matcher-fields"
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

const textField = (h: H, options: Omit<DialogTextFieldOptions<Message>, "idPrefix">): Html =>
	dialogTextField(h, { ...options, idPrefix: "silence" })

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
			: panel(
					h,
					{ padded: true, className: "gap-3" },
					matcherFields(h, {
						idPrefix: "silence",
						typed: model.scope,
						onInput: (field, value) => Message.ChangedScopeField({ field, value }),
					}),
				),
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
			className: "w-fit flex-wrap",
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
