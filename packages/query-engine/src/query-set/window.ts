/**
 * Running every draft in a query set over ONE window, plus its formulas.
 *
 * The fan-out primitive the three surfaces share. It stops short of merging into
 * rows on purpose: the MCP widget inspector reports per-query and would have to
 * un-merge, while the chart paths merge immediately. Both call this; only the
 * chart paths go on to `runTimeseriesQuerySet`.
 */

import { Effect, Result } from "effect"
import type { QueryBuilderQueryDraftPayload } from "@maple/query-model"
import type { QuerySpec } from "@maple/domain/query-engine"
import { buildTimeseriesQuerySpec } from "../query-builder/model"
import { buildFormulaResults, type FormulaDraft, type QueryRunResult } from "../formula-results"
import {
	type BucketResolutionOptions,
	type EmptyRangeFallbackStrategy,
	type ExecutionWindow,
	buildExecutionWindows,
	NO_EMPTY_RANGE_FALLBACK,
	resolveExecutionSpecForWindow,
	resolveTimeseriesBucketSpec,
} from "./bucketing"
import type { QuerySetExecutor } from "./port"
import { countSuccessfulQuerySeries, hasAnySeriesData } from "./series-merge"

/** One window attempt for one query, kept whether it succeeded or not. */
export interface QuerySetAttempt {
	readonly startTime: string
	readonly endTime: string
	readonly kind: ExecutionWindow["kind"]
	readonly points: number
	readonly hasSeries: boolean
	readonly error?: string
}

/** What one query actually did, for a debug panel or an agent-facing report. */
export interface QuerySetQueryDiagnostics {
	readonly queryId: string
	readonly queryName: string
	readonly source: string
	readonly spec: QuerySpec | null
	readonly attempts: ReadonlyArray<QuerySetAttempt>
	readonly fallbackUsed: boolean
}

export interface QuerySetWindowResult {
	readonly queryResults: ReadonlyArray<QueryRunResult>
	readonly formulaResults: ReadonlyArray<QueryRunResult>
	/** Queries and formulas together, in that order — what a merge consumes. */
	readonly allResults: ReadonlyArray<QueryRunResult>
	readonly diagnostics: ReadonlyArray<QuerySetQueryDiagnostics>
}

/**
 * Run one query over one window, widening through the fallback ladder if the
 * strategy allows and the window came back empty.
 *
 * A PRIMARY-window failure propagates: the caller asked about that window and
 * got no answer. A FALLBACK-window failure is recorded and skipped — the caller
 * never asked about that window, so failing on it would turn a working chart
 * into an error because a speculative widening was too expensive.
 */
const executeWithFallback = <E>(
	executor: QuerySetExecutor<E>,
	startTime: string,
	endTime: string,
	spec: QuerySpec,
	strategy: EmptyRangeFallbackStrategy,
	allowFallback: boolean,
	bucketOptions: BucketResolutionOptions | undefined,
): Effect.Effect<WindowedExecution, E> => {
	const windows = buildExecutionWindows(startTime, endTime, strategy, allowFallback)

	const tryWindow = (
		index: number,
		attempts: Array<QuerySetAttempt>,
		lastPoints: ReadonlyArray<WindowPoint>,
	): Effect.Effect<WindowedExecution, E> => {
		const window = windows[index]
		if (window === undefined) {
			return Effect.succeed({ points: lastPoints, attempts, fallbackUsed: false })
		}
		const windowSpec = resolveExecutionSpecForWindow(spec, window, bucketOptions)
		return Effect.result(
			executor.execute({ startTime: window.startTime, endTime: window.endTime, query: windowSpec }),
		).pipe(
			Effect.flatMap((outcome) => {
				if (Result.isFailure(outcome)) {
					const error = outcome.failure
					const failed = [
						...attempts,
						{
							startTime: window.startTime,
							endTime: window.endTime,
							kind: window.kind,
							points: 0,
							hasSeries: false,
							error: executor.describeError(error),
						},
					]
					return window.kind === "primary"
						? Effect.fail(error)
						: tryWindow(index + 1, failed, lastPoints)
				}

				const result = outcome.success
				// A non-timeseries result for a timeseries spec is the host answering a
				// different question; treat it as no data for this window rather than
				// crashing the whole set.
				const points =
					result.kind === "timeseries"
						? result.data.map((point) => ({ bucket: point.bucket, series: { ...point.series } }))
						: []
				const hasSeries = hasAnySeriesData(points)
				const next = [
					...attempts,
					{
						startTime: window.startTime,
						endTime: window.endTime,
						kind: window.kind,
						points: points.length,
						hasSeries,
					},
				]
				return hasSeries
					? Effect.succeed({ points, attempts: next, fallbackUsed: index > 0 })
					: tryWindow(index + 1, next, points)
			}),
		)
	}

	return tryWindow(0, [], [])
}

type WindowPoint = { bucket: string; series: Record<string, number> }

interface WindowedExecution {
	readonly points: ReadonlyArray<WindowPoint>
	readonly attempts: Array<QuerySetAttempt>
	readonly fallbackUsed: boolean
}

export interface RunQuerySetWindowInput {
	readonly queries: ReadonlyArray<QueryBuilderQueryDraftPayload>
	readonly formulas: ReadonlyArray<FormulaDraft>
	readonly startTime: string
	readonly endTime: string
	/** Defaults to no widening — see `EmptyRangeFallbackStrategy`. */
	readonly fallback?: EmptyRangeFallbackStrategy
	/** Whether this window may widen at all. False for a previous-period window. */
	readonly allowFallback?: boolean
	/** Auto-bucket policy for queries whose `bucketSeconds` is unset. */
	readonly bucket?: BucketResolutionOptions
}

/**
 * Lower and execute every query, then evaluate the formulas over the results.
 *
 * Per-query failures are folded into `status: "error"` rather than failing the
 * whole set, so one broken query does not blank a chart that has three working
 * ones. Only a primary-window warehouse failure escapes as `E`.
 *
 * CONCURRENCY is `queries.length`, deliberately and not as a default to tune:
 * the web adapter's executor is backed by a batcher that coalesces everything
 * enqueued in the same tick into a single `POST /execute-batch`. Bounding
 * concurrency here would silently turn one round trip into several.
 */
export const runQuerySetWindow = Effect.fnUntraced(function* <E>(
	executor: QuerySetExecutor<E>,
	input: RunQuerySetWindowInput,
) {
	const strategy = input.fallback ?? NO_EMPTY_RANGE_FALLBACK
	const allowFallback = input.allowFallback ?? true
	const diagnostics: QuerySetQueryDiagnostics[] = []

	const queryResults = yield* Effect.forEach(
		input.queries,
		(query) =>
			Effect.gen(function* () {
				const built = buildTimeseriesQuerySpec(query)

				if (!built.query) {
					diagnostics.push({
						queryId: query.id,
						queryName: query.name,
						source: query.dataSource,
						spec: null,
						attempts: [],
						fallbackUsed: false,
					})

					return {
						queryId: query.id,
						queryName: query.name,
						source: query.dataSource,
						status: "error",
						error: built.error ?? "Failed to build query",
						warnings: built.warnings,
						data: [],
					} satisfies QueryRunResult
				}

				const querySpec = resolveTimeseriesBucketSpec(
					built.query,
					input.startTime,
					input.endTime,
					input.bucket,
				)

				const outcome = yield* Effect.result(
					executeWithFallback(
						executor,
						input.startTime,
						input.endTime,
						querySpec,
						strategy,
						allowFallback,
						input.bucket,
					),
				)

				if (Result.isFailure(outcome)) {
					diagnostics.push({
						queryId: query.id,
						queryName: query.name,
						source: query.dataSource,
						spec: querySpec,
						attempts: [],
						fallbackUsed: false,
					})

					return {
						queryId: query.id,
						queryName: query.name,
						source: query.dataSource,
						status: "error",
						error: executor.describeError(outcome.failure),
						warnings: built.warnings,
						data: [],
					} satisfies QueryRunResult
				}

				const execution = outcome.success
				diagnostics.push({
					queryId: query.id,
					queryName: query.name,
					source: query.dataSource,
					spec: querySpec,
					attempts: execution.attempts,
					fallbackUsed: execution.fallbackUsed,
				})

				const warnings = [...built.warnings]
				if (execution.fallbackUsed) {
					const selectedAttempt = execution.attempts[execution.attempts.length - 1]
					warnings.push(
						`No data in requested range; used fallback window ${selectedAttempt.startTime} -> ${selectedAttempt.endTime}`,
					)
				}

				return {
					queryId: query.id,
					queryName: query.name,
					source: query.dataSource,
					status: "success",
					error: null,
					warnings,
					// error_rate arrives from the query engine as a 0–1 ratio — the
					// canonical unit everywhere (the "percent" display unit multiplies
					// by 100 when formatting). No rescaling here.
					data: [...execution.points],
				} satisfies QueryRunResult
			}),
		{ concurrency: Math.max(input.queries.length, 1) },
	)

	// Formulas divide by their operands, so evaluating them against a set where
	// nothing returned data produces a page of NaN warnings rather than a result.
	const formulaResults =
		countSuccessfulQuerySeries(queryResults) > 0
			? buildFormulaResults([...input.formulas], queryResults)
			: []

	return {
		queryResults,
		formulaResults,
		allResults: [...queryResults, ...formulaResults],
		diagnostics,
	} satisfies QuerySetWindowResult
})
