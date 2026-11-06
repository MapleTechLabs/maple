/**
 * How an alert rule's measured quantity is named and unit-formatted in outbound
 * notifications.
 *
 * `signalType` alone is NOT that name. It is the rule's *query kind*, and two of
 * its members — `builder_query` and `raw_query` — say only "this rule runs a
 * query", not what the query measures. Printing the enum verbatim produced chat
 * messages reading "builder_query is 1041923". The measured quantity for those
 * two lives in the rule's `queryBuilderDraft` / `rawQueryReducer`, which is why
 * this resolves from the rule rather than from the enum.
 *
 * The unit travels with the label because the two are decided by the same facts:
 * a traces `p95_duration` query is milliseconds, `error_rate` is a ratio, and a
 * metrics query is an unknown unit that must render as a plain number. Deriving
 * them separately is how the observed value and its threshold drift apart.
 */
import type { QueryBuilderQueryDraftPayload } from "@maple/domain/http"
import { AGGREGATIONS_BY_SOURCE } from "@maple/query-engine/query-builder"
import type { ChartUnit } from "@maple/widgets/chart/static-chart"
import { Array as Arr, String as Str } from "effect"

/** `burn`: an SLO burn rate, a multiple of the sustainable rate shown as `14.4x`. */
/** `severity` is an anomaly rule's code: 0 normal, 1 warning, 2 critical. */
export type SignalUnit = "ratio" | "ms" | "rpm" | "apdex" | "count" | "plain" | "burn" | "severity"

export interface SignalDisplay {
	/** Human-readable name of the measured quantity, e.g. `sum(db.query.duration)`. */
	readonly label: string
	readonly unit: SignalUnit
}

export interface SignalDisplayInput {
	readonly signalType: string
	readonly queryBuilderDraft?: QueryBuilderQueryDraftPayload | null
	/**
	 * Widened to `string` so the undecoded `alert_rules.reducer` column can be
	 * passed straight through: this only compares it, and a delivery must not
	 * fail on an unrecognized reducer spelling.
	 */
	readonly rawQueryReducer?: string | null
}

const PRESET_SIGNALS: Record<string, SignalDisplay> = {
	error_rate: { label: "Error Rate", unit: "ratio" },
	p95_latency: { label: "P95 Latency", unit: "ms" },
	p99_latency: { label: "P99 Latency", unit: "ms" },
	apdex: { label: "Apdex", unit: "apdex" },
	throughput: { label: "Throughput", unit: "rpm" },
	uptime: { label: "Uptime check", unit: "plain" },
	slo_burn_rate: { label: "SLO burn rate", unit: "burn" },
	anomaly: { label: "Anomaly", unit: "severity" },
} satisfies Record<string, SignalDisplay>

/**
 * `p95_duration` → `p95(duration)`. Reuses the query builder's own option labels
 * so the notification names the aggregation exactly as the rule author picked it
 * in the UI.
 */
const TRACES_AGGREGATION_LABELS = new Map(
	Arr.map(AGGREGATIONS_BY_SOURCE.traces, (option) => [option.value, option.label]),
)

const PRODUCT_EVENTS_AGGREGATION_LABELS = new Map([
	["count", "Event count"],
	...Arr.map(
		Arr.filter(AGGREGATIONS_BY_SOURCE.product_events, (option) => option.value !== "count"),
		(option) => [option.value, option.label] as const,
	),
])

const tracesAggregationUnit = (aggregation: string): SignalUnit => {
	if (Str.endsWith("_duration")(aggregation)) return "ms"
	if (aggregation === "error_rate") return "ratio"
	if (aggregation === "count") return "count"
	return "plain"
}

/** `builder_query` → `Builder query`, so an unmapped enum never leaks verbatim. */
const humanize = (value: string): string => {
	const words = Str.trim(Str.replace(/[_-]+/g, " ")(value))
	if (words.length === 0) return "Signal"
	return Str.toUpperCase(Str.slice(0, 1)(words)) + Str.slice(1)(words)
}

const call = (fn: string, arg: string | undefined): string =>
	arg != null && Str.trim(arg).length > 0 ? `${fn}(${Str.trim(arg)})` : fn

const builderQueryDisplay = (draft: QueryBuilderQueryDraftPayload): SignalDisplay => {
	const aggregation = Str.trim(draft.aggregation)
	const named = (label: string, unit: SignalUnit): SignalDisplay =>
		label.length > 0 ? { label, unit } : { label: Str.trim(draft.name) || "Query", unit }

	if (draft.dataSource === "metrics") {
		// The metric's unit is not carried on the draft, so the value stays plain.
		return named(call(aggregation, draft.metricName), "plain")
	}
	if (draft.dataSource === "logs") {
		return named(aggregation === "count" ? "Log count" : aggregation, "count")
	}
	if (draft.dataSource === "product_events") {
		return named(PRODUCT_EVENTS_AGGREGATION_LABELS.get(aggregation) ?? aggregation, "count")
	}
	// Traces. A non-empty `valueField` switches the query into numeric-attribute
	// aggregation, so the attribute — not "duration" — is what is being measured.
	if (draft.valueField != null && Str.trim(draft.valueField).length > 0) {
		return named(call(aggregation, draft.valueField), "plain")
	}
	return named(
		TRACES_AGGREGATION_LABELS.get(aggregation) ?? aggregation,
		tracesAggregationUnit(aggregation),
	)
}

const rawQueryDisplay = (reducer: string | null | undefined): SignalDisplay => ({
	// `identity` means "the bucket value as-is" — naming it would add noise.
	label: reducer != null && reducer !== "identity" ? `SQL result (${reducer})` : "SQL result",
	unit: "plain",
})

export const resolveSignalDisplay = (input: SignalDisplayInput): SignalDisplay => {
	const preset = PRESET_SIGNALS[input.signalType]
	if (preset !== undefined) return preset
	if (input.signalType === "builder_query" && input.queryBuilderDraft != null) {
		return builderQueryDisplay(input.queryBuilderDraft)
	}
	if (input.signalType === "raw_query") return rawQueryDisplay(input.rawQueryReducer)
	// A query-driven rule whose definition could not be loaded (deleted rule row),
	// or a signal type added to the domain without an entry here.
	return { label: humanize(input.signalType), unit: "plain" }
}

/**
 * A rule's {@link SignalUnit} as the static chart renderer's unit.
 *
 * The two vocabularies are deliberately different: `SignalUnit` says what the
 * rule measures, `ChartUnit` says how an axis formats. `apdex` and `count`
 * both collapse to `number` because neither has a suffix worth printing on a
 * chart — an apdex of `0.82` is not `0.82 apdex` — while `ratio` becomes
 * `percent`, which is the one case where the chart adds a glyph the signal
 * label does not.
 */
export const mapSignalUnit = (unit: SignalUnit): ChartUnit => {
	switch (unit) {
		case "ratio":
			return "percent"
		case "ms":
			return "duration_ms"
		case "rpm":
			return "requests_per_sec"
		case "apdex":
		case "count":
		case "plain":
		case "burn":
		case "severity":
			return "number"
	}
}
