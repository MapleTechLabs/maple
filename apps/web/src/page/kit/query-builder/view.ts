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
import { alert, alertDescription } from "@maple/views/ui/alert"
import { button } from "@maple/views/ui/button"
import * as Checkbox from "@maple/views/ui/checkbox"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { hstack } from "@maple/views/ui/stack"
import type { SelectOption } from "@maple/views/ui/select-view"
import type { QueryDraft } from "./draft"
import { Message, type Model } from "./panel"
import type { MetricOption } from "./metric-options"
import { type MetricKeys, metricsBody } from "./metrics-body"
import { addOnSections, ADD_ON_KEYS, addOnToggles, panelSelect, textInput, whereClauseEditor } from "./parts"
import { Array as Arr, String as Str } from "effect"

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
	/** The picked metric's keys, offered as `attr.<key>` and `resource.<key>` group-bys. */
	metricBreakdownKeys?: MetricKeys | undefined
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
	const actions = (label: string, message: Message, isDisabled: boolean) =>
		button(h, { variant: "ghost", size: "xs", isDisabled, attributes: [h.OnClick(message)] }, [label])
	// One group, so on a narrow screen Clone and Remove wrap together and stay right-aligned.
	const trailing = inputs.hasHeaderActions
		? [
				hstack(h, { gap: "2", className: "ml-auto" }, [
					actions("Clone", Message.ClickedClone({ queryId: query.id }), false),
					actions("Remove", Message.ClickedRemove({ queryId: query.id }), !inputs.canRemove),
				]),
			]
		: []
	return panelSelect(
		h,
		model,
		`source:${query.id}`,
		query.dataSource,
		Arr.map(QUERY_BUILDER_DATA_SOURCES, (value) => ({ value, label: SOURCE_LABEL[value] })),
		{
			size: "sm",
			className: "w-36 border-none bg-transparent shadow-none px-1",
			ariaLabel: "Query source",
			toView: (parts) =>
				h.div(
					[h.Class("flex flex-wrap items-center gap-2 px-3 py-2 bg-surface-sunken")],
					[...leading, ...parts, ...trailing],
				),
		},
	)
}

const SPAN_OPTIONS = [
	{ value: "all", label: "All spans" },
	{ value: "root", label: "Root spans" },
]

/** `TracesLogsBody`, or `MetricsBody` for a metrics query. */
const body = (h: H, model: Model, inputs: QueryPanelInputs): ReadonlyArray<Html> => {
	const { query, intervalPlaceholder } = inputs
	if (query.dataSource === "metrics")
		return metricsBody(h, model, query, {
			options: inputs.metricOptions ?? [],
			searchTerm: inputs.metricSearch ?? "",
			breakdownKeys: inputs.metricBreakdownKeys ?? { attributes: [], resources: [] },
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
					Str.includes("root_only = true")(query.whereClause) ? "root" : "all",
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
						textInput(
							h,
							`step-${query.id}`,
							query.stepInterval,
							intervalPlaceholder,
							"h-8 w-24 text-xs",
							(value) =>
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
						[
							h.ul(
								[h.Class("space-y-1")],
								Arr.map(warnings, (warning) => h.li([], [warning])),
							),
						],
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
		// A metrics query groups from its "across" row; a Group by toggle would only hide that choice.
		addOnToggles(
			h,
			query,
			query.dataSource === "metrics"
				? Arr.filter(ADD_ON_KEYS, ({ key }) => key !== "groupBy")
				: ADD_ON_KEYS,
		),
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
