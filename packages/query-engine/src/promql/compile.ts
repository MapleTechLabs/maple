// Metrics spec → PromQL for Google Cloud Monitoring's Prometheus-compatible API.
//
// Google flattens metric and resource labels onto one label set, so `attr.X` and `resource.X`
// both read the label `X`. A metric written for several monitored resource types only answers a
// selector with an exact `monitored_resource` matcher, so each type gets its own range function
// and the outer aggregation unions them with `or`.

import { DateTime, Effect } from "effect"
import type { GcpMetricDescriptor, GcpMetricKind } from "@maple/domain/gcp-live-metrics"
import { gcpMetricMapleType } from "@maple/domain/gcp-live-metrics"
import { QueryEngineValidationError } from "@maple/domain/http"
import type {
	AttributeFilter,
	AttributeFilterLeaf,
	MetricsFilters,
	MetricsMetric,
} from "@maple/domain/query-engine"

const reject = (detail: string) =>
	new QueryEngineValidationError({ message: "Unsupported Google Cloud metrics query", details: [detail] })

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

interface Scope {
	/** One selector per monitored resource type, for the given series name. */
	readonly selectors: (metricName: string) => ReadonlyArray<string>
	readonly projects?: ReadonlyArray<string>
}

const compileScope = Effect.fnUntraced(function* (
	descriptor: GcpMetricDescriptor,
	filters: ReadonlyArray<AttributeFilter>,
) {
	const matchers: Matcher[] = []
	let resourceTypes: ReadonlyArray<string> | undefined
	let projects: ReadonlyArray<string> | undefined
	for (const filter of filters) {
		const values = filter.or?.length ? undefined : positiveValues(filter)
		if (filter.key === "monitored_resource" && values) {
			resourceTypes = values
			continue
		}
		if (filter.key === "project_id" && values) projects = values
		matchers.push(yield* filterMatcher(filter))
	}
	const types = resourceTypes ?? descriptor.monitoredResourceTypes
	if (types.length === 0) {
		return yield* reject(
			`Google Cloud lists no monitored resource for ${descriptor.type}; filter on monitored_resource (e.g. resource.monitored_resource = cloudsql_database)`,
		)
	}
	return {
		selectors: (metricName) =>
			types.map((type) =>
				renderSelector(metricName, [
					{ label: "monitored_resource", op: "=", value: type },
					...matchers,
				]),
			),
		...(projects === undefined ? undefined : { projects }),
	} satisfies Scope
})

const rangeFunction = (kind: GcpMetricKind, metric: MetricsMetric): string => {
	switch (metric) {
		case "avg":
		case "min":
		case "max":
			return `${metric}_over_time`
		case "count":
			return "count_over_time"
		case "sum":
			return kind === "CUMULATIVE" ? "increase" : "sum_over_time"
		case "increase":
			return kind === "DELTA" ? "sum_over_time" : "increase"
		case "rate":
			return kind === "DELTA" ? "sum_over_time" : "rate"
	}
}

const outerAggregation = (metric: MetricsMetric): string =>
	metric === "avg" || metric === "min" || metric === "max" ? metric : "sum"

export interface GcpPromQlRequest {
	readonly metric: MetricsMetric
	readonly filters: MetricsFilters
	/** Flat label the result is grouped by; undefined is one ungrouped series. */
	readonly groupLabel: string | undefined
	/** Range-function window, in seconds. */
	readonly windowSeconds: number
}

export interface GcpPromQl {
	readonly query: string
	/** Projects a `project_id` filter narrows the fan-out to. */
	readonly projects?: ReadonlyArray<string>
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

	const scope = yield* compileScope(descriptor, [
		...(filters.attributeFilters ?? []),
		...(filters.resourceAttributeFilters ?? []),
	])
	const w = request.windowSeconds
	const by = request.groupLabel === undefined ? "" : ` by (${labelName(request.groupLabel)})`
	const aggregate = (aggregation: string, metricName: string, fn: string) =>
		`${aggregation}${by} (${scope
			.selectors(metricName)
			.map((selector) => `${fn}(${selector}[${w}s])`)
			.join(" or ")})`

	const type = descriptor.type
	const compiled = (query: string): GcpPromQl =>
		scope.projects === undefined ? { query } : { query, projects: scope.projects }

	if (descriptor.valueType === "DISTRIBUTION") {
		// Distributions answer as `_count` / `_sum` counters; the bare name returns nothing.
		const counter = descriptor.metricKind === "CUMULATIVE" ? "increase" : "sum_over_time"
		switch (metric) {
			case "min":
			case "max":
				return yield* reject(
					`${metric} is not available for the distribution ${type}; use avg, sum, count or rate`,
				)
			case "avg":
				return compiled(
					`${aggregate("sum", `${type}_sum`, counter)} / ${aggregate("sum", `${type}_count`, counter)}`,
				)
			case "sum":
				return compiled(aggregate("sum", `${type}_sum`, counter))
			case "count":
			case "increase":
				return compiled(aggregate("sum", `${type}_count`, counter))
			case "rate":
				return compiled(
					descriptor.metricKind === "CUMULATIVE"
						? aggregate("sum", `${type}_count`, "rate")
						: `${aggregate("sum", `${type}_count`, counter)} / ${w}`,
				)
		}
	}

	const expression = aggregate(outerAggregation(metric), type, rangeFunction(descriptor.metricKind, metric))
	// A delta counter's samples are already increments: sum them (exact, unlike `increase`).
	return compiled(
		descriptor.metricKind === "DELTA" && metric === "rate" ? `${expression} / ${w}` : expression,
	)
})

const discoverySeries = (descriptor: GcpMetricDescriptor): string =>
	descriptor.valueType === "DISTRIBUTION" ? `${descriptor.type}_count` : descriptor.type

/** A few recent series of the metric, to read which labels it carries. */
export const compileGcpLabelSample = Effect.fnUntraced(function* (descriptor: GcpMetricDescriptor) {
	const scope = yield* compileScope(descriptor, [])
	return `topk(5, ${scope
		.selectors(discoverySeries(descriptor))
		.map((selector) => `last_over_time(${selector}[1h])`)
		.join(" or ")})`
})

/** Series per value of one label over the window. */
export const compileGcpLabelValues = Effect.fnUntraced(function* (
	descriptor: GcpMetricDescriptor,
	label: string,
	windowSeconds: number,
) {
	const scope = yield* compileScope(descriptor, [])
	return `count by (${labelName(label)}) (${scope
		.selectors(discoverySeries(descriptor))
		.map((selector) => `last_over_time(${selector}[${windowSeconds}s])`)
		.join(" or ")})`
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
