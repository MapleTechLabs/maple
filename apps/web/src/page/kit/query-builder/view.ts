import {
	AGGREGATIONS_BY_SOURCE,
	buildTimeseriesQuerySpec,
	getMetricsAggregations,
	queryBadgeColor,
} from "@maple/query-engine/query-builder"
import { QUERY_BUILDER_DATA_SOURCES } from "@maple/query-model"
import type { WhereClauseAutocompleteValues } from "../../../lib/query-builder/where-clause-autocomplete"
import { cn } from "@maple/ui/lib/utils"
import { badgeVariants } from "@maple/views/ui/badge.styles"
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
import { unshowableReasonOf } from "./condition-rows"
import { panelSelect } from "./panel-select"
import { addOnSections, ADD_ON_KEYS, addOnToggles, textInput, whereClauseEditor } from "./parts"
import { Array as Arr, Option, String as Str } from "effect"

// One query's builder panel and its frame.

type H = HtmlBuilder<Message>

export type QueryPanelInputs = Readonly<{
	query: QueryDraft
	index: number
	canRemove: boolean
	/** `Auto (2m)` in the interval placeholder, or `Auto`. */
	intervalPlaceholder: string
	/** Clone / Remove in the header. */
	hasHeaderActions: boolean
	/** The "include in the chart" checkbox. */
	hasVisibilityToggle: boolean
	/** The metric list page for a metrics query; none until fetched. */
	metricOptions?: ReadonlyArray<MetricOption>
	/** What the metric picker last searched for. */
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
								"font-mono text-2xs text-on-fill border-0 shrink-0",
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
	// The span select rides with the editor's Builder/Text switch, top right of the where area.
	const whereRow = (parts: ReadonlyArray<Html>) =>
		whereClauseEditor(h, model, query, inputs.autocompleteValues ?? {}, {
			className: "min-w-0",
			trailing: parts,
		})
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

// The engine's warning for a dropped OR group ends in the group's text: which filter is missing.
const OR_GROUP_DROPPED = /OR group ignored: only attribute filters can be OR-ed: (.+)$/s
const OR_RULE = "Only attribute filters can be OR-ed."

/**
 * The engine's warnings in the panel's words: a dropped OR group names its group, one line per
 * distinct group. `isRuleStated`: the editor's note already says the field can't be OR-ed.
 */
export const panelWarningsOf = (
	warnings: ReadonlyArray<string>,
	options: Readonly<{ isRuleStated?: boolean }> = {},
): ReadonlyArray<string> =>
	Arr.dedupe(
		Arr.map(warnings, (warning) =>
			Option.match(
				Option.flatMap(Str.match(OR_GROUP_DROPPED)(warning), (match) =>
					Option.fromNullishOr(match[1]),
				),
				{
					onNone: () => warning,
					onSome: (group) =>
						options.isRuleStated === true
							? `This OR group is not applied: ${group}.`
							: `This OR group is not applied: ${group}. ${OR_RULE}`,
				},
			),
		),
	)

/** Clauses the builder could not apply as written. */
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
		// TODO(query-builder): the product-events setup hint (a signal empty state).
		...warningList(
			h,
			panelWarningsOf(buildTimeseriesQuerySpec(query).warnings, {
				isRuleStated: Option.contains(
					unshowableReasonOf(query.whereClause, query.dataSource),
					"orNotApplied",
				),
			}),
		),
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
