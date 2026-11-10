import { Option, Array as Arr, String as Str } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import * as Combobox from "@maple/views/ui/combobox"
import { chipsView } from "@maple/views/ui/combobox-view"
import { panel } from "@maple/views/ui/panel"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { sidePanelSheet } from "@maple/views/ui/sheet"
import { vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { fieldErrorText } from "@maple/views/ui/field"
import type { V2AlertSilenceMatchers } from "@maple/domain/http/v2"
import {
	endZoneLabel,
	Message,
	type Model,
	reasonError,
	type Scope,
	scopeError,
	type ScopeField,
	type ScopeSuggestions,
	type SilenceDuration,
	silenceEndMs,
	untilError,
} from "./dialog"
import {
	dialogHelp,
	dialogLabel,
	dialogTextField,
	type DialogTextFieldOptions,
} from "../shared/matcher-fields"
import { formatSilenceTime } from "../shared/silences"

type H = HtmlBuilder<Message>

const DURATIONS: ReadonlyArray<{ value: SilenceDuration; label: string }> = [
	{ value: "1h", label: "1 hour" },
	{ value: "4h", label: "4 hours" },
	{ value: "morning", label: "Until 09:00" },
	{ value: "custom", label: "Custom" },
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

/** A field's error once a save was tried. */
const shown = (model: Model, error: Option.Option<string>): Option.Option<string> =>
	model.isShowingErrors ? error : Option.none()

const textField = (h: H, options: Omit<DialogTextFieldOptions<Message>, "idPrefix">): Html =>
	dialogTextField(h, { ...options, idPrefix: "silence" })

/** What a scope fixed by a rule or an incident covers, in a sentence. */
const fixedScopeLine = (matchers: V2AlertSilenceMatchers): string => {
	const groups = [...(matchers.services ?? []), ...(matchers.environments ?? [])]
	return groups.length > 0
		? `Only the ${Arr.join(groups, ", ")} group of this rule`
		: "Every notification of this rule"
}

const SCOPE_FIELDS: ReadonlyArray<{ field: ScopeField; label: string; placeholder: string }> = [
	{ field: "services", label: "Services", placeholder: "Add a service" },
	{ field: "environments", label: "Environments", placeholder: "Add an environment" },
	{ field: "tags", label: "Tags", placeholder: "Add a tag" },
]

const SCOPE_HELP_ID = "silence-scope-help"
const SCOPE_ENTRY_HELP_ID = "silence-scope-entry-help"
const SCOPE_ERROR_ID = "silence-scope-error"

const NO_SUGGESTIONS: ScopeSuggestions = { services: [], environments: [], tags: [] }

/** The suggestions, then what is typed when it is none of them: a name no rule lists can still be added. */
const itemsOf = (suggested: ReadonlyArray<string>, typed: string): ReadonlyArray<string> => {
	const draft = Str.trim(typed)
	return draft === "" || suggested.includes(draft) ? suggested : [...suggested, draft]
}

/** One scope field: its label and the chips input, suggesting what the org's rules already name. */
const chipsField = (
	h: H,
	model: Model,
	scope: Extract<Scope, { readonly _tag: "Typed" }>,
	suggestions: ScopeSuggestions,
	{ field, label, placeholder }: (typeof SCOPE_FIELDS)[number],
): Html => {
	const combo = model.combos[field]
	const labelId = `${combo.id}-label`
	return vstack(h, { gap: "1.5" }, [
		dialogLabel(h, { id: labelId, htmlFor: Combobox.inputId(combo.id) }, label),
		h.submodel({
			slotId: `${combo.id}-chips`,
			model: { ...combo, selected: scope[field] },
			view: chipsView,
			toParentMessage: (message) => Message.GotScopeComboMessage({ field, message }),
			viewInputs: {
				items: itemsOf(suggestions[field], combo.inputValue),
				ariaLabelledBy: labelId,
				ariaDescribedBy: `${SCOPE_ENTRY_HELP_ID} ${SCOPE_HELP_ID}`,
				placeholder,
				isDisabled: model.isSaving,
				toView: (parts) => h.div([], parts),
			},
		}),
	])
}

const scopeSection = (h: H, model: Model, suggestions: ScopeSuggestions): ReadonlyArray<Html> => {
	const scope = model.scope
	return scope._tag === "Fixed"
		? [
				vstack(h, { gap: "1.5" }, [
					dialogLabel(h, { id: "silence-covers-label" }, "Covers"),
					panel(h, { padded: true, className: "gap-1" }, [
						typography(h, { size: "sm", weight: "medium" }, [scope.label]),
						typography(h, { size: "xs", tone: "muted" }, [fixedScopeLine(scope.matchers)]),
					]),
				]),
			]
		: [
				...Arr.map(SCOPE_FIELDS, (entry) => chipsField(h, model, scope, suggestions, entry)),
				vstack(h, { gap: "1.5" }, [
					// In the flow, not in the list's popup: there it sat over the next field's label.
					dialogHelp(
						h,
						SCOPE_ENTRY_HELP_ID,
						"Type a name and press Enter to add it. Commas separate several.",
					),
					dialogHelp(
						h,
						SCOPE_HELP_ID,
						"Fill in at least one. A rule is silenced only if it matches every field you fill in.",
					),
					...Option.toArray(
						Option.map(shown(model, scopeError(scope)), (message) =>
							fieldErrorText(
								h,
								{ attributes: [h.Id(SCOPE_ERROR_ID), h.Role("alert")] },
								message,
							),
						),
					),
				]),
			]
}

const durationSection = (h: H, model: Model): ReadonlyArray<Html> => [
	vstack(h, { gap: "1.5" }, [
		dialogLabel(h, { id: "silence-duration-label" }, "Duration"),
		segmentedSelect(h, {
			ariaLabel: "Silence duration",
			options: DURATIONS,
			value: model.duration,
			onChange: (duration) => Message.ChangedDuration({ duration }),
			size: "lg",
			className: "w-fit flex-wrap",
		}),
	]),
	...(model.duration === "custom"
		? [
				textField(h, {
					name: "until",
					// The viewer's own clock, named: "Ends, CET".
					label: `Ends, ${endZoneLabel(model)}`,
					value: model.until,
					placeholder: "",
					type: "datetime-local",
					onInput: (value) => Message.ChangedUntil({ value }),
					description: "Your local time. At most 30 days from now.",
					error: untilError(model),
				}),
			]
		: []),
]

/** The "Silence notifications" side panel: what it covers, for how long, and why. */
export const view = Submodel.defineView<Model, Message, { id: string; suggestions?: ScopeSuggestions }>(
	(model, inputs, h) =>
		sidePanelSheet(h, {
			sheet: model.dialog,
			size: "compact",
			toParentMessage: (message) => Message.GotDialogMessage({ message }),
			title: "Silence notifications",
			description:
				"Rules keep checking and incidents still open and resolve, but no one is paged. If an incident is still open when the silence ends, its page goes out then.",
			body: [
				vstack(h, { gap: "5" }, [
					...scopeSection(h, model, inputs.suggestions ?? NO_SUGGESTIONS),
					...durationSection(h, model),
					textField(h, {
						name: "reason",
						label: "Reason",
						value: model.reason,
						placeholder: "Deploying checkout v2.3",
						onInput: (value) => Message.ChangedReason({ value }),
						error: shown(model, reasonError(model.reason)),
					}),
				]),
			],
			onSubmit: Message.ClickedSave(),
			footer: (close) => [
				button(
					h,
					{
						variant: "outline",
						isDisabled: model.isSaving,
						attributes: model.isSaving ? [] : close,
					},
					["Cancel"],
				),
				button(
					h,
					{
						type: "submit",
						isLoading: model.isSaving,
						// Never disabled for a missing field: pressing it says what is missing.
						isDisabled: model.isSaving,
					},
					[submitLabel(model)],
				),
			],
		}),
)
