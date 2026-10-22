import { rawAlertSampleCountWarning, rawSqlIssue } from "@maple/domain/raw-sql"
import { RAW_QUERY_REDUCER_LABELS } from "@maple/web-data/alerts/form-utils"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { badgeVariants } from "@maple/ui/styles/ui/badge"
import { tokenizeSql } from "../../../lib/sql-highlight"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { inlineCode } from "../../../ui/inline-code"
import type * as Select from "../../../ui/select"
import type { RuleForm } from "./form"
import { Message } from "./message"
import type { Model } from "./model"
import { formSelect } from "./view-select"

// `RawSqlEditorPanel` without the bucket control, and the alert's reducer row under it
// (`RawQueryEditor`).

type H = HtmlBuilder<Message>

export const REDUCER_SELECT_ID = "rule-raw-reducer"

/** What the editor reads off the Model: the collapse and the reducer select's state. */
export type SqlView = Pick<Model, "isSqlCollapsed"> & Readonly<{ reducerSelect: Select.Model | undefined }>

export const SQL_TEXTAREA_ID = "alert-rule-sql"

const MACRO_HINTS: ReadonlyArray<string> = [
	"$__orgFilter",
	"$__timeFilter(Column)",
	"$__startTime",
	"$__endTime",
	"$__interval_s",
]

const REDUCER_OPTIONS = Object.entries(RAW_QUERY_REDUCER_LABELS).map(([value, label]) => ({ value, label }))

const header = (h: H, model: SqlView, sql: string): Html => {
	const issue = rawSqlIssue(sql)
	return h.div(
		[h.Class("flex items-center gap-2 px-3 py-2 bg-muted/30")],
		[
			iconButton(
				h,
				{
					size: "icon-xs",
					label: model.isSqlCollapsed ? "Expand SQL" : "Collapse SQL",
					hasTooltip: false,
					className: "text-muted-foreground hover:text-foreground",
					attributes: [h.OnClick(Message.ToggledSqlCollapsed())],
				},
				[icon(h, model.isSqlCollapsed ? "ChevronRightIcon" : "ChevronDownIcon")],
			),
			h.span(
				[
					h.Class(
						cn(
							badgeVariants({
								variant: "outline",
								className: cn(
									"font-mono text-2xs text-white border-0 shrink-0 bg-primary/80",
								),
							}),
						),
					),
					h.DataAttribute("slot", "badge"),
				],
				["sql"],
			),
			h.span([h.Class("text-2xs text-muted-foreground")], ["ClickHouse"]),
			h.div([h.Class("flex-1")], []),
			...(issue !== null && !model.isSqlCollapsed
				? [
						h.span(
							[h.Class(cn("text-2xs", TONE_TEXT.crit)), h.Title(issue.message)],
							[issue.code === "MissingOrgFilter" ? "Missing $__orgFilter" : issue.message],
						),
					]
				: []),
		],
	)
}

const editor = (h: H, sql: string): Html =>
	h.div(
		[h.Class("relative w-full text-xs font-mono leading-5")],
		[
			h.pre(
				[
					h.AriaHidden(true),
					h.Class(
						"pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words rounded-sm border border-transparent px-2 py-1.5 leading-5",
					),
				],
				[
					h.code(
						[h.Class("font-mono")],
						[
							...tokenizeSql(sql).map((token) =>
								h.span(token.className === undefined ? [] : [h.Class(token.className)], [
									token.text,
								]),
							),
							"\n",
						],
					),
				],
			),
			h.textarea([
				h.Id(SQL_TEXTAREA_ID),
				h.AriaLabel("SQL query"),
				h.Value(sql),
				h.OnInput((value) => Message.ChangedField({ field: "rawQuerySql", value })),
				h.Spellcheck(false),
				h.Class(
					"relative w-full bg-transparent text-transparent caret-foreground border border-border rounded-sm px-2 py-1.5 min-h-[200px] resize-y outline-none focus:ring-1 focus:ring-foreground/20 leading-5",
				),
			]),
		],
	)

/** The macro chips: one-click inserts at the caret. TODO(alert-editor): their description tooltips. */
const macros = (h: H): Html =>
	h.div(
		[h.Class("flex items-start gap-3 pt-1 border-t border-dashed")],
		[
			h.div(
				[h.Class("flex flex-wrap gap-1.5 flex-1 pt-2")],
				MACRO_HINTS.map((token) =>
					button(
						h,
						{
							variant: "ghost",
							size: "xs",
							className:
								"h-auto rounded-sm bg-muted/40 px-2 py-0.5 font-mono text-2xs text-muted-foreground hover:bg-muted hover:text-foreground sm:h-auto sm:text-2xs",
							attributes: [h.OnClick(Message.ClickedSqlToken({ token }))],
						},
						[token],
					),
				),
			),
		],
	)

/** `RawQueryEditor`: the SQL panel, the reducer, and the sample-count warning. */
export const rawQueryEditor = (h: H, model: SqlView, form: RuleForm): Html => {
	const sampleWarning = rawAlertSampleCountWarning(form.rawQuerySql, Number(form.minimumSampleCount) || 0)
	return h.div(
		[h.Class("space-y-2")],
		[
			h.div(
				[h.Class("space-y-3")],
				[
					h.div(
						[h.Class("border rounded-md")],
						[
							header(h, model, form.rawQuerySql),
							...(model.isSqlCollapsed
								? []
								: [
										h.div(
											[h.Class("p-3 space-y-3")],
											[editor(h, form.rawQuerySql), macros(h)],
										),
									]),
						],
					),
					h.div(
						[h.Class("flex items-center gap-3")],
						[
							h.span(
								[h.Class("text-2xs text-muted-foreground ml-auto")],
								["Targets ", inlineCode(h, {}, ["alert rule"])],
							),
						],
					),
				],
			),
			formSelect(h, model.reducerSelect, REDUCER_SELECT_ID, form.rawQueryReducer, REDUCER_OPTIONS, {
				className: "h-8 w-40",
				toView: (parts) =>
					h.div(
						[h.Class("flex flex-wrap items-center gap-3")],
						[
							h.label(
								[h.For("rule-raw-reducer"), h.Class("text-sm text-muted-foreground")],
								["Reduce each window by"],
							),
							...parts,
							h.p(
								[h.Class("min-w-0 flex-1 text-xs text-muted-foreground")],
								[
									"Return a numeric ",
									inlineCode(h, {}, ["value"]),
									". Optional: ",
									inlineCode(h, {}, ["group"]),
									" ",
									"to split, ",
									inlineCode(h, {}, ["samples"]),
									" for the count Min samples sums. No rows is a no-data check.",
								],
							),
						],
					),
			}),
			...(sampleWarning === null
				? []
				: [h.p([h.Class("text-xs text-severity-warn")], [sampleWarning])]),
		],
	)
}
