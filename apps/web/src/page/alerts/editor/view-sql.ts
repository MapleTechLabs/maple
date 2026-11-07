import type { AlertQueryTiming } from "@maple/domain/http"
import { rawAlertPerformanceHints, rawAlertSampleCountWarning, rawSqlIssue } from "@maple/domain/raw-sql"
import { alertIntervalsFitting, alertQueryLimits } from "@maple/query-engine/datetime"
import { RAW_QUERY_REDUCER_LABELS } from "@maple/web-data/alerts/form-utils"
import { formatQuerySeconds } from "@maple/web-data/alerts/query-time"
import { TONE_FILL, TONE_TEXT, type Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { inlineCode } from "@maple/views/ui/inline-code"
import { label } from "@maple/views/ui/label"
import type * as Select from "@maple/views/ui/select"
import { sqlEditor } from "@maple/views/ui/sql-editor"
import type { RuleForm } from "./form"
import { formIntervalMinutes, intervalWindowIssue, shortestFittingInterval } from "./interval"
import { Message } from "./message"
import type { Model } from "./model"
import { formSelect } from "./view-select"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { queryPanelBar } from "../../kit/query-panel-bar"
import { Array as Arr, Record as Rec } from "effect"
import { stripClass } from "@maple/views/ui/rule"

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

const REDUCER_OPTIONS = Arr.map(Rec.toEntries(RAW_QUERY_REDUCER_LABELS), ([value, text]) => ({
	value,
	label: text,
}))

const header = (h: H, model: SqlView, sql: string): Html => {
	const issue = rawSqlIssue(sql)
	return queryPanelBar(h, [
		iconButton(
			h,
			{
				size: "icon-xs",
				label: model.isSqlCollapsed ? "Expand SQL" : "Collapse SQL",
				hasTooltip: false,
				className: typographyClass({ tone: "muted", hoverTone: "foreground" }),
				attributes: [h.OnClick(Message.ToggledSqlCollapsed())],
			},
			[icon(h, model.isSqlCollapsed ? "ChevronRightIcon" : "ChevronDownIcon")],
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
		...(issue !== null && !model.isSqlCollapsed
			? [
					h.span(
						[h.Class(cn("text-2xs", TONE_TEXT.crit)), h.Title(issue.message)],
						[issue.code === "MissingOrgFilter" ? "Missing $__orgFilter" : issue.message],
					),
				]
			: []),
	])
}

const editor = (h: H, sql: string): Html =>
	sqlEditor(h, {
		id: SQL_TEXTAREA_ID,
		label: "SQL query",
		value: sql,
		onInput: (value) => Message.ChangedField({ field: "rawQuerySql", value }),
	})

/** The macro chips: one-click inserts at the caret. TODO(alert-editor): their description tooltips. */
const macros = (h: H): Html =>
	hstack(h, { gap: "3", align: "start", className: stripClass("dashed") }, [
		hstack(
			h,
			{ gap: "1.5", align: "stretch", wrap: true, grow: true, className: "pt-2" },
			Arr.map(MACRO_HINTS, (token) =>
				button(
					h,
					{
						variant: "ghost",
						size: "xs",
						className:
							"h-auto rounded-sm bg-surface-sunken px-2 py-0.5 font-mono text-2xs text-muted-foreground hover:bg-muted active:bg-muted hover:text-foreground active:text-foreground sm:h-auto sm:text-2xs",
						attributes: [h.OnClick(Message.ClickedSqlToken({ token }))],
					},
					[token],
				),
			),
		),
	])

// The 1, 5 and 10 minute limits, marked on a meter as long as the longest one.
const METER_TICKS = Arr.map([1, 5, 10], (minutes) => alertQueryLimits(minutes).timeSeconds * 1000)

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
	if (!Arr.some(timing.fitsIntervalMinutes, (fits) => fits <= interval)) {
		// A wider window helps only when a longer interval than it allows would fit.
		const canWiden = alertIntervalsFitting(elapsed).length > 0
		return elapsed > limitMs
			? `Too slow for any interval this window allows. ${canWiden ? "Widen the window or narrow the query." : "Narrow the query."}`
			: `Too close to the ${formatQuerySeconds(limitMs)} limit to run reliably. ${canWiden ? "Widen the window for a longer interval, or narrow the query." : "Narrow the query."}`
	}
	if (intervalWindowIssue(form) !== null)
		return "The picked interval is longer than the window. Pick a shorter one."
	return `Fits checks every ${interval === 1 ? "minute" : `${interval} min`}.`
}

/** One check's query time against the limit at the picked interval, and the switch to one it fits. */
const queryTimeMeter = (h: H, form: RuleForm, timing: AlertQueryTiming): Html => {
	const interval = formIntervalMinutes(form)
	const limitMs = alertQueryLimits(interval).timeSeconds * 1000
	const elapsed = timing.elapsedMs
	const tone: Tone =
		elapsed === null || elapsed > limitMs ? "crit" : elapsed > limitMs * 0.8 ? "warn" : "ok"
	const fill = elapsed === null ? 1 : Math.min(elapsed / timing.probeLimitMs, 1)
	const shortest = shortestFittingInterval(form, timing)
	return h.div(
		[h.Class("space-y-1.5 rounded-md border p-3"), h.DataAttribute("testid", "query-time-meter")],
		[
			hstack(h, { gap: "3", align: "baseline", justify: "between", className: "text-xs" }, [
				typography(h, { weight: "medium" }, ["Query time"]),
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
								typography(h, { tone: "muted" }, [` of ${formatQuerySeconds(limitMs)}`]),
							],
				),
			]),
			h.div(
				[h.Class("relative h-1.5 overflow-hidden rounded-full bg-muted")],
				[
					h.div(
						[
							h.Class(cn("h-full rounded-full", TONE_FILL[tone])),
							h.Style({ width: `${fill * 100}%` }),
						],
						[],
					),
				],
			),
			h.div(
				[h.Class("relative h-3 text-3xs tabular-nums text-muted-foreground"), h.AriaHidden(true)],
				Arr.map(METER_TICKS, (tickMs) =>
					h.span(
						[
							h.Class(
								cn(
									"absolute -translate-x-full whitespace-nowrap",
									tickMs === limitMs &&
										typographyClass({ tone: "foreground", weight: "medium" }),
								),
							),
							h.Style({ left: `${(tickMs / timing.probeLimitMs) * 100}%` }),
						],
						[formatQuerySeconds(tickMs)],
					),
				),
			),
			hstack(h, { gap: "2", align: "center", justify: "between", wrap: true }, [
				typography(h, { size: "xs", tone: "muted", as: "p" }, [
					meterNote(form, timing, interval, limitMs),
				]),
				...(shortest === null
					? []
					: [
							button(
								h,
								{
									variant: "outline",
									size: "xs",
									attributes: [
										h.OnClick(Message.ClickedUseInterval({ minutes: String(shortest) })),
									],
								},
								[`Check every ${shortest} min`],
							),
						]),
			]),
		],
	)
}

/** Cheaper filters for a query that is slow or close to its limit, each pointing at its line. */
const performanceHints = (h: H, sql: string): ReadonlyArray<Html> =>
	Arr.map(rawAlertPerformanceHints(sql), (hint) =>
		h.p(
			[h.Class("flex items-start gap-2 text-xs text-muted-foreground")],
			[
				icon(h, "BoltIcon", { size: 14, className: "mt-px shrink-0 text-severity-warn" }),
				h.span(
					[],
					[
						typography(h, { tone: "foreground", weight: "medium" }, [`Line ${hint.line}: `]),
						hint.message,
					],
				),
			],
		),
	)

/** Whether the timed query is slow enough that its cheaper filters are worth showing. */
const isNearLimit = (form: RuleForm, timing: AlertQueryTiming): boolean =>
	timing.elapsedMs === null ||
	timing.elapsedMs > alertQueryLimits(formIntervalMinutes(form)).timeSeconds * 1000 * 0.5

/** `RawQueryEditor`: the SQL panel, the query time, the reducer, and the sample-count warning. */
export const rawQueryEditor = (
	h: H,
	model: SqlView,
	form: RuleForm,
	timing: AlertQueryTiming | null,
): Html => {
	const sampleWarning = rawAlertSampleCountWarning(
		form.rawQuerySql,
		Number.isNaN(Number(form.minimumSampleCount)) ? 0 : Number(form.minimumSampleCount),
	)
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
					hstack(h, { gap: "3" }, [
						typography(h, { size: "2xs", tone: "muted", className: "ml-auto" }, [
							"Targets ",
							inlineCode(h, {}, ["alert rule"]),
						]),
					]),
				],
			),
			formSelect(h, model.reducerSelect, REDUCER_SELECT_ID, form.rawQueryReducer, REDUCER_OPTIONS, {
				className: "h-8 w-40",
				toView: (parts) =>
					hstack(h, { gap: "3", wrap: true }, [
						label(
							h,
							{
								className: "font-normal text-sm text-muted-foreground sm:text-sm",
								attributes: [h.For("rule-raw-reducer")],
							},
							["Reduce each window by"],
						),
						...parts,
						typography(h, { size: "xs", tone: "muted", as: "p", className: "min-w-0 flex-1" }, [
							"Return a numeric ",
							inlineCode(h, {}, ["value"]),
							". Optional: ",
							inlineCode(h, {}, ["group"]),
							" ",
							"to split, ",
							inlineCode(h, {}, ["samples"]),
							" for the count Min samples sums. No rows is a no-data check.",
						]),
					]),
			}),
			...(sampleWarning === null
				? []
				: [typography(h, { size: "xs", tone: "warning", as: "p" }, [sampleWarning])]),
			...(timing === null ? [] : [queryTimeMeter(h, form, timing)]),
			...(timing !== null && isNearLimit(form, timing) ? performanceHints(h, form.rawQuerySql) : []),
		],
	)
}
