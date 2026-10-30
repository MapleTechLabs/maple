import { rawSqlIssue } from "@maple/domain/raw-sql"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { badgeVariants } from "@maple/ui/styles/ui/badge"
import { fieldErrorStyles } from "@maple/ui/styles/ui/field"
import { tokenizeSql } from "../../../lib/sql-highlight"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import * as Tooltip from "../../../ui/tooltip"
import { button } from "../../../ui/button"
import { field, fieldLabel, type FieldState } from "../../../ui/field"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { inlineCode } from "../../../ui/inline-code"
import { input } from "../../../ui/input"
import { Message } from "./message"
import type { Model } from "./model"
import { type RawSqlState, rawSqlErrorOf } from "./raw-sql"
import { SQL_TEXTAREA_ID } from "./sql-step"
import { widgetOf } from "./update"

// `RawSqlEditorPanel` under the editor's Raw SQL
// tab: the highlighted SQL, the macro and variable chips, the bucket, Run preview.

type H = HtmlBuilder<Message>

const MACRO_HINTS: ReadonlyArray<readonly [token: string, description: string]> = [
	["$__orgFilter", "Required: expands to OrgId = '<your org>'"],
	["$__timeFilter(Column)", "Column >= <start> AND Column <= <end>"],
	["$__startTime", "Range start as toDateTime('...')"],
	["$__endTime", "Range end as toDateTime('...')"],
	["$__interval_s", "Auto-computed bucket size in seconds"],
]

/** The tooltip trigger id of a chip, by position (variable names are free text). */
const chipTriggerId = (index: number): string => `widget-sql-chip-${index}`

const CHIP = "h-auto rounded-sm px-2 py-0.5 font-mono text-2xs sm:h-auto sm:text-2xs"

const header = (h: H, rawSql: RawSqlState): Html => {
	const issue = rawSqlIssue(rawSql.draft.sql)
	return h.div(
		[h.Class("flex items-center gap-2 px-3 py-2 bg-surface-sunken")],
		[
			iconButton(
				h,
				{
					size: "icon-xs",
					label: rawSql.isCollapsed ? "Expand SQL" : "Collapse SQL",
					hasTooltip: false,
					className: "text-muted-foreground hover:text-foreground",
					attributes: [h.OnClick(Message.ToggledSqlCollapsed())],
				},
				[icon(h, rawSql.isCollapsed ? "ChevronRightIcon" : "ChevronDownIcon")],
			),
			h.span(
				[
					h.Class(
						badgeVariants({
							variant: "outline",
							className: "font-mono text-2xs text-primary-foreground border-0 shrink-0 bg-primary/80",
						}),
					),
					h.DataAttribute("slot", "badge"),
				],
				["sql"],
			),
			h.span([h.Class("text-2xs text-muted-foreground")], ["ClickHouse"]),
			h.div([h.Class("flex-1")], []),
			...(issue !== null && !rawSql.isCollapsed
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
				h.OnInput((value) => Message.ChangedSql({ value })),
				h.Spellcheck(false),
				h.Class(
					"relative w-full bg-transparent text-transparent caret-foreground border border-border rounded-sm px-2 py-1.5 min-h-[200px] resize-y outline-none focus:ring-1 focus:ring-foreground/20 leading-5",
				),
			]),
		],
	)

const chip = (h: H, token: string, className: string, trigger: ReadonlyArray<ChildAttribute>): Html =>
	button(
		h,
		{
			variant: "ghost",
			size: "xs",
			className: cn(className, CHIP),
			attributes: [...trigger, h.OnClick(Message.ClickedSqlToken({ token }))],
		},
		[token],
	)

/** What a chip's tooltip says: the macro's expansion, or how a variable expands. */
const chipDescription = (chips: ReadonlyArray<readonly [string, string]>, triggerId: string): string =>
	chips.find((_, index) => chipTriggerId(index) === triggerId)?.[1] ?? ""

const IDLE: FieldState = {
	isInvalid: false,
	isDirty: false,
	isFilled: false,
	isFocused: false,
	isTouched: false,
}
const BUCKET_IDS = {
	control: "widget-editor-sql-bucket",
	label: "widget-editor-sql-bucket-label",
	error: "widget-editor-sql-bucket-error",
}

/** The chips, each a trigger of the one description tooltip. */
const chipRow = (
	h: H,
	chips: ReadonlyArray<readonly [string, string]>,
	trigger: (id: string) => ReadonlyArray<ChildAttribute>,
): Html =>
	h.div(
		[h.Class("flex flex-wrap gap-1.5 flex-1 pt-2")],
		chips.map(([token], index) =>
			chip(
				h,
				token,
				index < MACRO_HINTS.length
					? "bg-surface-sunken text-muted-foreground hover:bg-muted hover:text-foreground"
					: "bg-primary/10 text-primary hover:bg-primary/20",
				trigger(chipTriggerId(index)),
			),
		),
	)

/** The macro chips, a chip per dashboard variable, and the bucket override. */
const footer = (h: H, model: Model, rawSql: RawSqlState): Html => {
	const variables = model.document?.variables ?? []
	const chips = [
		...MACRO_HINTS,
		...variables.map(
			(variable) =>
				[
					`$${variable.name}`,
					`Dashboard variable: expands to the selected value, e.g. ServiceName IN ($${variable.name}). "All" expands to every value.`,
				] as const,
		),
	]
	// The portal sits after the row in block flow, so its brief in-place render moves no chip.
	return h.submodel({
		slotId: "widget-sql-chip-tooltip",
		model: model.sqlChipTooltip,
		view: Tooltip.view,
		toParentMessage: (message) => Message.GotSqlChipTooltipMessage({ message }),
		viewInputs: {
			triggerIds: chips.map((_, index) => chipTriggerId(index)),
			className: "max-w-xs",
			toContent: (triggerId) => [chipDescription(chips, triggerId)],
			toView: ({ trigger, portal }) =>
				h.div(
					[],
					[footerRow(h, rawSql, chipRow(h, chips, trigger)), ...(portal === null ? [] : [portal])],
				),
		},
	})
}

const footerRow = (h: H, rawSql: RawSqlState, chips: Html): Html => {
	const bucket = rawSql.draft.granularitySeconds
	return h.div(
		[h.Class("flex items-start gap-3 pt-1 border-t border-dashed")],
		[
			chips,
			field(h, { className: "flex-row items-center gap-2 pt-1.5 shrink-0", state: IDLE }, [
				fieldLabel(
					h,
					{
						ids: BUCKET_IDS,
						className: "font-normal text-2xs text-muted-foreground whitespace-nowrap sm:text-2xs",
						state: IDLE,
					},
					"Bucket",
				),
				input(h, {
					id: BUCKET_IDS.control,
					type: "number",
					size: "sm",
					className: "w-20 text-xs",
					attributes: [
						h.Min("1"),
						h.Placeholder("auto"),
						h.Value(bucket === null ? "" : String(bucket)),
						h.OnInput((value) => Message.ChangedSqlBucket({ value })),
					],
				}),
				h.span([h.Class("text-2xs text-muted-foreground")], ["s"]),
			]),
		],
	)
}

/** The Raw SQL tab's body: the `$__orgFilter` message, the panel, and Run preview. */
export const rawSqlEditor = (h: H, model: Model, rawSql: RawSqlState): ReadonlyArray<Html> => {
	const error = rawSqlErrorOf(rawSql.draft)
	const issue = rawSqlIssue(rawSql.draft.sql)
	return [
		...(error === null
			? []
			: [
					h.div(
						[
							h.Class(cn(fieldErrorStyles, "font-medium")),
							h.DataAttribute("slot", "field-error"),
						],
						[error],
					),
				]),
		h.div(
			[h.Class("space-y-3")],
			[
				h.div(
					[h.Class("border rounded-md")],
					[
						header(h, rawSql),
						...(rawSql.isCollapsed
							? []
							: [
									h.div(
										[h.Class("p-3 space-y-3")],
										[editor(h, rawSql.draft.sql), footer(h, model, rawSql)],
									),
								]),
					],
				),
				h.div(
					[h.Class("flex items-center gap-3")],
					[
						button(
							h,
							{
								size: "sm",
								isDisabled: issue !== null,
								attributes: [h.OnClick(Message.ClickedRunPreview())],
							},
							["Run preview"],
						),
						h.span(
							[h.Class("text-2xs text-muted-foreground ml-auto")],
							["Targets ", inlineCode(h, {}, [widgetOf(model)?.visualization ?? ""])],
						),
					],
				),
			],
		),
	]
}
