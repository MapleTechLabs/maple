import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../../ui/button"
import { chipsView } from "../../../../ui/combobox-view"
import { errorState } from "../../../../ui/error-state"
import { field, fieldDescription, fieldLabel, type FieldState } from "../../../../ui/field"
import { icon } from "../../../../ui/icon"
import { nativeOption, nativeSelect } from "../../../../ui/native-select"
import { panel } from "../../../../ui/panel"
import { accountSectionSkeleton } from "../../kit/account-skeleton"
import { saveBar } from "../../kit/save-bar"
import { settingsSection, settingsSections } from "../../kit/section"
import { switchRow } from "../../kit/switch-row"
import { fieldIds } from "../fields"
import { Message, type Model } from "./model"
import {
	DIGEST_DAYS,
	DIGEST_HOURS,
	digestTimeZoneOptions,
	draftOf,
	isBusy,
	isDraftDirty,
	isOpsEnabled,
	isWebEnabled,
} from "./update"

type H = HtmlBuilder<Message>

const IDLE: FieldState = { isInvalid: false, isDirty: false, isFilled: false, isFocused: false, isTouched: false }

const previewButton = (h: H, model: Model, digest: "ops" | "web"): Html =>
	button(
		h,
		{
			variant: "outline",
			size: "sm",
			className: "w-fit",
			isLoading: model.previewing === digest,
			isDisabled: isBusy(model),
			attributes: [h.OnClick(Message.ClickedPreview({ digest }))],
		},
		["Preview"],
	)

/** "Every <day> at <hour> <zone>", on the subscriber's own clock. */
const scheduleField = (h: H, model: Model): Html => {
	const draft = draftOf(model)
	const zones = digestTimeZoneOptions(model.supportedZones, draft.timezone, model.browserZone)
	const ids = { ...fieldIds("digest-day"), description: "digest-day-description" }
	return field(h, { state: IDLE }, [
		fieldLabel(h, { ids, state: IDLE }, "Schedule"),
		h.div(
			[h.Class("flex flex-wrap items-center gap-2 text-sm text-muted-foreground")],
			[
				h.span([], ["Every"]),
				nativeSelect(
					h,
					{
						className: "w-32",
						defaultValue: String(draft.dayOfWeek),
						isDisabled: model.isSaving,
						attributes: [
							h.Id("digest-day"),
							h.AriaLabel("Day"),
							h.OnChange((value) => Message.ChangedSchedule({ field: "dayOfWeek", value })),
						],
					},
					DIGEST_DAYS.map((day) => nativeOption(String(day.value), day.label)),
				),
				h.span([], ["at"]),
				nativeSelect(
					h,
					{
						className: "w-24",
						defaultValue: String(draft.sendHour),
						isDisabled: model.isSaving,
						attributes: [
							h.AriaLabel("Time"),
							h.OnChange((value) => Message.ChangedSchedule({ field: "sendHour", value })),
						],
					},
					DIGEST_HOURS.map((hour) => nativeOption(String(hour.value), hour.label)),
				),
				nativeSelect(
					h,
					{
						className: "w-48",
						defaultValue: draft.timezone,
						isDisabled: model.isSaving,
						attributes: [
							h.AriaLabel("Time zone"),
							h.OnChange((value) => Message.ChangedSchedule({ field: "timezone", value })),
						],
					},
					zones.map((zone) => nativeOption(zone, zone)),
				),
			],
		),
		fieldDescription(h, { ids, state: IDLE }, "Sent in your time zone. Both digests follow this schedule."),
		h.p(
			[h.Class("text-xs text-muted-foreground")],
			["Changes apply from the next send, so moving the day right after a digest went out skips to next week."],
		),
	])
}

const scopeField = (
	h: H,
	model: Model,
	options: Readonly<{ key: "namespaces" | "environments"; label: string; noun: string; plural: string }>,
): Html => {
	const draft = draftOf(model)
	const values = draft[options.key]
	const box = options.key === "namespaces" ? model.namespacesBox : model.environmentsBox
	const ids = {
		control: `digest-${options.key}-input`,
		label: `digest-${options.key}-label`,
		error: `digest-${options.key}-error`,
		description: `digest-${options.key}-description`,
	}
	const state: FieldState = { ...IDLE, isFilled: values.length > 0 }
	return field(h, { state }, [
		fieldLabel(h, { ids, state }, options.label),
		h.submodel({
			slotId: `digest-${options.key}`,
			model: { ...box, selected: values },
			view: chipsView,
			toParentMessage: (message) =>
				options.key === "namespaces"
					? Message.GotNamespacesMessage({ message })
					: Message.GotEnvironmentsMessage({ message }),
			viewInputs: {
				items: model.facets[options.key],
				ariaLabelledBy: ids.label,
				ariaDescribedBy: ids.description,
				placeholder: values.length === 0 ? `All ${options.plural}` : `Add ${options.noun}...`,
				emptyText: `No ${options.plural} detected.`,
				toView: (parts) => h.div([h.Class("sm:max-w-xs")], parts),
			},
		}),
		fieldDescription(h, { ids, state }, `Leave empty to cover every ${options.noun}.`),
	])
}

const preferences = (h: H, model: Model): ReadonlyArray<Html> => {
	const enabled = isOpsEnabled(model)
	const webEnabled = isWebEnabled(model)
	const busy = isBusy(model)
	return [
		panel(h, { className: "divide-y" }, [
			switchRow(
				h,
				{
					id: "digest-ops",
					className: "p-4",
					icon: icon(h, "EnvelopeIcon", { size: 18, className: "text-muted-foreground" }),
					label: "Weekly ops digest",
					description: "Errors, latency, alerts and ingest volume for the past week.",
					isChecked: enabled,
					isDisabled: busy || model.email === null,
					onToggle: Message.ToggledOps(),
				},
				enabled
					? [
							panel(h, { tone: "muted", padded: true, className: "gap-4" }, [
								scheduleField(h, model),
								scopeField(h, model, { key: "namespaces", label: "Namespaces", noun: "namespace", plural: "namespaces" }),
								scopeField(h, model, {
									key: "environments",
									label: "Environments",
									noun: "environment",
									plural: "environments",
								}),
								previewButton(h, model, "ops"),
							]),
						]
					: [],
			),
			// Both digests share one schedule; it sits here only while the ops digest is off.
			switchRow(
				h,
				{
					id: "digest-web",
					className: "p-4",
					icon: icon(h, "ChartBarTrendUpIcon", { size: 18, className: "text-muted-foreground" }),
					label: "Web analytics digest",
					description:
						"Weekly overview of visitors, top pages and AI traffic. Only sent once the browser SDK is reporting visits.",
					isChecked: webEnabled,
					isDisabled: busy || model.email === null,
					onToggle: Message.ToggledWeb(),
					before: [previewButton(h, model, "web")],
				},
				!enabled && webEnabled ? [panel(h, { tone: "muted", padded: true }, [scheduleField(h, model)])] : [],
			),
		]),
		...saveBar(h, {
			isDirty: isDraftDirty(model),
			isPending: model.isSaving,
			onDiscard: Message.ClickedDiscard(),
			onSave: Message.ClickedSave(),
		}),
	]
}

const recipient = (h: H, model: Model): ReadonlyArray<Html | string> =>
	model.email === null
		? ["Add a primary email address to receive digests."]
		: [
				"Sent to ",
				h.span([h.Class("text-foreground")], [model.email]),
				...(model.orgName === null ? [] : [` for ${model.orgName}`]),
			]

export const view = Submodel.defineView<Model, Message, Readonly<Record<never, never>>>((model, _inputs, h) => {
	if (!model.isLoaded || AsyncData.isLoading(model.subscription) || AsyncData.isIdle(model.subscription))
		return accountSectionSkeleton(h)
	return settingsSections(h, "standard", [
		settingsSection(
			h,
			{ id: "account-email-preferences", title: "Email preferences", description: recipient(h, model), framed: false },
			[
				// Switches built on defaults would upsert over preferences that could not be read.
				...AsyncData.matchDataSplitEmpty(model.subscription, {
					onIdle: () => [],
					onLoading: () => [],
					onFailure: (failure) => [
						errorState(h, {
							variant: "row",
							failure,
							title: "Couldn't load your email preferences",
							onRetry: Message.ClickedRetry(),
						}),
					],
					onData: () => preferences(h, model),
				}),
				h.p([h.Class("text-xs text-muted-foreground")], ["Unsubscribe links in each email turn the matching digest off."]),
			],
		),
	])
})
