import { MAX_EMAIL_MEMBER_RECIPIENTS } from "@maple/web-data/alerts/form-utils"
import { initialsFrom } from "@maple/ui/lib/initials"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Combobox from "../../../ui/combobox"
import { chipsView } from "../../../ui/combobox-view"
import { avatarFallback } from "../../../ui/display"
import { field, fieldDescription, fieldError, type FieldIds, fieldLabel } from "../../../ui/field"
import type { FieldState } from "../../../ui/input"
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

const avatar = <M>(h: HtmlBuilder<M>, option: MemberOption | undefined): Html =>
	avatarFallback(h, { className: "size-5" }, initialsFrom(option?.label ?? ""))

const memberItem = (h: H, option: MemberOption | undefined, value: string): ReadonlyArray<Html> => [
	h.span(
		[h.Class("flex min-w-0 items-center gap-2")],
		[
			avatar(h, option),
			h.span([h.Class("min-w-0 flex-1 truncate")], [option?.label ?? value]),
			...(option?.meta == null
				? []
				: [h.span([h.Class("shrink-0 text-muted-foreground text-xs tabular-nums")], [option.meta])]),
		],
	),
]

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
	const byId = new Map(options.map((option) => [option.userId, option] as const))
	const items = visibleIds(options, model.combobox.inputValue)
	return field(h, { className: "items-stretch gap-1.5", state: IDLE }, [
		fieldLabel(h, { ids: IDS, className: "text-xs", state: IDLE }, "Recipients"),
		h.submodel({
			slotId: model.combobox.id,
			model: model.combobox,
			view: chipsView,
			toParentMessage: (message) => inputs.toMessage(EmailMessage.GotComboboxMessage({ message })),
			viewInputs: {
				items,
				ariaLabelledBy: IDS.label,
				placeholder: form.memberUserIds.length === 0 ? "Select members…" : "Add member…",
				// Filtered here: Empty shows only when nothing matched (`not-empty:p-2`).
				emptyText:
					items.length === 0
						? isLoaded
							? "No members found in this workspace"
							: "Loading members…"
						: "",
				isUnfiltered: true,
				chipLeading: (ch, value) => avatar(ch, byId.get(value)),
				chipLabel: (value) => byId.get(value)?.label ?? value,
				renderItem: (ch, value) => memberItem(ch, byId.get(value), value),
				toView: (parts) => h.div([h.Class("contents")], parts),
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
