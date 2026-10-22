// BOUNDARY: widget endpoints answer untyped JSON; this module narrows it into rows and values.
import { QueryEngineValidationError } from "@maple/domain/http"
import {
	formatRangeSeconds,
	formatWarehouseDateTime,
	hasUnresolvedVariableRefs,
	interpolateWidgetParams,
	parseWarehouseDateTime,
	MAX_LIST_RANGE_SECONDS,
	planWidgetRequest,
	type VariableValues,
} from "@maple/query-engine"
import { displayError } from "@maple/web-data/lib/error-messages"
import { isRequestTimeout, WarehouseDecodeError } from "@maple/web-data/warehouse/effect-utils"
import { getWidgetServerFunction } from "@maple/web-data/warehouse/widget-data-sources"
import {
	dataSourceTransform,
	toWidgetRequest,
	type WidgetDataSourceTransformSchema,
} from "@maple/widgets/dashboard"
import { Duration, Effect, Schedule, Schema } from "effect"
import { requestKey } from "../../../data/request-key"

// A widget's data source: the request a widget
// sends, the fetch with its retry policy, and the transform that turns the answer into rows.

type Transform = typeof WidgetDataSourceTransformSchema.Type
type Row = Readonly<Record<string, unknown>>

/**
 * A widget whose request is planned: its dedupe key, endpoint and resolved params. `shape` is the
 * request without its window, so a re-plan can tell a time-only change from a different query.
 */
export const PlannedRequest = Schema.Struct({
	key: Schema.String,
	shape: Schema.String,
	endpoint: Schema.String,
	params: Schema.Record(Schema.String, Schema.Unknown),
})
export type PlannedRequest = typeof PlannedRequest.Type

/** Why a widget draws no query: the `dataState` derived before any fetch. */
export const WidgetGate = Schema.Union([
	Schema.TaggedStruct("Request", { request: PlannedRequest }),
	Schema.TaggedStruct("Static", {}),
	Schema.TaggedStruct("Config", { title: Schema.String, message: Schema.String }),
	Schema.TaggedStruct("Range", { title: Schema.String, message: Schema.String }),
	Schema.TaggedStruct("Disabled", { message: Schema.String }),
	Schema.TaggedStruct("WaitingOnVariables", {}),
])
export type WidgetGate = typeof WidgetGate.Type

export interface PlanInput {
	readonly orgId: string
	readonly dataSource: unknown
	readonly window: { readonly startTime: string; readonly endTime: string } | null
	readonly widgetTimeRange?: Parameters<typeof planWidgetRequest>[0]["widgetTimeRange"]
	readonly maxDataPoints?: number
	/** The board's variables: their names, and the values resolved so far (`useDashboardVariables`). */
	readonly variables?: Readonly<{ names: ReadonlyArray<string>; values: VariableValues }>
	/** `narrowedToCap`: the viewer pulled this list back to the cap (per tile, not persisted). */
	readonly isNarrowed?: boolean
}

/** `narrowRangeLabel`: the list cap as the CTA reads it. */
export const NARROW_RANGE_LABEL = `Show last ${formatRangeSeconds(MAX_LIST_RANGE_SECONDS)}`

/**
 * `useWidgetDataSource`'s `plan`, `disableReason` and gating, in that order.
 */
export const planWidget = (input: PlanInput): WidgetGate => {
	if (input.dataSource === undefined || input.dataSource === null)
		return { _tag: "Config", title: "Not set up yet", message: "Pick what this widget should show." }
	const request = toWidgetRequest(input.dataSource)
	if (request === null) return { _tag: "Disabled", message: "Unsupported data source" }
	if (request.endpoint === "markdown_static") return { _tag: "Static" }
	// A literal `$service` must never reach the API: wait until every referenced variable resolves.
	if (
		input.variables !== undefined &&
		hasUnresolvedVariableRefs(request.params, input.variables.names, input.variables.values)
	)
		return { _tag: "WaitingOnVariables" }
	if (input.window === null) return { _tag: "Disabled", message: "Unable to resolve dashboard time range" }
	const planned = planWidgetRequest({
		request,
		dashboardWindow: input.window,
		...(input.widgetTimeRange === undefined ? undefined : { widgetTimeRange: input.widgetTimeRange }),
		...(input.maxDataPoints === undefined ? undefined : { maxDataPoints: input.maxDataPoints }),
		...(input.variables === undefined ? undefined : { variableValues: input.variables.values }),
	})
	// Narrowing re-plans over the capped window, measured from where the tile's window ends.
	const plan =
		input.isNarrowed === true && planned.kind === "request" && planned.exceedsListCap
			? planWidgetRequest({
					request,
					dashboardWindow: {
						startTime: formatWarehouseDateTime(
							parseWarehouseDateTime(planned.window.endTime) - MAX_LIST_RANGE_SECONDS * 1000,
						),
						endTime: planned.window.endTime,
					},
					...(input.maxDataPoints === undefined
						? undefined
						: { maxDataPoints: input.maxDataPoints }),
					...(input.variables === undefined
						? undefined
						: { variableValues: input.variables.values }),
				})
			: planned
	if (plan.kind === "disabled") {
		return plan.reason === "metric_not_selected"
			? {
					_tag: "Config",
					title: "No metric selected",
					message: "Pick a metric in the query editor to run this tile.",
				}
			: { _tag: "Disabled", message: "Unable to resolve this widget's time range" }
	}
	if (getWidgetServerFunction(request.endpoint) === undefined)
		return { _tag: "Disabled", message: `Unknown data source endpoint: ${request.endpoint}` }
	if (plan.exceedsListCap)
		return {
			_tag: "Range",
			title: "Range too wide for this list",
			message: `Lists show individual records, so they cover at most ${formatRangeSeconds(MAX_LIST_RANGE_SECONDS)}. Charts on this dashboard are unaffected.`,
		}
	const params = { ...plan.params }
	return {
		_tag: "Request",
		request: {
			key: requestKey(input.orgId, "widgetData", { endpoint: plan.endpoint, params }),
			shape: requestKey(input.orgId, "widgetShape", {
				endpoint: plan.endpoint,
				params:
					input.variables === undefined
						? request.params
						: interpolateWidgetParams(request.params, input.variables.values),
			}),
			endpoint: plan.endpoint,
			params,
		},
	}
}

// RESULTS

/** A failed widget fetch as the tile draws it (`classifyWidgetErrorKind`). */
export const WidgetFailure = Schema.Struct({
	title: Schema.NullOr(Schema.String),
	message: Schema.String,
	kind: Schema.Literals(["decode", "runtime", "range", "empty", "config"]),
})
export type WidgetFailure = typeof WidgetFailure.Type

const EXPECTED_EMPTY_MESSAGES = new Set([
	"No query data found in selected time range",
	"No breakdown data found in selected time range",
	"No list data found in selected time range",
	"No successful query results",
	"No enabled queries to run",
])

const messageOf = (error: unknown): string | undefined =>
	typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
		? error.message
		: undefined

const isRangeError = (error: unknown): boolean =>
	error instanceof QueryEngineValidationError && /time range too large/i.test(error.message)

const isDecodeError = (error: unknown): boolean =>
	error instanceof WarehouseDecodeError || error instanceof QueryEngineValidationError

/** The tile's error state for a failed fetch. */
export const toWidgetFailure = (error: unknown): WidgetFailure => {
	const message = messageOf(error)
	if (message === "No enabled queries to run")
		return {
			title: "All queries are turned off",
			message: "Turn on a query in the editor to draw this widget.",
			kind: "config",
		}
	if (message !== undefined && EXPECTED_EMPTY_MESSAGES.has(message))
		return { title: null, message: "No query data found in selected time range", kind: "empty" }
	const shown = displayError(error)
	const kind = isRangeError(error) ? "range" : isDecodeError(error) ? "decode" : "runtime"
	return { title: shown.title, message: shown.message, kind }
}

/**
 * `fetchWidgetData`: the endpoint's server function, retried twice unless the window was empty or the read
 * hit its deadline (retrying a timeout would hold the tile on its skeleton for three deadlines).
 */
export const fetchWidgetData = (endpoint: string, params: Readonly<Record<string, unknown>>) => {
	const serverFn = getWidgetServerFunction(endpoint)
	return serverFn === undefined
		? Effect.fail(new UnknownWidgetEndpointError({ message: `Unknown endpoint: ${endpoint}`, endpoint }))
		: serverFn({ data: params }).pipe(
				Effect.retry({
					times: 2,
					schedule: Schedule.exponential(Duration.millis(500)),
					while: (error) =>
						!EXPECTED_EMPTY_MESSAGES.has(messageOf(error) ?? "") && !isRequestTimeout(error),
				}),
			)
}

export class UnknownWidgetEndpointError extends Schema.TaggedError<UnknownWidgetEndpointError>()(
	"@maple/web/dashboards/UnknownWidgetEndpointError",
	{ message: Schema.String, endpoint: Schema.String },
) {}

/** What a visualization renders: rows, one value, or nothing chartable. */
export type ReadyData =
	| { readonly _tag: "Rows"; readonly rows: ReadonlyArray<Row> }
	| { readonly _tag: "Value"; readonly value: unknown }

const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null

const rowsOf = (value: unknown): ReadonlyArray<Row> | null =>
	Array.isArray(value) ? value.filter(isRow) : null

/** `isEmptyDataEnvelope`: a successful answer that carried no rows. */
export const isEmptyEnvelope = (raw: unknown): boolean =>
	isRow(raw) && "data" in raw && Array.isArray(raw.data) && raw.data.length === 0

const reduce = (rows: ReadonlyArray<Row>, reduceToValue: NonNullable<Transform["reduceToValue"]>): number => {
	const { field, aggregate = "first" } = reduceToValue
	if (rows.length === 0) return 0
	const hasField = rows.some((row) => typeof row[field] === "number" || typeof row[field] === "string")
	const firstNumeric = Object.entries(rows[0] ?? {}).find(
		([key, value]) => key !== "bucket" && typeof value === "number",
	)?.[0]
	const resolved = hasField ? field : (firstNumeric ?? null)
	if (resolved === null && aggregate !== "count") return 0
	const values = rows.map((row) => Number(row[resolved ?? ""] ?? 0))
	switch (aggregate) {
		case "first":
			return values[0] ?? 0
		case "sum":
			return values.reduce((sum, value) => sum + value, 0)
		case "count":
			return rows.length
		case "avg":
			return values.reduce((sum, value) => sum + value, 0) / rows.length
		case "max":
			return Math.max(...values)
		case "min":
			return Math.min(...values)
	}
}

const isHidden = (seriesName: string, hidden: ReadonlySet<string>): boolean =>
	[...hidden].some(
		(base) =>
			seriesName === base || seriesName.startsWith(`${base}: `) || seriesName === `${base} (prev)`,
	)

/** `applyTransform` over the unwrapped envelope (`toReadyWidgetData`). */
export const toReadyData = (response: unknown, transform: Transform | undefined): ReadyData => {
	const unwrapped =
		isRow(response) && "data" in response && response.data !== undefined ? response.data : response
	if (transform === undefined || unwrapped === null || unwrapped === undefined)
		return Array.isArray(unwrapped)
			? { _tag: "Rows", rows: rowsOf(unwrapped) ?? [] }
			: { _tag: "Value", value: unwrapped }
	let rows = rowsOf(unwrapped)
	if (rows === null) {
		if (isRow(unwrapped) && transform.reduceToValue !== undefined) rows = [unwrapped]
		else return { _tag: "Value", value: unwrapped }
	}
	const hiddenBases = transform.hideSeries?.baseNames ?? []
	if (hiddenBases.length > 0) {
		const hidden = new Set(hiddenBases)
		rows = rows.map((row) =>
			Object.fromEntries(
				Object.entries(row).filter(([key]) => key === "bucket" || !isHidden(key, hidden)),
			),
		)
	}
	const fieldMap = transform.fieldMap
	if (fieldMap !== undefined)
		rows = rows.map((row) => ({
			...row,
			...Object.fromEntries(Object.entries(fieldMap).map(([target, source]) => [target, row[source]])),
		}))
	const sortBy = transform.sortBy
	if (sortBy !== undefined)
		rows = rows.toSorted((a, b) => {
			const aValue = a[sortBy.field] ?? 0
			const bValue = b[sortBy.field] ?? 0
			const cmp = String(aValue) === String(bValue) ? 0 : aValue < bValue ? -1 : 1
			return sortBy.direction === "desc" ? -cmp : cmp
		})
	if (transform.limit !== undefined && transform.limit > 0) rows = rows.slice(0, transform.limit)
	const flatten = transform.flattenSeries
	if (flatten !== undefined)
		rows = rows.flatMap((row) => {
			const series = row.series
			if (!isRow(series)) return []
			const { series: _series, ...rest } = row
			return Object.entries(series).map(([key, value]) => ({
				...rest,
				name: key,
				[flatten.valueField]: value,
			}))
		})
	const ratio = transform.computeRatio
	if (ratio !== undefined) {
		const byName = new Map(rows.map((row) => [String(row.name ?? ""), Number(row.value ?? 0)]))
		const numerator = byName.get(ratio.numeratorName) ?? 0
		const denominator = ratio.denominatorNames.reduce((sum, name) => sum + (byName.get(name) ?? 0), 0)
		return { _tag: "Value", value: denominator > 0 ? numerator / denominator : 0 }
	}
	if (transform.reduceToValue !== undefined)
		return { _tag: "Value", value: reduce(rows, transform.reduceToValue) }
	return { _tag: "Rows", rows }
}

export { dataSourceTransform }
