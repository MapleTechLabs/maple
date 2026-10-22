import { diffRuleForms } from "@maple/web-data/alerts/preview-insights"
import { cn } from "@maple/ui/lib/utils"
import { Struct } from "effect"
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "../../../ui/button"
import { icon } from "../../../ui/icon"
import * as Tooltip from "../../../ui/tooltip"
import { stableSlice } from "../../kit/stable-slice"
import { alertsHref } from "../shared/links"
import type { AlertQueryTiming } from "@maple/domain/http"
import { describeRuleCondition, saveIssues } from "./derive"
import { draftTimingOf } from "./derive-rows"
import type { RuleForm } from "./form"
import { Message } from "./message"
import type { Model } from "./model"
import { RULE_FORM_MAX_WIDTH } from "./view-step"

// `RuleActionBar`: the sticky bar with the rule in one
// sentence, what is still missing, and Cancel / Save.

type H = HtmlBuilder<Message>

const MAX_VISIBLE_ISSUES = 3

/** What the bar reads off the Model. */
type BarView = Pick<Model, "issuesTooltip" | "isSaving" | "editingRuleId" | "savedForm">

/** The "details" trigger and its tooltip: every issue, one per line. */
const issuesDetails = (h: H, model: BarView, issues: ReadonlyArray<string>): Html =>
	h.submodel({
		slotId: "alert-rule-issues-tooltip",
		model: model.issuesTooltip,
		view: Tooltip.view,
		toParentMessage: (message: Tooltip.Message) => Message.GotIssuesTooltipMessage({ message }),
		viewInputs: {
			toContent: () => [
				h.ul([h.Class("space-y-0.5 text-xs")], issues.map((issue) => h.li([h.Key(issue)], [`• ${issue}`]))),
			],
			toView: ({ trigger, portal }) =>
				h.span(
					[h.Class("contents")],
					[
						button(
							h,
							{
								variant: "link",
								size: "xs",
								className: "text-muted-foreground underline decoration-dotted hover:text-foreground",
								attributes: trigger(),
							},
							["details"],
						),
						...(portal === null ? [] : [portal]),
					],
				),
		},
	})

/** `ValidationSummary`. */
const validationSummary = (h: H, model: BarView, issues: ReadonlyArray<string>): Html => {
	if (issues.length === 0)
		return h.span(
			[h.Class("flex items-center gap-1.5 text-xs text-severity-info")],
			[icon(h, "CheckIcon", { size: 14 }), "Ready to save"],
		)
	const visible = issues.slice(0, MAX_VISIBLE_ISSUES)
	const hiddenCount = issues.length - visible.length
	const summary = visible.join(", ") + (hiddenCount > 0 ? ` +${hiddenCount} more` : "")
	return h.span(
		[h.Class(cn("flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground"))],
		[
			icon(h, "CircleWarningIcon", { size: 14, className: "shrink-0 text-severity-warn" }),
			h.span([h.Class("truncate")], ["Fix before saving: ", h.span([h.Class("text-foreground")], [summary])]),
			...(hiddenCount > 0 ? [issuesDetails(h, model, issues)] : []),
		],
	)
}

const bar = (h: H, model: BarView, form: RuleForm, timing: AlertQueryTiming | null): Html => {
	// Unsaved field changes while editing, `null` on a new rule.
	const changeCount = model.savedForm === null ? null : diffRuleForms(model.savedForm, form).length
	const issues = saveIssues(form, timing)
	const isEditing = model.editingRuleId !== null
	const summary = describeRuleCondition(form)
	return h.div(
		[
			h.Class(
				cn(
					"sticky bottom-0 z-20 -mx-4 -mb-4 mt-6 border-t bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80",
				),
			),
		],
		[
			h.div(
				[h.Class(cn("mx-auto flex items-center justify-between gap-4", RULE_FORM_MAX_WIDTH))],
				[
					h.div(
						[h.Class("flex min-w-0 items-center gap-3")],
						[
							...(isEditing
								? []
								: [
										button(
											h,
											{
												variant: "ghost",
												size: "sm",
												className: "hidden sm:inline-flex",
												attributes: [h.OnClick(Message.ClickedShowTemplates())],
											},
											[icon(h, "SquareTerminalIcon"), "Templates"],
										),
									]),
							h.div(
								[h.Class("flex min-w-0 flex-col gap-0.5")],
								[
									h.p([h.Class("truncate text-sm text-foreground"), h.Title(summary)], [summary]),
									validationSummary(h, model, issues),
								],
							),
						],
					),
					h.div(
						[h.Class("flex shrink-0 items-center gap-2")],
						[
							...(changeCount === null
								? []
								: [
										h.span(
											[h.Class("hidden text-xs text-muted-foreground sm:inline")],
											[
												changeCount === 0
													? "No changes"
													: `${changeCount} unsaved ${changeCount === 1 ? "change" : "changes"}`,
											],
										),
									]),
							linkButton(h, { variant: "outline", href: alertsHref({}) }, ["Cancel"]),
							button(
								h,
								{
									isDisabled: issues.length > 0 || changeCount === 0,
									isLoading: model.isSaving,
									attributes: [h.OnClick(Message.ClickedSave())],
								},
								[icon(h, "FloppyDiskIcon"), isEditing ? "Save changes" : "Create rule"],
							),
						],
					),
				],
			),
		],
	)
}

const slot = createLazy()
const viewOf = stableSlice((model: Model) =>
	Struct.pick(model, ["issuesTooltip", "isSaving", "editingRuleId", "savedForm"]),
)

/** `RuleActionBar`. */
export const actionBar = (h: H, model: Model, form: RuleForm): Html =>
	slot(bar, [h, viewOf(model), form, draftTimingOf(model, form)])
