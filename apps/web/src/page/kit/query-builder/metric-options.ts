import {
	QUERY_BUILDER_METRIC_TYPES,
	type QueryBuilderMetricType,
	toQueryBuilderMetricType,
} from "@maple/query-model"
import { getMetricAttributeKeys, listMetrics } from "@maple/web-data/warehouse/metrics"
import { Effect, Schema, Array as Arr, String as Str, Option } from "effect"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { QueryChange } from "./change"
import type { QueryDraft } from "./draft"
import type { MetricKeys } from "./metrics-body"

// The metric picker's reads, shared by every host of a metrics `QueryPanel`: one page of the
// org's metrics for what was searched, and each picked metric's own keys.

/** One metric picker entry: `name::type`, its label, and whether a sum is monotonic. */
export const MetricOptionSchema = Schema.Struct({
	value: Schema.String,
	label: Schema.String,
	isMonotonic: Schema.Boolean,
})
export type MetricOption = typeof MetricOptionSchema.Type

/** One `listMetrics` page: the picker's options and every row's service (`metricServices`). */
export const MetricPageSchema = Schema.Struct({
	options: Schema.Array(MetricOptionSchema),
	services: Schema.Array(Schema.String),
})
export type MetricPage = typeof MetricPageSchema.Type

export type MetricRef = Readonly<{ metricName: string; metricType: QueryBuilderMetricType }>

/** A metric's picker value and the key its fetched keys are kept under. */
export const metricValueOf = (metric: MetricRef): string => `${metric.metricName}::${metric.metricType}`

/** `listMetricsResultAtom({ data: { limit: 100, search } })`, reduced to picker options. */
export const listMetricOptions = (search: string) =>
	listMetrics({ data: { limit: 100, ...(search === "" ? undefined : { search }) } }).pipe(
		Effect.mapBoth({
			onSuccess: (response): MetricPage => ({
				options: Arr.dedupeWith(
					Arr.map(
						Arr.filter(response.data, (row) => toQueryBuilderMetricType(row.metricType) !== null),
						(row) => ({
							value: `${row.metricName}::${row.metricType}`,
							label: `${row.metricName} (${row.metricType})`,
							isMonotonic: row.isMonotonic,
						}),
					),
					(option: MetricOption, other: MetricOption) => option.value === other.value,
				),
				// `toNames`: trimmed, non-empty, each once.
				services: Arr.dedupeWith(
					Arr.filter(
						Arr.map(response.data, (row) => Str.trim(row.serviceName)),
						(name) => name !== "",
					),
					(name, other) => name === other,
				),
			}),
			onFailure: toLoadFailure,
		}),
	)

/** The metric's data-point and resource keys over the last 24 h, read together. */
export const readMetricKeys = ({ metricName, metricType }: MetricRef) =>
	Effect.all(
		{
			attributes: getMetricAttributeKeys({ data: { metricName, metricType } }),
			// Resource keys only add to the picker: their failure must not empty the label keys too.
			resources: getMetricAttributeKeys({ data: { metricName, metricType, scope: "resource" } }).pipe(
				Effect.orElseSucceed(() => ({ data: [] })),
			),
		},
		{ concurrency: 2 },
	).pipe(
		Effect.mapBoth({
			onSuccess: ({ attributes, resources }): MetricKeys => ({
				attributes: Arr.map(attributes.data, (row) => row.attributeKey),
				resources: Arr.map(resources.data, (row) => row.attributeKey),
			}),
			onFailure: toLoadFailure,
		}),
	)

/** The metrics the queries picked whose keys were not asked for yet, each once. */
export const unaskedMetrics = (
	queries: ReadonlyArray<QueryDraft>,
	requested: ReadonlyArray<string>,
): ReadonlyArray<MetricRef> =>
	Arr.filter(
		Arr.dedupeWith(
			Arr.flatMap(queries, (query): ReadonlyArray<MetricRef> =>
				query.dataSource === "metrics" && query.metricName !== ""
					? [{ metricName: query.metricName, metricType: query.metricType }]
					: [],
			),
			(metric: MetricRef, other: MetricRef) => metricValueOf(metric) === metricValueOf(other),
		),
		(metric) => !requested.includes(metricValueOf(metric)),
	)

/** `parseMetricSelection`: `name::type` back into the metric it names. */
export const pickedMetric = (value: string, options: ReadonlyArray<MetricOption>): QueryChange | null => {
	const [metricName, rawType = ""] = Str.split("::")(value)
	const foundType = Arr.findFirst(QUERY_BUILDER_METRIC_TYPES, (type) => type === rawType)
	if (metricName === "" || Option.isNone(foundType)) return null
	const metricType = foundType.value
	const isMonotonic = Arr.findFirst(options, (option) => option.value === value).pipe(
		Option.flatMapNullishOr((found) => found.isMonotonic),
		Option.getOrElse(() => metricType === "sum"),
	)
	return QueryChange.SetMetric({ metricName, metricType, isMonotonic })
}
