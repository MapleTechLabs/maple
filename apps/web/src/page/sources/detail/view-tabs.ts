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
import { keepsStoredData } from "../kit/integration"
import { platformMeta } from "../kit/platforms"
import { hasToken, pausedLabel } from "../kit/shared"
import { sourceStatusBadge } from "../kit/status"
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

const generalSection = (h: H, form: SettingsForm, source: V2Source, footer?: Html): Html => {
	const nameState = stateOf(form.name, source.name)
	const descriptionState = stateOf(form.description, source.description ?? "")
	const options = { id: "source-settings-general", title: "General" }
	return settingsSection(h, footer === undefined ? options : { ...options, footer }, [
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

const NEW_SOURCE_HREF = hrefOf(AppRoute.SourcesNew({ search: {} }))

/** The default source has no rules of its own: a new source is where limits go. */
const defaultRulesSection = (h: H): Html =>
	settingsSection(
		h,
		{
			id: "source-settings-rules",
			title: "Rules",
			framed: false,
			description: [
				"The default source stands for your organization's ingest keys and has no rules. ",
				h.a([h.Href(NEW_SOURCE_HREF), h.Class(LINK_CLASS)], ["Create a source"]),
				" to limit signals, cap the rate or stamp attributes.",
			],
		},
		[],
	)

/** An integration source: no token, rate limit or signal filter to set, so pausing is its control. */
const ingestionSection = (h: H, model: Model, source: V2Source): Html => {
	const isPaused = source.status === "paused"
	return settingsSection(
		h,
		{
			id: "source-settings-ingestion",
			title: "Ingestion",
			description: [
				"Maple collects this data through the integration, so there is no token, rate limit or signal filter to set. Pause it to stop storing and billing without disconnecting.",
			],
		},
		[
			h.div(
				[h.Class("flex items-center justify-between gap-4")],
				[
					h.div(
						[h.Class("flex min-w-0 flex-col gap-1")],
						[
							sourceStatusBadge(h, source, { nowMs: model.nowMs ?? 0, showTime: false }),
							h.span(
								[h.Class("text-muted-foreground text-xs")],
								[isPaused ? pausedLabel(source) : "Collected and stored as it arrives"],
							),
						],
					),
					isPaused
						? button(
								h,
								{
									variant: "outline",
									size: "sm",
									isLoading: model.busy === "resume",
									attributes: [h.OnClick(Message.ClickedResume())],
								},
								["Resume"],
							)
						: button(
								h,
								{
									variant: "outline",
									size: "sm",
									isLoading: model.busy === "pause",
									attributes: [h.OnClick(Message.ClickedPauseUntilResumed())],
								},
								["Pause"],
							),
				],
			),
		],
	)
}

const deleteSection = (h: H, source: V2Source): Html =>
	settingsSection(h, { id: "source-settings-delete", title: "Delete source" }, [
		h.div(
			[h.Class("flex items-center justify-between gap-6")],
			[
				h.div(
					[h.Class("flex min-w-0 flex-col gap-1")],
					[
						h.span(
							[h.Class("text-sm")],
							[`Disconnects ${platformMeta(source.platform).label} and removes this source.`],
						),
						h.span(
							[h.Class("text-muted-foreground text-xs leading-relaxed")],
							[
								keepsStoredData(source)
									? "Nothing new is collected or billed. Data already stored stays until retention ends."
									: "Nothing new is collected, and its repositories and commits are deleted.",
							],
						),
					],
				),
				button(
					h,
					{
						variant: "destructive-outline",
						size: "sm",
						className: "shrink-0",
						attributes: [h.OnClick(Message.ClickedDelete())],
					},
					["Delete source"],
				),
			],
		),
	])

const saveRow = (h: H, isValid: boolean, isSaving: boolean): Html =>
	h.div(
		[h.Class("flex justify-end")],
		[button(h, { type: "submit", isDisabled: !isValid, isLoading: isSaving }, ["Save changes"])],
	)

/** General for every source; rules for token sources, pausing and deleting for integrations. */
export const settingsTab = (h: H, model: Model, source: V2Source): Html => {
	const form = model.settings
	if (form === null) return h.empty
	const isToken = hasToken(source)
	const isValid = form.name.trim().length > 0 && (!isToken || rulesOutcome(form.rules).valid)
	const save = saveRow(h, isValid, form.isSaving)
	// Token sources save the rules too, so their Save closes the form; the rest save General alone.
	const sections: ReadonlyArray<Html> = isToken
		? [
				generalSection(h, form, source),
				settingsSection(
					h,
					{
						id: "source-settings-rules",
						title: "Rules",
						description: ["Applied by the ingest gateway to everything this source sends."],
					},
					[
						RulesView.view(h, {
							model: form.rules,
							toParentMessage: (message) => Message.GotRulesMessage({ message }),
							idPrefix: "source-settings-rules",
							nowMs: model.nowMs ?? 0,
						}),
					],
				),
				save,
			]
		: [
				generalSection(h, form, source, save),
				...(source.is_default
					? [defaultRulesSection(h)]
					: [ingestionSection(h, model, source), deleteSection(h, source)]),
			]
	return h.form(
		[h.Class("max-w-4xl"), h.OnSubmit(Message.SubmittedSettings())],
		[settingsSections(h, sections)],
	)
}
