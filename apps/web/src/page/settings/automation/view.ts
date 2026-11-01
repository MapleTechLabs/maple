import type { AlertDestinationDocument, IssueSeverity } from "@maple/domain/http"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { button, linkButton } from "../../../ui/button"
import { emptyMessage } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { field, fieldLabel, type FieldState } from "../../../ui/field"
import { listRow } from "../../../ui/list-row"
import { nativeOption, nativeSelect } from "../../../ui/native-select"
import { panel } from "../../../ui/panel"
import { multiSegmentedSelect } from "../../../ui/segmented-select"
import * as SelectView from "../../../ui/select-view"
import { settingRow } from "../../../ui/setting-row"
import { skeleton, skeletonList, skeletonSlowNote } from "../../../ui/skeleton"
import { switchControl } from "../../../ui/switch"
import { providerLogo, providerOf } from "../../alerts/shared/providers"
import { SEVERITY_LABEL, SEVERITY_ORDER, severityBadge, severityDot } from "../../errors/kit/severity"
import { relativeTime } from "../../kit/relative-time"
import { docsLink } from "../../kit/signal-empty-state"
import { adminOnlyNote, settingsSection, settingsSections } from "../kit/section"
import { Message, type Model, type PolicyDraft } from "./model"

type H = HtmlBuilder<Message>
type Inputs = Readonly<{ nowMs: number; timeZone: string; isKnownMember: boolean }>

const IDLE: FieldState = {
	isInvalid: false,
	isDirty: false,
	isFilled: false,
	isFocused: false,
	isTouched: false,
}
const CONFIDENCE_ITEMS = [
	{ value: "any", label: "Any" },
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
] as const

const destinationOptions = (h: H, model: Model, destinations: ReadonlyArray<AlertDestinationDocument>) =>
	destinations.map((destination) => ({
		value: destination.id,
		ariaLabel: destination.id,
		icon: providerLogo(h, {
			type: destination.type,
			size: 24,
			isBare: true,
			isLogoBroken: model.brokenLogos.includes(destination.type),
			onLogoError: Message.FailedLoadProviderLogo({ type: destination.type }),
		}),
		label: h.span(
			[h.Class("flex items-center gap-2")],
			[
				h.span([h.Class("font-medium")], [destination.name]),
				h.span([h.Class("text-muted-foreground text-xs")], [providerOf(destination.type).label]),
			],
		),
	}))

const severityRule = (
	h: H,
	model: Model,
	draft: PolicyDraft,
	severity: IssueSeverity,
	destinations: ReadonlyArray<AlertDestinationDocument>,
): Html => {
	const isLocked = !model.isAdmin || model.isSaving
	const select = model.confidenceSelects[severity]
	return h.div(
		[h.Key(severity), h.Class("space-y-2 border-t border-border-subtle pt-3")],
		[
			h.div(
				[h.Class("flex items-center justify-between gap-3")],
				[
					severityBadge(h, severity),
					h.div(
						[h.Class("flex items-center gap-2")],
						[
							h.span([h.Class("text-muted-foreground text-2xs")], ["Min. AI confidence"]),
							select === undefined
								? h.empty
								: h.submodel({
										slotId: `escalation-confidence-${severity}`,
										model: { ...select, value: draft[severity].minConfidence },
										view: SelectView.view,
										toParentMessage: (message) =>
											Message.GotConfidenceSelectMessage({ severity, message }),
										viewInputs: {
											entries: CONFIDENCE_ITEMS.map((item): SelectView.SelectEntry => ({
												_tag: "Item",
												item,
											})),
											size: "sm",
											className: "w-24",
											// `<SelectValue />` without a renderer prints the raw value.
											renderValue: (value) => [value],
											toView: (parts) => h.div([h.Class("contents")], parts),
										},
									}),
						],
					),
				],
			),
			multiSegmentedSelect(h, {
				options: destinationOptions(h, model, destinations),
				value: draft[severity].destinationIds,
				onToggle: (destinationId) => Message.ToggledDestination({ severity, destinationId }),
				isDisabled: isLocked,
				ariaLabel: `Destinations for ${severity} severity`,
				size: "sm",
			}),
		],
	)
}

const policySkeleton = (h: H): Html =>
	h.div([h.Class("space-y-2")], [skeleton(h, "h-40 w-full rounded-md"), skeletonSlowNote(h)])

const destinationsBlock = (h: H, model: Model, draft: PolicyDraft): Html => {
	const destinations = model.destinations
	if (destinations === null)
		return h.div([h.Class("space-y-2")], [skeleton(h, "h-24 w-full"), skeletonSlowNote(h)])
	if (destinations.length === 0)
		return h.div(
			[h.Class("space-y-3")],
			[
				h.p(
					[h.Class("text-muted-foreground text-sm")],
					[
						"Escalation sends triaged issues to a destination. Add a Slack, email or webhook destination first.",
					],
				),
				h.div(
					[h.Class("flex flex-wrap items-center gap-x-4 gap-y-2")],
					[
						linkButton(h, { size: "sm", variant: "outline", href: "/alerts?tab=routing" }, [
							"Add a destination",
						]),
						docsLink(h, "destinations"),
					],
				),
			],
		)
	return h.div(
		[h.Class("space-y-4")],
		SEVERITY_ORDER.map((severity) => severityRule(h, model, draft, severity, destinations)),
	)
}

const policyForm = (h: H, model: Model, draft: PolicyDraft, isKnownMember: boolean): Html =>
	h.div(
		[h.Class("space-y-4")],
		[
			panel(h, { padded: true, className: "gap-4" }, [
				settingRow(h, {
					ids: {
						control: "escalation-enabled-input",
						label: "escalation-enabled-label",
						description: "escalation-enabled-description",
					},
					label: "Severity escalation",
					description:
						"Route issues to destinations when AI triage or a teammate sets their severity. Fires once per issue and severity level, upward only.",
					filled: draft.enabled,
					disabled: !model.isAdmin || model.isSaving,
					control: switchControl(h, {
						id: "escalation-enabled",
						inputId: "escalation-enabled-input",
						isChecked: draft.enabled,
						isDisabled: !model.isAdmin || model.isSaving,
						labelledBy: "escalation-enabled-label",
						describedBy: "escalation-enabled-description",
						isFilled: draft.enabled,
						onToggle: Message.ToggledEnabled(),
					}),
				}),
				destinationsBlock(h, model, draft),
				h.div(
					[h.Class("flex justify-end border-t border-border-subtle pt-3")],
					[
						button(
							h,
							{
								size: "sm",
								isLoading: model.isSaving,
								isDisabled: !model.isAdmin,
								attributes: [h.OnClick(Message.ClickedSavePolicy())],
							},
							["Save policy"],
						),
					],
				),
			]),
			...(model.isAdmin || !isKnownMember
				? []
				: [adminOnlyNote(h, ["Only org admins can change the escalation policy."])]),
		],
	)

const policySection = (h: H, model: Model, isKnownMember: boolean): Html =>
	settingsSection(
		h,
		{
			id: "automation-policy-heading",
			title: "Severity and confidence routing",
			description: [
				"Confidence gates apply only to AI decisions. A manual severity change is explicit human intent and bypasses the confidence threshold.",
			],
			framed: false,
		},
		[
			model.draft !== null
				? policyForm(h, model, model.draft, isKnownMember)
				: h.div(
						[],
						[
							AsyncData.matchData(model.policy, {
								onEmpty: () => policySkeleton(h),
								onData: () => policySkeleton(h),
								onFailure: (failure) =>
									errorState(h, {
										failure,
										title: "Couldn't load the escalation policy",
										variant: "row",
										onRetry: Message.ClickedRetryPolicy(),
									}),
							}),
						],
					),
		],
	)

const simulatorField = (h: H, name: string, label: string, control: Html): Html =>
	field(h, { state: IDLE }, [
		fieldLabel(
			h,
			{
				ids: {
					control: `simulator-${name}`,
					label: `simulator-${name}-label`,
					error: `simulator-${name}-error`,
				},
				state: IDLE,
			},
			label,
		),
		control,
	])

const decisionText = (h: H, model: Model): ReadonlyArray<Html | string> => {
	if (model.draft === null)
		return [
			h.span(
				[h.Class("font-prose text-sm text-muted-foreground")],
				[
					AsyncData.isFailure(model.policy)
						? "The simulator needs the escalation policy, which didn't load."
						: "The simulator is available once the escalation policy loads.",
				],
			),
		]
	if (model.isDirty)
		return [
			h.span(
				[h.Class("font-prose text-sm text-muted-foreground")],
				["Save the policy above to simulate it. The simulator evaluates the saved policy."],
			),
		]
	const evaluated =
		model.evaluated !== null && model.evaluated.revision === model.revision
			? model.evaluated.decision
			: null
	if (evaluated === null)
		return [
			h.span(
				[h.Class("font-prose text-sm text-muted-foreground")],
				["Preview the worker's decision under the saved policy without sending a notification."],
			),
		]
	const destinations = model.destinations ?? []
	return [
		badge(h, { variant: "outline", className: "capitalize" }, [evaluated.outcome]),
		h.span(
			[h.Class("text-sm text-muted-foreground")],
			[
				evaluated.outcome === "route"
					? evaluated.destinationIds
							.map(
								(id) => destinations.find((destination) => destination.id === id)?.name ?? id,
							)
							.join(", ")
					: (evaluated.skipReason?.replaceAll("_", " ") ?? ""),
			],
		),
	]
}

const simulator = (h: H, model: Model): Html => {
	// Without a loaded policy nothing can be evaluated, so the inputs wait with the button.
	const isWaiting = model.draft === null
	return settingsSection(h, { id: "automation-simulator-heading", title: "Policy simulator" }, [
		h.div(
			[h.Class("grid gap-4 md:grid-cols-3")],
			[
				h.submodel({
					slotId: "simulator-severity",
					model: model.severitySelect,
					view: SelectView.view,
					toParentMessage: (message) => Message.GotSeveritySelectMessage({ message }),
					viewInputs: {
						entries: SEVERITY_ORDER.map((severity): SelectView.SelectEntry => ({
							_tag: "Item",
							item: { value: severity, label: SEVERITY_LABEL[severity] },
						})),
						ariaLabel: "Severity",
						className: "h-8 w-full",
						isDisabled: isWaiting,
						renderValue: (value) => {
							const severity = SEVERITY_ORDER.find((entry) => entry === value) ?? null
							return [
								h.span(
									[h.Class("flex items-center gap-2")],
									[
										severityDot(h, severity),
										severity === null ? "Not set" : SEVERITY_LABEL[severity],
									],
								),
							]
						},
						renderItem: (option) => {
							const severity = SEVERITY_ORDER.find((entry) => entry === option.value) ?? null
							return [
								h.span(
									[h.Class("flex items-center gap-2")],
									[severityDot(h, severity), option.label],
								),
							]
						},
						toView: (parts) =>
							simulatorField(h, "severity", "Severity", h.div([h.Class("contents")], parts)),
					},
				}),
				simulatorField(
					h,
					"source",
					"Decision source",
					nativeSelect(
						h,
						{
							className: "w-full [&>select]:text-sm",
							defaultValue: model.source,
							isDisabled: isWaiting,
							attributes: [h.OnChange((value) => Message.ChangedSource({ value }))],
						},
						[nativeOption("ai", "AI diagnosis"), nativeOption("manual", "Manual change")],
					),
				),
				simulatorField(
					h,
					"confidence",
					"AI confidence",
					nativeSelect(
						h,
						{
							className: "w-full [&>select]:text-sm",
							defaultValue: model.confidence,
							isDisabled: isWaiting || model.source === "manual",
							attributes: [h.OnChange((value) => Message.ChangedConfidence({ value }))],
						},
						[
							nativeOption("high", "High"),
							nativeOption("medium", "Medium"),
							nativeOption("low", "Low"),
						],
					),
				),
			],
		),
		h.div(
			[h.Class("mt-4 flex flex-wrap items-center gap-3 border-t pt-4")],
			[
				button(
					h,
					{
						variant: "outline",
						size: "sm",
						isLoading: model.isEvaluating,
						isDisabled: model.isDirty || model.draft === null,
						attributes: [h.OnClick(Message.ClickedEvaluate())],
					},
					["Evaluate policy"],
				),
				...decisionText(h, model),
			],
		),
	])
}

const recentDeliveries = (h: H, model: Model, inputs: Inputs): Html =>
	settingsSection(
		h,
		{
			id: "automation-recent-heading",
			title: "Recent escalation deliveries",
			padded: false,
			// A failed read is the bare dashed row, like the policy's above.
			framed: !AsyncData.isFailure(model.attempts),
		},
		[
			AsyncData.matchData(model.attempts, {
				onEmpty: () =>
					h.div(
						[],
						[
							skeletonList(h, { rows: 3, rowClassName: "h-10", gap: "2", className: "p-4" }),
							skeletonSlowNote(h, "px-4 pb-3"),
						],
					),
				onFailure: (failure) =>
					errorState(h, {
						failure,
						title: "Couldn't load recent deliveries",
						variant: "row",
						onRetry: Message.ClickedRetryAttempts(),
					}),
				onData: (response) =>
					response.attempts.length === 0
						? emptyMessage(h, {}, ["No escalation attempts have been recorded"])
						: h.div(
								[],
								response.attempts.map((attempt) =>
									listRow(h, {
										divided: true,
										leading: h.span(
											[h.Class("flex w-32 items-center gap-2")],
											[
												severityBadge(h, attempt.severity),
												h.span([h.Class("capitalize")], [attempt.status]),
											],
										),
										title: h.span(
											[h.Class("font-normal text-muted-foreground")],
											[
												attempt.deliveries.length > 0
													? attempt.deliveries
															.map(
																(delivery) =>
																	`${delivery.destinationName ?? delivery.destinationId}: ${delivery.status}`,
															)
															.join(", ")
													: (attempt.skipReason?.replaceAll("_", " ") ??
														"Awaiting delivery"),
											],
										),
										trailing: relativeTime(h, {
											value: attempt.createdAt,
											nowMs: inputs.nowMs,
											timeZone: inputs.timeZone,
											className: "text-xs text-muted-foreground",
										}),
									}),
								),
							),
			}),
		],
	)

export const view = Submodel.defineView<Model, Message, Inputs>((model, inputs, h) =>
	settingsSections(h, [
		policySection(h, model, inputs.isKnownMember),
		simulator(h, model),
		recentDeliveries(h, model, inputs),
	]),
)
