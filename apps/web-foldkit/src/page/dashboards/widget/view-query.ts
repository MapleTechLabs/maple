import {
	AGGREGATIONS_BY_SOURCE,
	buildTimeseriesQuerySpec,
	getMetricsAggregations,
	queryBadgeColor,
} from "@maple/query-engine/query-builder"
import { QUERY_BUILDER_DATA_SOURCES } from "@maple/query-model"
import { cn } from "@maple/ui/lib/utils"
import { badgeVariants } from "@maple/ui/styles/ui/badge"
import { fieldErrorStyles } from "@maple/ui/styles/ui/field"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription } from "../../../ui/alert"
import { button } from "../../../ui/button"
import * as Checkbox from "../../../ui/checkbox"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import type { SelectOption } from "../../../ui/select-view"
import * as TabsView from "../../../ui/tabs-view"
import type { FormulaDraft, QueryDraft } from "./editor-state"
import { validationErrorOf } from "./lowering"
import { autoIntervalLabel } from "./update"
import { Message } from "./message"
import type { Model } from "./model"
import { addOnSections, ADD_ON_KEYS, addOnToggles, textInput, whereClauseEditor } from "./view-query-parts"
import { pageSelect } from "./view-select"

// `WidgetQueryBuilderPage`'s query side: the source toggle, one `QueryPanel` per query,
// `FormulaPanel`s, and the toolbar (query-panel.tsx, query-panel-shell.tsx, formula-panel.tsx).

type H = HtmlBuilder<Message>

const SOURCE_LABEL = {
	traces: "Traces",
	logs: "Logs",
	metrics: "Metrics",
	product_events: "Product events",
}

const aggregationOptions = (query: QueryDraft): ReadonlyArray<SelectOption> =>
	query.dataSource === "metrics"
		? getMetricsAggregations(query.metricType, query.isMonotonic)
		: AGGREGATIONS_BY_SOURCE[query.dataSource]

const header = (h: H, model: Model, query: QueryDraft, index: number, canRemove: boolean): Html => {
	const isCollapsed = model.collapsed.includes(query.id)
	const leading = [
		iconButton(
			h,
			{
				size: "icon-xs",
				label: isCollapsed ? "Expand query" : "Collapse query",
				hasTooltip: false,
				className: "text-muted-foreground hover:text-foreground",
				attributes: [h.OnClick(Message.ToggledQueryCollapsed({ queryId: query.id }))],
			},
			[icon(h, isCollapsed ? "ChevronRightIcon" : "ChevronDownIcon")],
		),
		...Checkbox.view(h, {
			model: { isChecked: !query.hidden },
			toParentMessage: () => Message.ToggledQueryVisible({ queryId: query.id }),
			id: `query-visible-${query.id}-root`,
			inputId: `query-visible-${query.id}`,
			className: "shrink-0",
		}),
		h.span(
			[
				h.Class(
					cn(
						badgeVariants({
							variant: "outline",
							className: cn(
								"font-mono text-2xs text-white border-0 shrink-0",
								queryBadgeColor(index),
							),
						}),
					),
				),
				h.DataAttribute("slot", "badge"),
			],
			[query.name],
		),
	]
	const trailing = [
		h.div([h.Class("flex-1")], []),
		button(
			h,
			{
				variant: "ghost",
				size: "xs",
				attributes: [h.OnClick(Message.ClickedCloneQuery({ queryId: query.id }))],
			},
			["Clone"],
		),
		button(
			h,
			{
				variant: "ghost",
				size: "xs",
				isDisabled: !canRemove,
				attributes: [h.OnClick(Message.ClickedRemoveQuery({ queryId: query.id }))],
			},
			["Remove"],
		),
	]
	return pageSelect(
		h,
		model,
		`source:${query.id}`,
		query.dataSource,
		QUERY_BUILDER_DATA_SOURCES.map((value) => ({ value, label: SOURCE_LABEL[value] })),
		{
			size: "sm",
			className: "w-36 border-none bg-transparent shadow-none px-1",
			ariaLabel: "Query source",
			toView: (parts) =>
				h.div(
					[h.Class("flex items-center gap-2 px-3 py-2 bg-muted/30")],
					[...leading, ...parts, ...trailing],
				),
		},
	)
}

const SPAN_OPTIONS = [
	{ value: "all", label: "All Spans" },
	{ value: "root", label: "Root Spans" },
]

/** `TracesLogsBody` (metrics share it until the metric picker is ported). */
const body = (h: H, model: Model, query: QueryDraft, intervalPlaceholder: string): ReadonlyArray<Html> => {
	const whereRow = (parts: ReadonlyArray<Html>) =>
		h.div([h.Class("flex items-start gap-2")], [whereClauseEditor(h, query), ...parts])
	return [
		query.dataSource === "traces"
			? pageSelect(
					h,
					model,
					`spans:${query.id}`,
					query.whereClause.includes("root_only = true") ? "root" : "all",
					SPAN_OPTIONS,
					{ size: "sm", className: "w-[120px] shrink-0", toView: whereRow },
				)
			: whereRow([]),
		pageSelect(h, model, `aggregation:${query.id}`, query.aggregation, aggregationOptions(query), {
			size: "sm",
			className: "w-[160px]",
			toView: (parts) =>
				h.div(
					[h.Class("flex items-center gap-2 flex-wrap")],
					[
						...parts,
						h.span([h.Class("text-xs text-muted-foreground")], ["every"]),
						textInput(
							h,
							`step-${query.id}`,
							query.stepInterval,
							intervalPlaceholder,
							"h-8 w-24 text-xs",
							(value) =>
								Message.ChangedQueryText({ queryId: query.id, field: "stepInterval", value }),
						),
						h.span([h.Class("text-xs text-muted-foreground")], ["seconds"]),
					],
				),
		}),
	]
}

/** `WarningList`: clauses the builder could not apply as written. */
const warningList = (h: H, warnings: ReadonlyArray<string>): ReadonlyArray<Html> =>
	warnings.length === 0
		? []
		: [
				alert(h, { variant: "warn", size: "sm" }, [
					icon(h, "CircleWarningIcon", { size: 14 }),
					alertDescription(
						h,
						[
							h.ul(
								[h.Class("space-y-1")],
								warnings.map((warning) => h.li([], [warning])),
							),
						],
						"text-severity-warn",
					),
				]),
			]

export const queryPanel = (
	h: H,
	model: Model,
	query: QueryDraft,
	index: number,
	canRemove: boolean,
	intervalPlaceholder: string,
): Html =>
	h.div(
		[h.Class("border rounded-md")],
		[
			header(h, model, query, index, canRemove),
			...(model.collapsed.includes(query.id)
				? []
				: [
						h.div(
							[h.Class("p-3 space-y-3")],
							[
								...body(h, model, query, intervalPlaceholder),
								// TODO(widget-editor): the product-events setup hint (`SignalEmptyState`).
								...warningList(h, buildTimeseriesQuerySpec(query).warnings),
								addOnToggles(h, query, ADD_ON_KEYS),
								...addOnSections(h, model, query),
							],
						),
					]),
		],
	)

/** `FormulaPanel`. */
const formulaPanel = (h: H, formula: FormulaDraft): Html =>
	h.div(
		[h.Class("border border-dashed border-l-2 border-l-chart-3 p-3 space-y-2")],
		[
			h.div(
				[h.Class("flex items-center justify-between gap-2")],
				[
					h.div(
						[h.Class("flex items-center gap-2")],
						[
							...Checkbox.view(h, {
								model: { isChecked: !formula.hidden },
								toParentMessage: () =>
									Message.ToggledFormulaVisible({ formulaId: formula.id }),
								id: `formula-visible-${formula.id}-root`,
								inputId: `formula-visible-${formula.id}`,
							}),
							h.span(
								[
									h.Class(
										cn(
											badgeVariants({
												variant: "outline",
												className:
													"font-mono text-xs bg-chart-3/10 border-chart-3/30",
											}),
										),
									),
									h.DataAttribute("slot", "badge"),
								],
								[formula.name],
							),
						],
					),
					button(
						h,
						{
							variant: "ghost",
							size: "xs",
							attributes: [h.OnClick(Message.ClickedRemoveFormula({ formulaId: formula.id }))],
						},
						["Remove"],
					),
				],
			),
			h.div(
				[h.Class("flex items-center gap-2")],
				[
					textInput(
						h,
						`formula-expression-${formula.id}`,
						formula.expression,
						"A / B, (A + B) / 2",
						"font-mono flex-1",
						(value) =>
							Message.ChangedFormulaText({ formulaId: formula.id, field: "expression", value }),
					),
					textInput(h, `formula-legend-${formula.id}`, formula.legend, "Legend", "w-48", (value) =>
						Message.ChangedFormulaText({ formulaId: formula.id, field: "legend", value }),
					),
				],
			),
		],
	)

const sourceToggle = (h: H, model: Model): Html =>
	h.div(
		[h.Class("flex items-center gap-3")],
		[
			eyebrow(h, {}, ["Source"]),
			h.submodel({
				slotId: "widget-editor-source",
				model: model.sourceTabs,
				view: TabsView.view,
				viewInputs: { labels: ["Query Builder", "Raw SQL"], panel: () => undefined },
				toParentMessage: (message) => Message.GotSourceTabsMessage({ message }),
			}),
		],
	)

export const queryEditor = (h: H, model: Model, timeZone: string): Html => {
	const state = model.state
	if (state === null) return h.empty
	const error = validationErrorOf(state)
	return h.div(
		[h.Class("p-6 space-y-6"), h.OnFocusEnter(Message.FocusedQueryEditor())],
		[
			sourceToggle(h, model),
			...(model.sourceMode === "rawSql"
				? [h.p([h.Class("text-muted-foreground text-xs")], ["The Raw SQL editor is not ported yet."])]
				: [
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
							state.queries.map((query, index) =>
								queryPanel(
									h,
									model,
									query,
									index,
									state.queries.length > 1,
									autoIntervalLabel(model, timeZone),
								),
							),
						),
						...(state.formulas.length === 0
							? []
							: [
									h.div(
										[h.Class("space-y-3")],
										state.formulas.map((formula) => formulaPanel(h, formula)),
									),
								]),
						h.div(
							[h.Class("flex items-center gap-3")],
							[
								button(
									h,
									{
										variant: "outline",
										size: "sm",
										attributes: [h.OnClick(Message.ClickedAddQuery())],
									},
									["+ Query"],
								),
								button(
									h,
									{
										variant: "outline",
										size: "sm",
										attributes: [h.OnClick(Message.ClickedAddFormula())],
									},
									["+ Formula"],
								),
								button(
									h,
									{
										size: "sm",
										isDisabled: error !== null,
										attributes: [h.OnClick(Message.ClickedRunPreview())],
									},
									["Run preview"],
								),
								// Two text nodes once there are formulas, as legacy renders them.
								h.span(
									[h.Class("text-2xs text-muted-foreground ml-auto")],
									[
										state.queries.map((query) => query.name).join(", "),
										...(state.formulas.length === 0
											? []
											: [
													`, ${state.formulas.map((formula) => formula.name).join(", ")}`,
												]),
									],
								),
							],
						),
					]),
		],
	)
}
