import { getMetricsAggregations } from "@maple/query-engine/query-builder"
import type { WhereClauseAutocompleteValues } from "../../../lib/query-builder/where-clause-autocomplete"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Combobox from "@maple/views/ui/combobox"
import * as ComboboxView from "@maple/views/ui/combobox-view"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { typography } from "@maple/views/ui/typography"
import {
	defaultSpaceAggregation,
	MAX_METRICS_GROUP_BY_KEYS,
	type MetricsMetric,
} from "@maple/domain/query-engine"
import { QUERY_BUILDER_SPACE_AGGREGATIONS } from "@maple/query-model"
import { groupBySelectionOf, type QueryDraft } from "./draft"
import { Message, metricInputText, metricPickerIdOf, type Model } from "./panel"
import { panelSelect, textInput, whereClauseEditor } from "./parts"
import { Array as Arr, Schema, String as Str, Option } from "effect"

// `MetricsBody`: the metric picker, the where clause, and the two aggregation stages:
// each series reduced within the interval, then the series combined by any number of fields.
// The where editor's values are scoped to the picked metric (`useMetricScopedAutocomplete`).

/** A metric's own keys: data-point labels and resource attributes. */
export const MetricKeysSchema = Schema.Struct({
	attributes: Schema.Array(Schema.String),
	resources: Schema.Array(Schema.String),
})
export type MetricKeys = typeof MetricKeysSchema.Type

type H = HtmlBuilder<Message>
type MetricsQuery = Extract<QueryDraft, { dataSource: "metrics" }>

export type MetricOption = Readonly<{ value: string; label: string; isMonotonic: boolean }>

/** A combobox kept by query id; closed, its input reads the option label (`name (type)`), not the `name::type` key. */
const comboOf = (stored: Combobox.Model | undefined, id: string, value: string): Combobox.Model => {
	const current = stored ?? Combobox.init(id, "single")
	return {
		...current,
		selected: value === "" ? [] : [value],
		inputValue: current.isOpen ? current.inputValue : metricInputText(value),
	}
}

/** The fetched page, with the draft's metric kept selectable when the page lacks it. */
const optionsWith = (query: MetricsQuery, value: string, options: ReadonlyArray<MetricOption>) =>
	value === "" || Arr.some(options, (option) => option.value === value)
		? options
		: [
				{ value, label: `${query.metricName} (${query.metricType})`, isMonotonic: query.isMonotonic },
				...options,
			]

const picker = (
	h: H,
	model: Model,
	query: MetricsQuery,
	options: ReadonlyArray<MetricOption>,
	searchTerm: string,
): Html => {
	const value = query.metricName === "" ? "" : `${query.metricName}::${query.metricType}`
	const listed = optionsWith(query, value, options)
	const term = Str.trim(searchTerm)
	return h.submodel({
		slotId: `${model.slotPrefix}-metric-${query.id}`,
		model: comboOf(model.metricPickers[query.id], metricPickerIdOf(query.id), value),
		view: ComboboxView.view,
		toParentMessage: (message) => Message.GotMetricMessage({ queryId: query.id, value, message }),
		viewInputs: {
			items: Arr.map(listed, (option) => option.value),
			placeholder: "Search metrics…",
			// `MetricOptionsEmpty` replaces the list only when nothing is listed.
			emptyText:
				listed.length > 0
					? ""
					: term === ""
						? "No metrics found"
						: `No metric name contains "${term}"`,
			highlightsSelected: true,
			// Measured: the positioner resolves the input (30 px), not the input group.
			anchorsInput: true,
			renderItem: (item) => [
				Option.getOrElse(
					Option.map(
						Arr.findFirst(listed, (option) => option.value === item),
						(option) => option.label,
					),
					() => item,
				),
			],
			isUnfiltered: true,
			className: "h-8 flex-1 text-xs",
			toView: ({ field, rest }) =>
				h.div(
					[h.Class("flex items-center gap-2")],
					[h.span([h.Class("text-xs text-muted-foreground shrink-0")], ["Metric"]), field, ...rest],
				),
		},
	})
}

/** The fields the series are combined by: any of the metric's labels, resources, or its service. */
const isKeyField = (field: string): boolean =>
	Str.startsWith("attr.")(field) || Str.startsWith("resource.")(field)

/**
 * What the picker offers next and what it says when nothing is left: once the
 * query groups by as many attr.* and resource.* keys as it can use, no more are
 * offered, so the chips always match what the query groups by.
 */
export const groupByChoicesOf = (
	offered: ReadonlyArray<string>,
	selected: ReadonlyArray<string>,
): Readonly<{ items: ReadonlyArray<string>; emptyText: string }> => {
	const isFull = Arr.filter(selected, isKeyField).length >= MAX_METRICS_GROUP_BY_KEYS
	return {
		items: Arr.filter(offered, (field) => !selected.includes(field) && !(isFull && isKeyField(field))),
		// The list is empty for a search with no match too; only say "all" or "at most" when it is true.
		emptyText: Arr.every(offered, (field) => selected.includes(field))
			? "All fields selected"
			: isFull
				? `At most ${MAX_METRICS_GROUP_BY_KEYS} attribute fields`
				: "No fields found",
	}
}

const groupByFields = (h: H, model: Model, query: MetricsQuery, keys: MetricKeys): Html => {
	const selected = groupBySelectionOf(query)
	const current = model.groupBys[query.id] ?? Combobox.init(`group-by-${query.id}`, "multiple")
	const offered = Arr.dedupe([
		"service.name",
		...Arr.map(keys.attributes, (key) => `attr.${key}`),
		...Arr.map(keys.resources, (key) => `resource.${key}`),
	])
	const choices = groupByChoicesOf(offered, selected)
	return h.submodel({
		slotId: `${model.slotPrefix}-group-by-${query.id}`,
		model: { ...current, selected },
		view: ComboboxView.chipsView,
		toParentMessage: (message) => Message.GotGroupByMessage({ queryId: query.id, message }),
		viewInputs: {
			items: choices.items,
			placeholder: selected.length === 0 ? "Everything (no breakdown)" : "",
			ariaLabel: "Group series by",
			emptyText: choices.emptyText,
			className: "text-xs font-mono",
			toView: (parts) => h.div([h.Class("flex-1 min-w-[220px]")], parts),
		},
	})
}

const SPACE_OPTIONS = Arr.map(QUERY_BUILDER_SPACE_AGGREGATIONS, (value) => ({ value, label: value }))

const aggregationRow = (
	h: H,
	model: Model,
	query: MetricsQuery,
	select: Readonly<{
		field: "aggregation" | "aggregation-across"
		value: string
		options: ReadonlyArray<{ value: string; label: string }>
	}>,
	label: string,
	tail: ReadonlyArray<Html>,
): Html =>
	panelSelect(h, model, `${select.field}:${query.id}`, select.value, select.options, {
		size: "sm",
		className: "w-24",
		toView: (parts) =>
			h.div(
				[h.Class("flex items-center gap-2 flex-wrap")],
				[eyebrow(h, { className: "shrink-0" }, [label]), ...parts, ...tail],
			),
	})

export const metricsBody = (
	h: H,
	model: Model,
	query: MetricsQuery,
	inputs: Readonly<{
		options: ReadonlyArray<MetricOption>
		searchTerm: string
		breakdownKeys: MetricKeys
		intervalPlaceholder: string
		autocompleteValues: WhereClauseAutocompleteValues
	}>,
): ReadonlyArray<Html> => [
	picker(h, model, query, inputs.options, inputs.searchTerm),
	whereClauseEditor(h, model, query, inputs.autocompleteValues, {
		placeholder: 'service.name = "my-service"',
		className: "relative",
	}),
	aggregationRow(
		h,
		model,
		query,
		{
			field: "aggregation",
			value: query.aggregation,
			options: getMetricsAggregations(query.metricType, query.isMonotonic),
		},
		"Aggregate within time series",
		[
			typography(h, { size: "xs", tone: "muted" }, ["every"]),
			textInput(
				h,
				`step-${query.id}`,
				query.stepInterval,
				inputs.intervalPlaceholder,
				"h-8 w-24 text-xs",
				(value) => Message.ChangedText({ queryId: query.id, field: "stepInterval", value }),
			),
			typography(h, { size: "xs", tone: "muted" }, ["seconds"]),
		],
	),
	isHistogram(query)
		? h.div(
				[h.Class("flex items-center gap-2 flex-wrap")],
				[
					eyebrow(h, { className: "shrink-0" }, ["Merge histograms"]),
					typography(h, { size: "xs", tone: "muted" }, ["by"]),
					groupByFields(h, model, query, inputs.breakdownKeys),
				],
			)
		: aggregationRow(
				h,
				model,
				query,
				{
					field: "aggregation-across",
					value:
						query.spaceAggregation ?? defaultSpaceAggregation(query.aggregation as MetricsMetric),
					options: SPACE_OPTIONS,
				},
				"Aggregate across time series",
				[
					typography(h, { size: "xs", tone: "muted" }, ["by"]),
					groupByFields(h, model, query, inputs.breakdownKeys),
				],
			),
]

// Histogram buckets merge across series; there is no per-series value to combine.
const isHistogram = (query: MetricsQuery): boolean =>
	query.metricType === "histogram" || query.metricType === "exponential_histogram"
