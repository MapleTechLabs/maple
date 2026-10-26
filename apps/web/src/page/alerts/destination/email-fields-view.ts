import { MAX_EMAIL_MEMBER_RECIPIENTS } from "@maple/web-data/alerts/form-utils"
import { initialsFrom } from "@maple/ui/lib/initials"
import { cn } from "@maple/ui/lib/utils"
import * as C from "@maple/ui/styles/ui/combobox"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Combobox from "../../../ui/combobox"
import { dismissButton, hiddenInput, inputAttributes, listPopup } from "../../../ui/combobox-view"
import { avatarFallback } from "../../../ui/display"
import { icon } from "../../../ui/icon"
import { field, fieldDescription, fieldError, type FieldIds, fieldLabel } from "../../../ui/field"
import type { FieldState } from "../../../ui/input"
import { isMounted } from "../../../ui/overlay/transition"
import {
	Message as EmailMessage,
	type MemberOption,
	type Model as EmailModel,
	visibleIds,
} from "./email-fields"
import type { DestinationForm } from "./form"

// `EmailMemberPicker`'s `MultiSelectCombobox` (packages/ui/src/components/multi-select-combobox.tsx)
// in chips mode: each chip and row shows the member's avatar and name, never the user id.

const IDLE: FieldState = {
	isInvalid: false,
	isDirty: false,
	isFilled: false,
	isFocused: false,
	isTouched: false,
}
const IDS: FieldIds = {
	control: Combobox.inputId("destination-email-members"),
	label: "destination-email-members-label",
	error: "destination-email-members-error",
	description: "destination-email-members-description",
}

type H = HtmlBuilder<Combobox.Message>
type PickerInputs = Readonly<{
	byId: ReadonlyMap<string, MemberOption>
	placeholder: string
	emptyText: string
}>

const avatar = <M>(h: HtmlBuilder<M>, option: MemberOption | undefined): Html =>
	avatarFallback(h, { className: "size-5" }, initialsFrom(option?.label ?? ""))

const chip = (h: H, option: MemberOption | undefined, value: string, isOpen: boolean): Html =>
	h.div(
		[
			h.Key(`chip-${value}`),
			...(isOpen ? [h.AriaHidden(true)] : []),
			h.Class(cn(C.comboboxChipStyles)),
			h.DataAttribute("slot", "combobox-chip"),
			h.Tabindex(-1),
		],
		[
			avatar(h, option),
			h.span(
				[h.Class(C.comboboxChipTextStyles), h.Title(option?.label ?? value)],
				[option?.label ?? value],
			),
			h.button(
				[
					h.AriaDisabled(false),
					h.AriaLabel("Remove"),
					h.Class(C.comboboxChipRemoveStyles),
					h.DataAttribute("slot", "combobox-chip-remove"),
					h.Tabindex(-1),
					h.Type("button"),
					h.OnClick(Combobox.Message.RemovedChip({ value })),
				],
				[icon(h, "XmarkIcon")],
			),
		],
	)

/** `ComboboxChips` with the chips input, and the list popup under them. */
const picker = Submodel.defineView<Combobox.Model, Combobox.Message, PickerInputs>((model, inputs, h) => {
	const isOpen = isMounted(model.isOpen, model.animation)
	const items = visibleIds([...inputs.byId.values()], model.inputValue)
	return h.div(
		[h.Class("contents")],
		[
			h.div(
				[
					h.Key("chips"),
					h.Class(cn(C.comboboxChipsStyles)),
					h.DataAttribute("slot", "combobox-chips"),
					...(model.selected.length === 0 ? [] : [h.Role("toolbar")]),
				],
				[
					...model.selected.map((value) => chip(h, inputs.byId.get(value), value, isOpen)),
					...(isOpen ? [dismissButton(h)] : []),
					h.input([
						h.Class(cn(C.comboboxChipsInputStyles, C.comboboxChipsInputDefaultStyles)),
						h.DataAttribute("size", "default"),
						...inputAttributes(
							h,
							model,
							{
								slot: "combobox-chips-input",
								placeholder: inputs.placeholder,
								items,
								isUnfiltered: true,
							},
							(message) => message,
						),
						h.AriaLabelledBy(IDS.label),
					]),
				],
			),
			hiddenInput(h, model),
			...(isOpen
				? [
						listPopup(h, model, {
							slot: "combobox",
							items,
							// Filtered here: Empty shows only when nothing matched (`not-empty:p-2`).
							emptyText: items.length === 0 ? inputs.emptyText : "",
							isUnfiltered: true,
							anchorSelector: `[data-slot=combobox-chips]:has(> #${Combobox.inputId(model.id)})`,
							renderItem: (value) => {
								const option = inputs.byId.get(value)
								return [
									h.span(
										[h.Class("flex min-w-0 items-center gap-2")],
										[
											avatar(h, option),
											h.span(
												[h.Class("min-w-0 flex-1 truncate")],
												[option?.label ?? value],
											),
											...(option?.meta == null
												? []
												: [
														h.span(
															[
																h.Class(
																	"shrink-0 text-muted-foreground text-xs tabular-nums",
																),
															],
															[option.meta],
														),
													]),
										],
									),
								]
							},
						}),
					]
				: []),
		],
	)
})

type Inputs<M> = Readonly<{
	model: EmailModel
	form: DestinationForm
	toMessage: (message: EmailMessage) => M
}>

export const emailFields = <M>(h: HtmlBuilder<M>, inputs: Inputs<M>): Html => {
	const { model, form } = inputs
	const isTooMany = form.memberUserIds.length > MAX_EMAIL_MEMBER_RECIPIENTS
	const isLoaded = !AsyncData.isLoading(model.members) && !AsyncData.isIdle(model.members)
	const options = AsyncData.getOrElse(model.members, () => [])
	return field(h, { className: "items-stretch gap-1.5", state: IDLE }, [
		fieldLabel(h, { ids: IDS, className: "text-xs", state: IDLE }, "Recipients"),
		h.submodel({
			slotId: model.combobox.id,
			model: model.combobox,
			view: picker,
			toParentMessage: (message) => inputs.toMessage(EmailMessage.GotComboboxMessage({ message })),
			viewInputs: {
				byId: new Map(options.map((option) => [option.userId, option] as const)),
				placeholder: form.memberUserIds.length === 0 ? "Select members…" : "Add member…",
				emptyText: isLoaded ? "No members found in this workspace." : "Loading members…",
			},
		}),
		fieldDescription(
			h,
			{ ids: IDS, className: "text-2xs", state: IDLE },
			`Alert emails go to the selected workspace members (up to ${MAX_EMAIL_MEMBER_RECIPIENTS}).`,
		),
		...(isTooMany
			? [
					fieldError(
						h,
						{ ids: IDS, className: "text-2xs", state: IDLE },
						`Select at most ${MAX_EMAIL_MEMBER_RECIPIENTS} members.`,
					),
				]
			: []),
	])
}
