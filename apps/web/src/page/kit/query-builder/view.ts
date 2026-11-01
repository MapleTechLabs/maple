import {
	AGGREGATIONS_BY_SOURCE,
	buildTimeseriesQuerySpec,
	getMetricsAggregations,
	queryBadgeColor,
} from "@maple/query-engine/query-builder"
import { QUERY_BUILDER_DATA_SOURCES } from "@maple/query-model"
import type { WhereClauseAutocompleteValues } from "../../../lib/query-builder/where-clause-autocomplete"
import { cn } from "@maple/ui/lib/utils"
import { badgeVariants } from "@maple/ui/styles/ui/badge"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription } from "../../../ui/alert"
import { button } from "../../../ui/button"
import * as Checkbox from "../../../ui/checkbox"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import type { SelectOption } from "../../../ui/select-view"
import type { QueryDraft } from "./draft"
import { Message, type Model } from "./panel"
import { type MetricOption, metricsBody } from "./metrics-body"
import { addOnSections, ADD_ON_KEYS, addOnToggles, panelSelect, textInput, whereClauseEditor } from "./parts"

// `QueryPanel` and `QueryPanelShell`: one query's builder panel and its frame.

type H = HtmlBuilder<Message>

export type QueryPanelInputs = Readonly<{
	query: QueryDraft
	index: number
	canRemove: boolean
	/** `Auto (2m)` in the interval placeholder, or `Auto`. */
	intervalPlaceholder: string
	/** Clone / Remove in the header (`showHeaderActions`). */
	hasHeaderActions: boolean
	/** The "include in the chart" checkbox (`showVisibilityToggle`). */
	hasVisibilityToggle: boolean
	/** `metricSelectionOptions`: the metric list page for a metrics query; none until fetched. */
	metricOptions?: ReadonlyArray<MetricOption>
	/** What the metric picker last searched for (`MetricOptionsEmpty`). */
	metricSearch?: string
	/** The picked metric's attribute keys, offered as `attr.<key>` breakdowns. */
	metricBreakdownKeys?: ReadonlyArray<string>
	/** `autocompleteValues[query.dataSource]`: what the where editor completes from. */
	autocompleteValues?: WhereClauseAutocompleteValues
}>

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

const header = (h: H, model: Model, inputs: QueryPanelInputs): Html => {
	const { query, index } = inputs
	const isCollapsed = model.collapsed.includes(query.id)
	const leading = [
		iconButton(
			h,
			{
				size: "icon-xs",
				label: isCollapsed ? "Expand query" : "Collapse query",
				hasTooltip: false,
				className: "text-muted-foreground hover:text-foreground active:text-foreground",
				attributes: [h.OnClick(Message.ToggledCollapsed({ queryId: query.id }))],
			},
			[icon(h, isCollapsed ? "ChevronRightIcon" : "ChevronDownIcon")],
		),
		...(inputs.hasVisibilityToggle
			? Checkbox.view(h, {
					model: { isChecked: !query.hidden },
					toParentMessage: () => Message.ToggledVisible({ queryId: query.id }),
					id: `query-visible-${query.id}-root`,
					inputId: `query-visible-${query.id}`,
					className: "shrink-0",
				})
			: []),
		h.span(
			[
				h.Class(
					cn(
						badgeVariants({
							variant: "outline",
							className: cn("font-mono text-2xs text-white border-0 shrink-0", queryBadgeColor(index)),
						}),
					),
				),
				h.DataAttribute("slot", "badge"),
			],
			[query.name],
		),
	]
	const actions = (label: string, message: Message, isDisabled: boolean) =>
		button(h, { variant: "ghost", size: "xs", isDisabled, attributes: [h.OnClick(message)] }, [label])
	const trailing = [
		h.div([h.Class("flex-1")], []),
		...(inputs.hasHeaderActions
			? [
					actions("Clone", Message.ClickedClone({ queryId: query.id }), false),
					actions("Remove", Message.ClickedRemove({ queryId: query.id }), !inputs.canRemove),
				]
			: []),
	]
	return panelSelect(
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
				h.div([h.Class("flex items-center gap-2 px-3 py-2 bg-surface-sunken")], [...leading, ...parts, ...trailing]),
		},
	)
}

const SPAN_OPTIONS = [
	{ value: "all", label: "All Spans" },
	{ value: "root", label: "Root Spans" },
]

/** `TracesLogsBody`, or `MetricsBody` for a metrics query. */
const body = (h: H, model: Model, inputs: QueryPanelInputs): ReadonlyArray<Html> => {
	const { query, intervalPlaceholder } = inputs
	if (query.dataSource === "metrics")
		return metricsBody(h, model, query, {
			options: inputs.metricOptions ?? [],
			searchTerm: inputs.metricSearch ?? "",
			breakdownKeys: inputs.metricBreakdownKeys ?? [],
			intervalPlaceholder,
			autocompleteValues: inputs.autocompleteValues ?? {},
		})
	const whereRow = (parts: ReadonlyArray<Html>) =>
		h.div(
			[h.Class("flex items-start gap-2")],
			[whereClauseEditor(h, model, query, inputs.autocompleteValues ?? {}), ...parts],
		)
	return [
		query.dataSource === "traces"
			? panelSelect(
					h,
					model,
					`spans:${query.id}`,
					query.whereClause.includes("root_only = true") ? "root" : "all",
					SPAN_OPTIONS,
					{ size: "sm", className: "w-32 shrink-0", toView: whereRow },
				)
			: whereRow([]),
		panelSelect(h, model, `aggregation:${query.id}`, query.aggregation, aggregationOptions(query), {
			size: "sm",
			className: "w-40",
			toView: (parts) =>
				h.div(
					[h.Class("flex items-center gap-2 flex-wrap")],
					[
						...parts,
						h.span([h.Class("text-xs text-muted-foreground")], ["every"]),
						textInput(h, `step-${query.id}`, query.stepInterval, intervalPlaceholder, "h-8 w-24 text-xs", (value) =>
							Message.ChangedText({ queryId: query.id, field: "stepInterval", value }),
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
						[h.ul([h.Class("space-y-1")], warnings.map((warning) => h.li([], [warning])))],
						"text-severity-warn",
					),
				]),
			]

/** One query's panel; the host renders it with `h.submodel` and applies its `OutMessage`s. */
export const queryPanelView = Submodel.defineView<Model, Message, QueryPanelInputs>((model, inputs, h) => {
	const { query } = inputs
	const content = () => [
		...body(h, model, inputs),
		// TODO(query-builder): the product-events setup hint (`SignalEmptyState`).
		...warningList(h, buildTimeseriesQuerySpec(query).warnings),
		addOnToggles(h, query, ADD_ON_KEYS),
		...addOnSections(h, model, query),
	]
	return h.div(
		[h.Class("border rounded-md")],
		[
			header(h, model, inputs),
			...(model.collapsed.includes(query.id) ? [] : [h.div([h.Class("p-3 space-y-3")], content())]),
		],
	)
})
