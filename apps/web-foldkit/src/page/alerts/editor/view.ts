import { deriveTierIssues, isFilledNumber } from "@maple/web-data/alerts/form-utils"
import { diffRuleForms } from "@maple/web-data/alerts/preview-insights"
import { cn } from "@maple/ui/lib/utils"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ResolveThemeColors } from "../../../charts/theme-colors"
import { alert, alertDescription, alertTitle } from "../../../ui/alert"
import { icon } from "../../../ui/icon"
import { skeleton } from "../../../ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import * as DestinationDialogView from "../destination/view"
import { RULE_CHART_TOKENS } from "../shared/rule-chart"
import type { RuleForm } from "./form"
import { Message } from "./message"
import type { Model, Notice } from "./model"
import { actionBar } from "./view-action-bar"
import { conditionFields } from "./view-condition"
import { detailsSection } from "./view-details"
import { liveChartHero } from "./view-hero"
import { noiseSection } from "./view-noise"
import { notificationsSection } from "./view-notifications"
import { querySection } from "./view-query"
import { RULE_FORM_MAX_WIDTH, ruleStep } from "./view-step"
import { templatesOverlay } from "./view-templates"

// `AlertCreatePageContent` and `AlertCreateFormSurface` (components/alerts/alert-create-page-content.tsx,
// alert-create-form-surface.tsx).

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

/** `WidgetPrefillNoticeBanner`. */
const noticeBanner = (h: H, notices: ReadonlyArray<Notice>): ReadonlyArray<Html> =>
	notices.length === 0
		? []
		: [
				alert(h, { variant: notices.some((notice) => notice.severity === "error") ? "crit" : "warn", className: "rounded-md" }, [
					icon(h, "CircleWarningIcon", { size: 14 }),
					alertTitle(h, ["Review chart alert draft"]),
					alertDescription(h, [h.div([h.Class("space-y-1")], notices.map((notice) => h.p([], [notice.message])))]),
				]),
			]

const surface = (h: H, model: Model, form: RuleForm, timeZone: string): ReadonlyArray<Html> => {
	const changes = model.savedForm === null ? null : diffRuleForms(model.savedForm, form).length
	const isNotifyMissing = form.destinationIds.length === 0 || deriveTierIssues(form).includes("Critical destinations")
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
						hint: "Pick a built-in signal, or build the query like a dashboard widget.",
						status: "done",
					},
					[querySection(h, model, form)],
				),
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
							[liveChartHero(h, model, form, timeZone), conditionFields(h, model, form), noiseSection(h, model, form)],
						),
					],
				),
				h.div(
					[h.Class("grid gap-6 border-t pt-8 lg:grid-cols-2 lg:items-start")],
					[
						ruleStep(
							h,
							{ number: 3, hasDivider: false, title: "Who gets notified", status: isNotifyMissing ? "missing" : "done" },
							[notificationsSection(h, model, form)],
						),
						ruleStep(
							h,
							{
								number: 4,
								hasDivider: false,
								title: "Name it",
								status: form.name.trim().length === 0 ? "missing" : "done",
							},
							[detailsSection(h, model, form)],
						),
					],
				),
			],
		),
		actionBar(h, model, form, changes),
		templatesOverlay(h, model),
	]
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const form = model.form
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: RULE_CHART_TOKENS }))],
		[
			dashboardPage(h, {}, form === null ? [formSkeleton(h)] : surface(h, model, form, inputs.context.timeZone)),
			h.submodel({
				slotId: "alert-rule-destination",
				model: model.destinationDialog,
				view: DestinationDialogView.view,
				viewInputs: { id: "alert-rule-destination" },
				toParentMessage: (message) => Message.GotDestinationDialogMessage({ message }),
			}),
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
