import { deriveTierIssues, isFilledNumber } from "@maple/web-data/alerts/form-utils"
import { cn } from "@maple/ui/lib/utils"
import { Submodel } from "foldkit"
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { ResolveThemeColors } from "@maple/views/charts/theme-colors"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { skeleton } from "@maple/views/ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { stableSlice } from "../../kit/stable-slice"
import * as DestinationDialogView from "../destination/view"
import { RULE_CHART_TOKENS } from "../shared/rule-chart"
import type { RuleForm } from "./form"
import { Message } from "./message"
import type { Model, Notice } from "./model"
import { isProtectedDefault } from "./derive"
import { actionBar } from "./view-action-bar"
import { conditionFields } from "./view-condition"
import { detailsSection } from "./view-details"
import { liveChartHero } from "./view-hero"
import { noiseSection } from "./view-noise"
import { notificationsSection } from "./view-notifications"
import { querySection } from "./view-query"
import { RULE_FORM_MAX_WIDTH, ruleStep } from "./view-step"
import { templatesOverlay } from "./view-templates"
import { Array as Arr, String as Str } from "effect"

// `AlertCreatePageContent` and `AlertCreateFormSurface`: the rule editor page and its form.

type H = HtmlBuilder<Message>

/** `AlertRuleFormSkeleton`: while the rule (or the draft's inputs) load. */
const formSkeleton = (h: H): Html =>
	h.div(
		[h.Class(cn("mx-auto w-full space-y-4", RULE_FORM_MAX_WIDTH))],
		[
			skeleton(h, "h-64 w-full"),
			h.div(
				[h.Class("grid gap-4 lg:grid-cols-[1.6fr_1fr]")],
				[
					skeleton(h, "h-96 w-full"),
					h.div(
						[h.Class("space-y-4")],
						[skeleton(h, "h-56 w-full"), skeleton(h, "h-40 w-full"), skeleton(h, "h-48 w-full")],
					),
				],
			),
		],
	)

/** `AlertRuleFormLoadError`: the rules stream stopped, so the rule being edited can never load. */
const loadError = (h: H): Html =>
	h.div(
		[h.Class(cn("mx-auto w-full", RULE_FORM_MAX_WIDTH))],
		[
			errorState(h, {
				failure: toLoadFailure(null),
				title: "Couldn't load alert rules",
				message: "Live sync is unavailable.",
				onRetry: Message.ClickedReloadPage(),
				className: "py-12",
			}),
		],
	)

/** A rule this build cannot read: editing it here would save over fields it does not know. */
const unreadableRule = (h: H): Html =>
	h.div(
		[h.Class(cn("mx-auto w-full", RULE_FORM_MAX_WIDTH))],
		[
			errorState(h, {
				failure: toLoadFailure(null),
				title: "This rule needs a newer version of Maple",
				message: "It was saved by a newer version than this tab runs. Reload to edit it.",
				onRetry: Message.ClickedReloadPage(),
				className: "py-12",
			}),
		],
	)

/** `WidgetPrefillNoticeBanner`. */
const noticeBanner = (h: H, notices: ReadonlyArray<Notice>): ReadonlyArray<Html> =>
	notices.length === 0
		? []
		: [
				alert(
					h,
					{
						variant: Arr.some(notices, (notice) => notice.severity === "error") ? "crit" : "warn",
						className: "rounded-md",
					},
					[
						icon(h, "CircleWarningIcon", { size: 14 }),
						alertTitle(h, ["Review chart alert draft"]),
						alertDescription(h, [
							h.div(
								[h.Class("space-y-1")],
								Arr.map(notices, (notice) => h.p([], [notice.message])),
							),
						]),
					],
				),
			]

// `never[]` holds nothing, so sharing one is safe; a fresh `[]` would change the slice every render.
const NONE: Array<never> = []

/**
 * The draft without the fields the evaluator never reads (name, notes, tags, warning destinations,
 * message), kept by reference while the rest is unchanged: the query, condition, noise and chart
 * sections skip those edits. A critical tier's destinations stay, inside `escalation`.
 */
const evaluatedFormOf = stableSlice((form: RuleForm): RuleForm => ({
	...form,
	name: "",
	notes: "",
	tags: NONE,
	destinationIds: NONE,
	notificationTitle: "",
	notificationBody: "",
}))

/** Who gets paged is missing: no destination or escalation chain on a tier that needs one. */
const isNotifyMissingOf = (form: RuleForm, isDefault: boolean): boolean =>
	form.signalType === "anomaly"
		? !isDefault &&
			form.destinationIds.length === 0 &&
			form.escalationChainId === null &&
			(form.escalation?.destinationIds.length ?? 0) === 0 &&
			(form.escalation?.escalationChainId ?? null) === null
		: (form.destinationIds.length === 0 && form.escalationChainId === null) ||
			deriveTierIssues(form).includes("Critical destinations")

const surface = (h: H, model: Model, form: RuleForm, timeZone: string): ReadonlyArray<Html> => {
	const evaluated = evaluatedFormOf(form)
	// An anomaly rule has no condition to tune: the detector decides, so "When to alert" goes.
	const isAnomaly = form.signalType === "anomaly"
	const stepAfterQuery = isAnomaly ? 2 : 3
	return [
		h.div(
			[h.Class(cn("mx-auto w-full space-y-10", RULE_FORM_MAX_WIDTH))],
			[
				...noticeBanner(h, model.notices),
				ruleStep(
					h,
					{
						number: 1,
						hasDivider: false,
						title: "What to watch",
						hint: isAnomaly
							? "Pick which anomalies this rule pages on."
							: "Pick a built-in signal, or build the query like a dashboard widget.",
						status: "done",
					},
					[querySection(h, model, evaluated)],
				),
				...(isAnomaly
					? []
					: [
							ruleStep(
								h,
								{
									number: 2,
									title: "When to alert",
									hint: "The dashed line is your threshold. Shaded bands show when the rule would have fired.",
									status: isFilledNumber(form.threshold) ? "done" : "missing",
								},
								[
									h.div(
										[h.Class("space-y-4")],
										[
											liveChartHero(h, model, form, evaluated, timeZone),
											conditionFields(h, model, evaluated),
											noiseSection(h, model, evaluated),
										],
									),
								],
							),
						]),
				h.div(
					[h.Class("grid grid-cols-1 gap-6 border-t pt-8 lg:grid-cols-2 lg:items-start")],
					[
						ruleStep(
							h,
							{
								number: stepAfterQuery,
								hasDivider: false,
								title: "Who gets notified",
								status: isNotifyMissingOf(form, isProtectedDefault(model))
									? "missing"
									: "done",
							},
							[notificationsSection(h, model, form)],
						),
						ruleStep(
							h,
							{
								number: stepAfterQuery + 1,
								hasDivider: false,
								title: "Name it",
								status: Str.trim(form.name).length === 0 ? "missing" : "done",
							},
							[detailsSection(h, model, form)],
						),
					],
				),
			],
		),
		actionBar(h, model, form),
		templatesOverlay(h, model),
	]
}

const dialogSlot = createLazy()

const destinationDialog = (h: H, dialog: Model["destinationDialog"]): Html =>
	h.submodel({
		slotId: "alert-rule-destination",
		model: dialog,
		view: DestinationDialogView.view,
		viewInputs: { id: "alert-rule-destination" },
		toParentMessage: (message) => Message.GotDestinationDialogMessage({ message }),
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const form = model.form
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: RULE_CHART_TOKENS }))],
		[
			dashboardPage(
				h,
				{},
				form !== null
					? surface(h, model, form, inputs.context.timeZone)
					: [
							model.status === "Failed"
								? loadError(h)
								: model.status === "Unreadable"
									? unreadableRule(h)
									: formSkeleton(h),
						],
			),
			dialogSlot(destinationDialog, [h, model.destinationDialog]),
		],
	)
})

/** `AlertRuleFormShell`'s breadcrumb. */
export const breadcrumbsOf = (model: Model) => [
	{ label: "Alerts", href: "/alerts" },
	{
		label: (model.form === null ? model.search.ruleId !== undefined : model.editingRuleId !== null)
			? "Edit rule"
			: "New rule",
	},
]
