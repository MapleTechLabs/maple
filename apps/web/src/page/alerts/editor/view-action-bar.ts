import { pluralize } from "@maple/ui/lib/format"
import { diffRuleForms } from "@maple/web-data/alerts/preview-insights"
import { cn } from "@maple/ui/lib/utils"
import { Struct, Array as Arr } from "effect"
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { actionBar as kitActionBar } from "@maple/views/ui/action-bar"
import { button, linkButton } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import * as Tooltip from "@maple/views/ui/tooltip"
import { stableSlice } from "../../kit/stable-slice"
import { alertsHref } from "../shared/links"
import type { AlertQueryTiming } from "@maple/domain/http"
import { describeRuleCondition, isProtectedDefault, saveIssues } from "./derive"
import { draftTimingOf } from "./derive-rows"
import type { RuleForm } from "./form"
import { Message } from "./message"
import type { Model } from "./model"
import { RULE_FORM_MAX_WIDTH } from "./view-step"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"

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
				h.ul(
					[h.Class("space-y-0.5 text-xs")],
					Arr.map(issues, (issue) => h.li([h.Key(issue)], [`• ${issue}`])),
				),
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
								className:
									"text-muted-foreground underline decoration-dotted hover:text-foreground active:text-foreground",
								attributes: trigger(),
							},
							["details"],
						),
						...(portal === null ? [] : [portal]),
					],
				),
		},
	})

/** A blocker as a jump link: it opens the blocker's card and focuses its field. */
const issueLink = (h: H, issue: string): Html =>
	button(
		h,
		{
			variant: "link",
			size: "xs",
			className: "h-9 px-0 sm:h-7",
			attributes: [h.Key(issue), h.OnClick(Message.ClickedIssue({ issue }))],
		},
		[issue],
	)

/**
 * `ValidationSummary`: one state at a time. Nothing to save says so; a valid edit is ready; a
 * blocked one lists what to fix, each item a jump to its field.
 */
const validationSummary = (h: H, model: BarView, issues: ReadonlyArray<string>, isClean: boolean): Html => {
	if (issues.length > 0) {
		const visible = issues.slice(0, MAX_VISIBLE_ISSUES)
		const hiddenCount = issues.length - visible.length
		return hstack(h, { align: "center", wrap: true, shrink: true, className: "gap-x-1.5 gap-y-0.5" }, [
			icon(h, "CircleWarningIcon", { size: 14, className: "shrink-0 text-severity-warn" }),
			typography(h, { size: "xs", tone: "muted" }, ["Fix before saving:"]),
			...Arr.flatMap(visible, (issue, index) => [
				issueLink(h, issue),
				...(index < visible.length - 1
					? [
							typography(
								h,
								{
									size: "xs",
									tone: "muted",
									className: "-ml-1.5",
									attributes: [h.AriaHidden(true)],
								},
								[","],
							),
						]
					: []),
			]),
			...(hiddenCount > 0
				? [
						typography(h, { size: "xs", tone: "muted" }, [`+${hiddenCount} more`]),
						issuesDetails(h, model, issues),
					]
				: []),
		])
	}
	if (isClean) return typography(h, { size: "xs", tone: "muted", as: "p" }, ["No changes"])
	return hstack(
		h,
		{
			gap: "1.5",
			as: "span",
			className: typographyClass({ size: "xs", className: "text-severity-info" }),
		},
		[icon(h, "CheckIcon", { size: 14 }), "Ready to save"],
	)
}

const bar = (h: H, model: BarView, form: RuleForm, timing: AlertQueryTiming | null): Html => {
	// Unsaved field changes while editing, `null` on a new rule.
	const changeCount = model.savedForm === null ? null : diffRuleForms(model.savedForm, form).length
	const isDefault = isProtectedDefault(model)
	const issues = saveIssues(form, timing, isDefault)
	const isEditing = model.editingRuleId !== null
	const summary = describeRuleCondition(form, isDefault)
	return kitActionBar(h, {
		label: "Rule actions",
		className: cn("mx-auto mt-6 w-full", RULE_FORM_MAX_WIDTH),
		leading: [
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
			vstack(h, { gap: "0.5", shrink: true }, [
				// A phone wraps the sentence onto a second line; from `sm` it is one line.
				typography(
					h,
					{
						size: "sm",
						tone: "foreground",
						as: "p",
						className: "line-clamp-2 sm:line-clamp-1",
						attributes: [h.Title(summary)],
					},
					[summary],
				),
				validationSummary(h, model, issues, changeCount === 0),
			]),
		],
		actions: [
			...(changeCount === null || changeCount === 0
				? []
				: [
						typography(h, { size: "xs", tone: "muted", className: "hidden sm:inline" }, [
							`${changeCount} unsaved ${pluralize(changeCount, "change")}`,
						]),
					]),
			linkButton(h, { variant: "outline", size: "sm", href: alertsHref({}, "rules") }, ["Cancel"]),
			button(
				h,
				{
					size: "sm",
					// With something missing the press is a save attempt: it shows what to fix.
					isDisabled: changeCount === 0,
					isLoading: model.isSaving,
					attributes: [h.OnClick(Message.ClickedSave())],
				},
				[icon(h, "FloppyDiskIcon"), isEditing ? "Save changes" : "Create rule"],
			),
		],
	})
}

const slot = createLazy()
const viewOf = stableSlice((model: Model) =>
	Struct.pick(model, ["issuesTooltip", "isSaving", "editingRuleId", "savedForm"]),
)

/** `RuleActionBar`. */
export const actionBar = (h: H, model: Model, form: RuleForm): Html =>
	slot(bar, [h, viewOf(model), form, draftTimingOf(model, form)])
