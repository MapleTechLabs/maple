// Metrics spec → PromQL for Google Cloud Monitoring's Prometheus-compatible API.
//
// Google flattens metric and resource labels onto one label set, so `attr.X` and `resource.X`
// both read the label `X`. A metric written for several monitored resource types only answers a
// selector with an exact `monitored_resource` matcher, so each type gets its own range function
// and the outer aggregation unions them with `or`. Every aggregation keeps `project_id`: the
// engine reads each project separately and combines a group's projects itself (`GcpPromQl.merge`).

import { DateTime, Effect } from "effect"
import { absurd } from "effect/Function"
import type { GcpMetricDescriptor } from "@maple/domain/gcp-live-metrics"
import { gcpMetricMapleType } from "@maple/domain/gcp-live-metrics"
import { QueryEngineValidationError } from "@maple/domain/http"
import type {
	AttributeFilter,
	AttributeFilterLeaf,
	MetricsFilters,
	MetricsMetric,
} from "@maple/domain/query-engine"

/** A Google Cloud metrics query the engine cannot run, the reason as its message. */
export const reject = (message: string) => new QueryEngineValidationError({ message, details: [] })

/** A double-quoted PromQL string literal. */
export const promQlString = (value: string): string =>
	`"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`

const PLAIN_LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const labelName = (name: string): string => (PLAIN_LABEL.test(name) ? name : promQlString(name))

const escapeRegex = (value: string): string => value.replace(/[\\.+*?()|[\]{}^$]/g, "\\$&")
const anyOf = (values: ReadonlyArray<string>): string => `(?:${values.map(escapeRegex).join("|")})`

interface Matcher {
	readonly label: string
	readonly op: "=" | "!=" | "=~" | "!~"
	readonly value: string
}

const renderSelector = (metricName: string, matchers: ReadonlyArray<Matcher>): string =>
	`{${[promQlString(metricName), ...matchers.map((m) => `${labelName(m.label)}${m.op}${promQlString(m.value)}`)].join(", ")}}`

/** The values of a plain positive `equals` / `in` filter, else undefined. */
const positiveValues = (filter: AttributeFilterLeaf): ReadonlyArray<string> | undefined => {
	if (filter.negated) return undefined
	if (filter.mode === "equals") return [filter.value ?? ""]
	if (filter.mode === "in") return filter.values ?? []
	return undefined
}

const leafMatcher = (filter: AttributeFilterLeaf): Effect.Effect<Matcher, QueryEngineValidationError> => {
	const label = filter.key
	const negated = filter.negated === true
	switch (filter.mode) {
		case "equals":
			return Effect.succeed({ label, op: negated ? "!=" : "=", value: filter.value ?? "" })
		case "in":
			return Effect.succeed({ label, op: negated ? "!~" : "=~", value: anyOf(filter.values ?? []) })
		case "contains":
			return Effect.succeed({
				label,
				op: negated ? "!~" : "=~",
				value: `.*${escapeRegex(filter.value ?? "")}.*`,
			})
		case "exists":
			return Effect.succeed(negated ? { label, op: "=", value: "" } : { label, op: "=~", value: ".+" })
		default:
			return Effect.fail(
				reject(
					`Label ${label} cannot be compared with ${filter.mode}: Google Cloud labels are strings`,
				),
			)
	}
}

const filterMatcher = (filter: AttributeFilter): Effect.Effect<Matcher, QueryEngineValidationError> => {
	if (!filter.or?.length) return leafMatcher(filter)
	const alternatives = [filter, ...filter.or]
	const values = alternatives.map((alternative) =>
		alternative.key === filter.key ? positiveValues(alternative) : undefined,
	)
	if (values.some((v) => v === undefined)) {
		return Effect.fail(
			reject(`OR filters on Google Cloud metrics must all be equals/in on one label (${filter.key})`),
		)
	}
	return Effect.succeed({ label: filter.key, op: "=~", value: anyOf(values.flatMap((v) => v ?? [])) })
}

const labelFilters = (filters: MetricsFilters): ReadonlyArray<AttributeFilter> => [
	...(filters.attributeFilters ?? []),
	...(filters.resourceAttributeFilters ?? []),
]

/**
 * The projects a plain positive `project_id` filter names, which the engine reads instead of
 * all; undefined reads all. Narrowing only: the filter's matcher stays in the query.
 */
export const gcpFilterProjects = (filters: MetricsFilters): ReadonlyArray<string> | undefined => {
	let projects: ReadonlyArray<string> | undefined
	for (const filter of labelFilters(filters)) {
		const values = filter.key === "project_id" && !filter.or?.length ? positiveValues(filter) : undefined
		if (values?.length) projects = values
	}
	return projects
}

/** `fn` over one selector of `metricName` per monitored resource type, unioned with `or`. */
type Union = (metricName: string, fn: string, windowSeconds: number) => string

const compileUnion = Effect.fnUntraced(function* (
	descriptor: GcpMetricDescriptor,
	filters: ReadonlyArray<AttributeFilter>,
) {
	const matchers: Matcher[] = []
	let resourceTypes: ReadonlyArray<string> | undefined
	for (const filter of filters) {
		// ClickHouse's `IN ()` matches nothing; the empty regex would match series without the label.
		const empty = [filter, ...(filter.or ?? [])].find(
			(leaf) => leaf.mode === "in" && !leaf.values?.length,
		)
		if (empty !== undefined) return yield* reject(`The in filter on ${empty.key} lists no values`)
		const values = filter.or?.length ? undefined : positiveValues(filter)
		if (filter.key === "monitored_resource" && values) {
			resourceTypes = values
			continue
		}
		matchers.push(yield* filterMatcher(filter))
	}
	const types = resourceTypes ?? descriptor.monitoredResourceTypes
	if (types.length === 0) {
		return yield* reject(
			`Google Cloud lists no monitored resource for ${descriptor.type}; filter on monitored_resource (e.g. resource.monitored_resource = cloudsql_database)`,
		)
	}
	const union: Union = (metricName, fn, windowSeconds) =>
		types
			.map(
				(type) =>
					`${fn}(${renderSelector(metricName, [{ label: "monitored_resource", op: "=", value: type }, ...matchers])}[${windowSeconds}s])`,
			)
			.join(" or ")
	return union
})

/** The `by` labels: the group's, and always `project_id`. */
const byLabels = (groupLabel: string | undefined): string =>
	groupLabel === undefined || groupLabel === "project_id"
		? "project_id"
		: `${labelName(groupLabel)}, project_id`

/** The series discovery and sample counts read: a distribution answers as `_count` / `_sum`. */
const seriesName = (descriptor: GcpMetricDescriptor): string =>
	descriptor.valueType === "DISTRIBUTION" ? `${descriptor.type}_count` : descriptor.type

/** An average's two parts, each summed across projects before the engine divides them. */
const avgParts = (sum: string, count: string) =>
	`label_replace(${sum}, "maple_part", "sum", "", "") or label_replace(${count}, "maple_part", "count", "", "")`

export interface GcpPromQlRequest {
	readonly metric: MetricsMetric
	readonly filters: MetricsFilters
	/** Flat label the result is grouped by; undefined is one ungrouped series. */
	readonly groupLabel: string | undefined
	/** Range-function window, in seconds: the step, or the whole range for an instant query. */
	readonly windowSeconds: number
}

export interface GcpPromQl {
	readonly query: string
	/**
	 * How the engine combines a group's series across projects. `avg` answers as two parts,
	 * `maple_part="sum"` and `maple_part="count"`, and is their summed ratio.
	 */
	readonly merge: "sum" | "min" | "max" | "avg"
}

/** One value per group per evaluation step, matching the ClickHouse metrics semantics. */
export const compileGcpMetricQuery = Effect.fnUntraced(function* (
	request: GcpPromQlRequest,
	descriptor: GcpMetricDescriptor,
) {
	const { filters, metric } = request
	if (filters.serviceName !== undefined) {
		return yield* reject(
			"Google Cloud metrics have no service.name; filter on a label such as service_name or project_id",
		)
	}
	if (filters.environments?.length) {
		return yield* reject(
			"Google Cloud metrics have no deployment.environment; filter on a label such as project_id",
		)
	}
	if (gcpMetricMapleType(descriptor) === undefined) {
		return yield* reject(`${descriptor.type} has ${descriptor.valueType} values, which cannot be charted`)
	}

	const union = yield* compileUnion(descriptor, labelFilters(filters))
	const w = request.windowSeconds
	const by = byLabels(request.groupLabel)
	const aggregate = (aggregation: string, metricName: string, fn: string, window = w) =>
		`${aggregation} by (${by}) (${union(metricName, fn, window)})`

	// A cumulative counter needs two samples in its window, so its rate reads at least two
	// minutes, and its increase is that rate times the step: adjacent steps' `increase` windows
	// would overlap and count a sample twice.
	const cumulative = descriptor.metricKind === "CUMULATIVE"
	const counterWindow = Math.max(w, 120)
	// A delta counter's samples are already increments: summing them is exact, unlike `increase`.
	const total = (metricName: string) =>
		cumulative
			? `${aggregate("sum", metricName, "rate", counterWindow)} * ${w}`
			: aggregate("sum", metricName, "sum_over_time")
	const perSecond = (metricName: string) =>
		cumulative ? aggregate("sum", metricName, "rate", counterWindow) : `${total(metricName)} / ${w}`

	const type = descriptor.type
	if (descriptor.valueType === "DISTRIBUTION") {
		switch (metric) {
			case "min":
			case "max":
				return yield* reject(
					`${metric} is not available for the distribution ${type}; use avg, sum, count or rate`,
				)
			case "avg":
				return {
					query: avgParts(total(`${type}_sum`), total(`${type}_count`)),
					merge: "avg",
				} satisfies GcpPromQl
			case "sum":
				return { query: total(`${type}_sum`), merge: "sum" } satisfies GcpPromQl
			case "count":
			case "increase":
				return { query: total(`${type}_count`), merge: "sum" } satisfies GcpPromQl
			case "rate":
				return { query: perSecond(`${type}_count`), merge: "sum" } satisfies GcpPromQl
			default:
				return absurd<GcpPromQl>(metric)
		}
	}

	const gauge = descriptor.metricKind === "GAUGE"
	switch (metric) {
		case "avg":
			return {
				query: avgParts(
					aggregate("sum", type, "avg_over_time"),
					aggregate("count", type, "avg_over_time"),
				),
				merge: "avg",
			} satisfies GcpPromQl
		case "min":
		case "max":
			return {
				query: aggregate(metric, type, `${metric}_over_time`),
				merge: metric,
			} satisfies GcpPromQl
		case "count":
			return { query: aggregate("sum", type, "count_over_time"), merge: "sum" } satisfies GcpPromQl
		case "sum":
			return { query: total(type), merge: "sum" } satisfies GcpPromQl
		case "increase":
			return {
				query: gauge ? aggregate("sum", type, "increase") : total(type),
				merge: "sum",
			} satisfies GcpPromQl
		case "rate":
			return {
				query: gauge ? aggregate("sum", type, "rate") : perSecond(type),
				merge: "sum",
			} satisfies GcpPromQl
		default:
			return absurd<GcpPromQl>(metric)
	}
})

/** Samples per group per step, an alert's sample count: a distribution's are its `_count` samples. */
export const compileGcpSampleCount = Effect.fnUntraced(function* (
	request: GcpPromQlRequest,
	descriptor: GcpMetricDescriptor,
) {
	const union = yield* compileUnion(descriptor, labelFilters(request.filters))
	return {
		query: `sum by (${byLabels(request.groupLabel)}) (${union(seriesName(descriptor), "count_over_time", request.windowSeconds)})`,
		merge: "sum",
	} satisfies GcpPromQl
})

/** A few recent series of the metric, to read which labels it carries. */
export const compileGcpLabelSample = Effect.fnUntraced(function* (descriptor: GcpMetricDescriptor) {
	const union = yield* compileUnion(descriptor, [])
	return `topk(5, ${union(seriesName(descriptor), "last_over_time", 3_600)})`
})

/** Series per value of one label (and project) over the window. */
export const compileGcpLabelValues = Effect.fnUntraced(function* (
	descriptor: GcpMetricDescriptor,
	label: string,
	windowSeconds: number,
) {
	const union = yield* compileUnion(descriptor, [])
	return `count by (${byLabels(label)}) (${union(seriesName(descriptor), "last_over_time", windowSeconds)})`
})

/**
 * Range-query bounds for a bucketed timeseries. Google evaluates a point at `t` over
 * `(t - step, t]` while Maple labels a bucket by its start, so the query runs from the first
 * bucket's end to the last bucket's end and a point at `t` belongs to the bucket at `t - step`.
 * The last bucket's end may lie in the future; Google answers it with what has arrived so far.
 */
export const gcpRangeWindow = (startMs: number, endMs: number, bucketSeconds: number) => {
	const stepSeconds = Math.max(60, bucketSeconds)
	const firstBucket = Math.floor(startMs / 1000 / stepSeconds) * stepSeconds
	const lastBucket = Math.floor(endMs / 1000 / stepSeconds) * stepSeconds
	return { stepSeconds, startSeconds: firstBucket + stepSeconds, endSeconds: lastBucket + stepSeconds }
}

/** The ISO bucket a range-query point at `pointSeconds` belongs to. */
export const gcpPointBucket = (pointSeconds: number, stepSeconds: number): string =>
	DateTime.formatIso(DateTime.makeUnsafe((pointSeconds - stepSeconds) * 1000))
