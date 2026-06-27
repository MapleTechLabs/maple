import { useDeferredValue, useMemo } from "react"
import { Atom, Result, useAtomValue } from "@/lib/effect-atom"
import {
	getCustomChartTimeSeriesResultAtom,
	getQueryBuilderTimeseriesResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { computeBucketSeconds } from "@/api/warehouse/timeseries-utils"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import {
	type RuleFormState,
	buildQueryDraftFromForm,
	signalToQueryParams,
	flattenAlertChartData,
} from "@/lib/alerts/form-utils"
import { mapBuilderChartFailure } from "@/lib/alerts/preview-failure"
import { formatBackendError } from "@/lib/error-messages"
import { buildTimeseriesQuerySpec } from "@/lib/query-builder/model"

const CHART_BUCKET_TARGET = 96
const emptyChartAtom = Atom.make(Result.initial())

export interface AlertRuleChartState {
	chartData: Record<string, unknown>[]
	chartLoading: boolean
	/** Human-readable failure for the preview query; null when healthy/empty. */
	chartError: string | null
}

/**
 * Live preview data for the alert rule hero chart.
 *
 * `builder_query` rules run their draft through `getQueryBuilderTimeseries` —
 * the exact server fn dashboard query-builder charts use — so the preview
 * matches the chart the rule was created from (filters, numeric-attribute
 * aggregations, group-bys). Built-in signals keep the canned custom-chart
 * path. Raw SQL has no structured preview (the hero shows a hint instead).
 */
export function useAlertRuleChart(
	form: RuleFormState,
	range?: { startTime: string; endTime: string },
): AlertRuleChartState {
	// Callers that own a page-level time window (the rule detail page) pass it in;
	// the create form + live hero pass nothing and keep the canned last-24h window.
	const fallback = useEffectiveTimeRange(undefined, undefined, "24h")
	const startTime = range?.startTime ?? fallback.startTime
	const endTime = range?.endTime ?? fallback.endTime

	/* ------------------------- builder_query path ------------------------- */

	const isBuilderQuery = form.signalType === "builder_query"
	const draft = isBuilderQuery ? buildQueryDraftFromForm(form) : null
	// Defer per-keystroke draft edits so chart requests trail the typing.
	const deferredDraft = useDeferredValue(draft)

	// Compile precheck: a draft that doesn't build gets an inline error and no
	// request (mid-edit where clauses land here instead of spamming the API).
	const compileError = useMemo(() => {
		if (!deferredDraft) return null
		const built = buildTimeseriesQuerySpec(deferredDraft)
		return built.error != null || built.query == null
			? (built.error ?? "Query could not be compiled")
			: null
	}, [deferredDraft])

	const builderInput = useMemo(() => {
		if (!deferredDraft || compileError != null) return null
		return {
			data: {
				startTime,
				endTime,
				queries: [deferredDraft],
				// The hero is labeled "last 24h" — silently widening the window
				// to find data would make the breach stats lie.
				strategy: { enableEmptyRangeFallback: false },
			},
		}
	}, [deferredDraft, compileError, startTime, endTime])

	const builderResult = useAtomValue(
		builderInput ? getQueryBuilderTimeseriesResultAtom(builderInput) : emptyChartAtom,
	)

	/* -------------------------- built-in signals -------------------------- */

	const bucketSeconds = useMemo(
		() => computeBucketSeconds(startTime, endTime, CHART_BUCKET_TARGET),
		[startTime, endTime],
	)

	const queryParams = useMemo(() => signalToQueryParams(form), [form])

	const chartGroupBy =
		form.serviceNames.length > 1 || (form.serviceNames.length === 0 && form.groupBy.length > 0)
			? ("service" as const)
			: ("none" as const)

	const builtinInput = useMemo(() => {
		if (!queryParams) return null
		return {
			data: {
				source: queryParams.source as "traces" | "logs" | "metrics",
				metric: queryParams.metric,
				groupBy: chartGroupBy,
				startTime,
				endTime,
				bucketSeconds,
				filters: queryParams.filters as Record<string, string | boolean | string[] | undefined>,
				apdexThresholdMs: queryParams.apdexThresholdMs,
			},
		}
	}, [queryParams, startTime, endTime, bucketSeconds, chartGroupBy])

	const builtinResult = useAtomValue(
		builtinInput ? getCustomChartTimeSeriesResultAtom(builtinInput) : emptyChartAtom,
	)

	/* ------------------------------ combine ------------------------------- */

	return useMemo(() => {
		if (isBuilderQuery) {
			if (compileError != null) {
				return { chartData: [], chartLoading: false, chartError: compileError }
			}
			return Result.builder(builderResult)
				.onSuccess(
					(response): AlertRuleChartState => ({
						chartData: [...response.data],
						chartLoading: false,
						chartError: null,
					}),
				)
				.onError(
					(error): AlertRuleChartState => ({
						chartData: [],
						chartLoading: false,
						chartError: mapBuilderChartFailure(formatBackendError(error).description),
					}),
				)
				.orElse(() => ({ chartData: [], chartLoading: true, chartError: null }))
		}

		if (!builtinInput) {
			// raw_query (no structured preview) or an unpreviewable form state.
			return { chartData: [], chartLoading: false, chartError: null }
		}
		return Result.builder(builtinResult)
			.onSuccess(
				(response): AlertRuleChartState => ({
					chartData: flattenAlertChartData([...response.data], form.serviceNames),
					chartLoading: false,
					chartError: null,
				}),
			)
			.onError(
				(error): AlertRuleChartState => ({
					chartData: [],
					chartLoading: false,
					chartError: formatBackendError(error).description,
				}),
			)
			.orElse(() => ({ chartData: [], chartLoading: true, chartError: null }))
	}, [isBuilderQuery, compileError, builderResult, builtinInput, builtinResult, form.serviceNames])
}
