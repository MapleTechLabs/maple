import type { V2Source } from "@maple/domain/http/v2"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button } from "../../../ui/button"
import { type FieldIds, type FieldState, field, fieldLabel, input } from "../../../ui/field"
import { textarea } from "../../../ui/textarea"
import { settingsSection, settingsSections } from "../../settings/kit/section"
import { rulesOutcome } from "../kit/rules"
import * as RulesView from "../kit/rules-view"
import * as Setup from "../kit/setup"
import { hasToken } from "../kit/shared"
import { Message } from "./message"
import type { Model, RevealedToken, SettingsForm } from "./model"

// `SourceSetupTab` and `SourceSettings`.

type H = HtmlBuilder<Message>

const LINK_CLASS = "text-foreground underline underline-offset-2"
const INGESTION_HREF = hrefOf(AppRoute.Settings({ search: { tab: "ingestion" } }))

const note = (h: H, children: ReadonlyArray<Html | string>) =>
	h.p([h.Class("text-muted-foreground text-sm")], children)

export const setupTab = (h: H, model: Model, source: V2Source, revealed: RevealedToken | null): Html => {
	if (source.is_default)
		return note(h, [
			"The default source receives everything sent with your organization's ingest keys. Setup steps are on the ",
			h.a([h.Href(INGESTION_HREF), h.Class(LINK_CLASS)], ["Ingestion"]),
			" page.",
		])
	return h.div(
		[h.Class("max-w-3xl")],
		model.setup === null
			? []
			: [
					Setup.view(h, {
						model: model.setup,
						toParentMessage: (message) => Message.GotSetupMessage({ message }),
						platform: source.platform,
						name: source.name,
						token: revealed?.secret ?? null,
						keyPrefix: source.key_prefix,
						idPrefix: "source-setup",
					}),
				],
	)
}

const NAME_IDS: FieldIds = {
	control: "source-settings-name",
	label: "source-settings-name-label",
	error: "source-settings-name-error",
}
const DESCRIPTION_IDS: FieldIds = {
	control: "source-settings-description",
	label: "source-settings-description-label",
	error: "source-settings-description-error",
}

const stateOf = (value: string, initial: string): FieldState => ({
	isInvalid: false,
	isDirty: value !== initial,
	isFilled: value !== "",
	isFocused: false,
	isTouched: false,
})

const generalSection = (h: H, form: SettingsForm, source: V2Source): Html => {
	const nameState = stateOf(form.name, source.name)
	const descriptionState = stateOf(form.description, source.description ?? "")
	return settingsSection(h, { id: "source-settings-general", title: "General" }, [
		h.div(
			[h.Class("flex flex-col gap-4")],
			[
				field(h, { state: nameState }, [
					fieldLabel(h, { ids: NAME_IDS, state: nameState }, "Name"),
					input(h, {
						ids: NAME_IDS,
						state: nameState,
						attributes: [
							h.Value(form.name),
							h.Attribute("maxlength", "100"),
							h.OnInput((value) => Message.ChangedSettingsName({ value })),
						],
					}),
				]),
				field(h, { state: descriptionState }, [
					fieldLabel(h, { ids: DESCRIPTION_IDS, state: descriptionState }, [
						"Description",
						" ",
						h.span([h.Class("text-muted-foreground font-normal")], ["(optional)"]),
					]),
					textarea(h, {
						id: DESCRIPTION_IDS.control,
						attributes: [
							h.Value(form.description),
							h.Attribute("maxlength", "500"),
							h.OnInput((value) => Message.ChangedSettingsDescription({ value })),
						],
					}),
				]),
			],
		),
	])
}

const rulesDescription = (source: V2Source): string =>
	source.is_default
		? "The default source stands for your organization's ingest keys and has no rules. Create a source to limit signals, cap the rate or stamp attributes."
		: hasToken(source)
			? "Applied by the ingest gateway to everything this source sends."
			: "Integrations are collected by Maple and take no rules."

export const settingsTab = (h: H, model: Model, source: V2Source): Html => {
	const form = model.settings
	if (form === null) return h.empty
	const isToken = hasToken(source)
	const isValid = form.name.trim().length > 0 && (!isToken || rulesOutcome(form.rules).valid)
	return h.form(
		[h.OnSubmit(Message.SubmittedSettings())],
		[
			settingsSections(h, "standard", [
				generalSection(h, form, source),
				settingsSection(
					h,
					{ id: "source-settings-rules", title: "Rules", description: [rulesDescription(source)] },
					[
						RulesView.view(h, {
							model: form.rules,
							toParentMessage: (message) => Message.GotRulesMessage({ message }),
							idPrefix: "source-settings-rules",
							nowMs: model.nowMs ?? 0,
							isDisabled: !isToken,
						}),
					],
				),
				h.div(
					[h.Class("flex justify-end")],
					[
						button(h, { type: "submit", isDisabled: !isValid, isLoading: form.isSaving }, [
							"Save changes",
						]),
					],
				),
			]),
		],
	)
}
