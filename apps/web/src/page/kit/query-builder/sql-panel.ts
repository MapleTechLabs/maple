import { RAW_SQL_MACROS, type RawSqlIssue } from "@maple/domain/raw-sql"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { Array as Arr } from "effect"
import { queryPanelBar } from "../query-panel-bar"

// The raw SQL panel's pieces every SQL editor shares: its header bar and the macro chips.

type RawSqlMacro = (typeof RAW_SQL_MACROS)[number]

/** One macro chip: the text it inserts and what it expands to. */
export type SqlMacroHint = readonly [token: string, description: string]

const MACRO_HINT = {
	$__orgFilter: ["$__orgFilter", "Required: expands to OrgId = '<your org>'"],
	$__timeFilter: ["$__timeFilter(Column)", "Required: Column >= <start> AND Column <= <end>"],
	$__timeGroup: ["$__timeGroup(Column)", "Column floored to the start of its bucket: select it AS bucket"],
	$__startTime: ["$__startTime", "Range start as toDateTime('...')"],
	$__endTime: ["$__endTime", "Range end as toDateTime('...')"],
	$__interval_s: ["$__interval_s", "Auto-computed bucket size in seconds"],
} satisfies Readonly<Record<RawSqlMacro, SqlMacroHint>>

/** The macro chips, one per macro the engine expands, in the engine's order. */
export const SQL_MACRO_HINTS: ReadonlyArray<SqlMacroHint> = Arr.map(
	RAW_SQL_MACROS,
	(macro) => MACRO_HINT[macro],
)

/** `RawSqlEditorPanel`'s header bar: collapse toggle, `sql` badge, and the open panel's SQL issue. */
export const sqlPanelHeader = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ isCollapsed: boolean; issue: RawSqlIssue | null; toggled: M }>,
): Html =>
	queryPanelBar(h, [
		iconButton(
			h,
			{
				size: "icon-xs",
				label: options.isCollapsed ? "Expand SQL" : "Collapse SQL",
				hasTooltip: false,
				className: typographyClass({ tone: "muted", hoverTone: "foreground" }),
				attributes: [h.OnClick(options.toggled)],
			},
			[icon(h, options.isCollapsed ? "ChevronRightIcon" : "ChevronDownIcon")],
		),
		badge(
			h,
			{
				variant: "outline",
				className: "font-mono text-2xs text-primary-foreground border-0 shrink-0 bg-primary/80",
			},
			["sql"],
		),
		typography(h, { size: "2xs", tone: "muted" }, ["ClickHouse"]),
		h.div([h.Class("flex-1")], []),
		...(options.issue !== null && !options.isCollapsed
			? [
					h.span(
						[h.Class(cn("text-2xs", TONE_TEXT.crit)), h.Title(options.issue.message)],
						[
							options.issue.code === "MissingOrgFilter"
								? "Missing $__orgFilter"
								: options.issue.message,
						],
					),
				]
			: []),
	])
