import type { AlertQueryTiming } from "@maple/domain/http"
import { rawAlertPerformanceHints, rawAlertSampleCountWarning, rawSqlIssue } from "@maple/domain/raw-sql"
import { alertQueryLimits } from "@maple/query-engine/datetime"
import { RAW_QUERY_REDUCER_LABELS } from "@maple/web-data/alerts/form-utils"
import { formatQuerySeconds } from "@maple/web-data/alerts/query-time"
import { TONE_FILL, TONE_TEXT, type Tone } from "@maple/ui/lib/tone"
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
import { formIntervalMinutes, intervalWindowIssue, shortestFittingInterval } from "./interval"
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
								className: cn("font-mono text-2xs text-white border-0 shrink-0 bg-primary/80"),
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
								h.span(token.className === undefined ? [] : [h.Class(token.className)], [token.text]),
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

// The 1, 5 and 10 minute limits, marked on a meter as long as the longest one.
const METER_TICKS = [1, 5, 10].map((minutes) => alertQueryLimits(minutes).timeSeconds * 1000)

const meterNote = (form: RuleForm, timing: AlertQueryTiming, interval: number, limitMs: number): string => {
	const elapsed = timing.elapsedMs
	if (elapsed === null) {
		return timing.failure === "query_too_much_memory"
			? "Ran out of memory before it finished. Narrow it with the suggestions below."
			: `Did not finish within ${formatQuerySeconds(timing.probeLimitMs)}, too slow for any interval. Narrow it with the suggestions below.`
	}
	const shortest = shortestFittingInterval(form, timing)
	if (shortest !== null) {
		return elapsed > limitMs
			? `Too slow for ${interval}-minute checks, fits ${shortest}-minute checks.`
			: `Too close to the ${formatQuerySeconds(limitMs)} limit for ${interval}-minute checks, fits ${shortest}-minute checks.`
	}
	if (!timing.fitsIntervalMinutes.some((fits) => fits <= interval)) {
		return elapsed > limitMs
			? "Too slow for any interval this window allows. Widen the window or narrow the query."
			: `Too close to the ${formatQuerySeconds(limitMs)} limit to run reliably. Widen the window for a longer interval, or narrow the query.`
	}
	if (intervalWindowIssue(form) !== null) return "The picked interval is longer than the window. Pick a shorter one."
	return `Fits checks every ${interval === 1 ? "minute" : `${interval} min`}.`
}

/** One check's query time against the limit at the picked interval, and the switch to one it fits. */
const queryTimeMeter = (h: H, form: RuleForm, timing: AlertQueryTiming): Html => {
	const interval = formIntervalMinutes(form)
	const limitMs = alertQueryLimits(interval).timeSeconds * 1000
	const elapsed = timing.elapsedMs
	const tone: Tone = elapsed === null || elapsed > limitMs ? "crit" : elapsed > limitMs * 0.8 ? "warn" : "ok"
	const fill = elapsed === null ? 1 : Math.min(elapsed / timing.probeLimitMs, 1)
	const shortest = shortestFittingInterval(form, timing)
	return h.div(
		[h.Class("space-y-1.5 rounded-md border px-3 py-2.5"), h.DataAttribute("testid", "query-time-meter")],
		[
			h.div(
				[h.Class("flex items-baseline justify-between gap-3 text-xs")],
				[
					h.span([h.Class("font-medium")], ["Query time"]),
					h.span(
						[h.Class(cn("tabular-nums", TONE_TEXT[tone]))],
						elapsed === null
							? [
									timing.failure === "query_too_much_memory"
										? "Out of memory"
										: `Over ${formatQuerySeconds(timing.probeLimitMs)}`,
								]
							: [
									formatQuerySeconds(elapsed),
									h.span([h.Class("text-muted-foreground")], [` of ${formatQuerySeconds(limitMs)}`]),
								],
					),
				],
			),
			h.div(
				[h.Class("relative h-1.5 overflow-hidden rounded-full bg-muted")],
				[h.div([h.Class(cn("h-full rounded-full", TONE_FILL[tone])), h.Style({ width: `${fill * 100}%` })], [])],
			),
			h.div(
				[h.Class("relative h-3 text-[10px] tabular-nums text-muted-foreground"), h.AriaHidden(true)],
				METER_TICKS.map((tickMs) =>
					h.span(
						[
							h.Class(cn("absolute -translate-x-full whitespace-nowrap", tickMs === limitMs && "font-medium text-foreground")),
							h.Style({ left: `${(tickMs / timing.probeLimitMs) * 100}%` }),
						],
						[formatQuerySeconds(tickMs)],
					),
				),
			),
			h.div(
				[h.Class("flex flex-wrap items-center justify-between gap-2")],
				[
					h.p([h.Class("text-xs text-muted-foreground")], [meterNote(form, timing, interval, limitMs)]),
					...(shortest === null
						? []
						: [
								button(
									h,
									{
										variant: "outline",
										size: "xs",
										attributes: [h.OnClick(Message.ClickedUseInterval({ minutes: String(shortest) }))],
									},
									[`Check every ${shortest} min`],
								),
							]),
				],
			),
		],
	)
}

/** Cheaper filters for a query that is slow or close to its limit, each pointing at its line. */
const performanceHints = (h: H, sql: string): ReadonlyArray<Html> =>
	rawAlertPerformanceHints(sql).map((hint) =>
		h.p(
			[h.Class("flex items-start gap-2 text-xs text-muted-foreground")],
			[
				icon(h, "BoltIcon", { size: 14, className: "mt-px shrink-0 text-severity-warn" }),
				h.span(
					[],
					[h.span([h.Class("font-medium text-foreground")], [`Line ${hint.line}: `]), hint.message],
				),
			],
		),
	)

/** Whether the timed query is slow enough that its cheaper filters are worth showing. */
const isNearLimit = (form: RuleForm, timing: AlertQueryTiming): boolean =>
	timing.elapsedMs === null ||
	timing.elapsedMs > alertQueryLimits(formIntervalMinutes(form)).timeSeconds * 1000 * 0.5

/** `RawQueryEditor`: the SQL panel, the query time, the reducer, and the sample-count warning. */
export const rawQueryEditor = (h: H, model: SqlView, form: RuleForm, timing: AlertQueryTiming | null): Html => {
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
								: [h.div([h.Class("p-3 space-y-3")], [editor(h, form.rawQuerySql), macros(h)])]),
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
			...(sampleWarning === null ? [] : [h.p([h.Class("text-xs text-severity-warn")], [sampleWarning])]),
			...(timing === null ? [] : [queryTimeMeter(h, form, timing)]),
			...(timing !== null && isNearLimit(form, timing) ? performanceHints(h, form.rawQuerySql) : []),
		],
	)
}
