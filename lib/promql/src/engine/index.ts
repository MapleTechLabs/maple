import { Result } from "effect"
import type { VectorSelector } from "../ast"
import { parse } from "../parser"
import { evaluate } from "./evaluate"
import type { EvalError } from "./ops"
import { planRequests, type QueryParams, resolutionError } from "./plan"
import type { EvalLimits, QueryResult, SelectorData, SelectorRequest } from "./types"

export { evaluate, type EvaluationInput } from "./evaluate"
export { bucketSamples, matchesLabels, memorySource, type RawSeries } from "./memory-source"
export type { EvalError } from "./ops"
export {
	gridTimes,
	isInstant,
	MAX_POINTS_PER_SERIES,
	planPushdowns,
	planRequests,
	type PushdownCandidate,
	type QueryParams,
	type RequestPlan,
	resolutionError,
} from "./plan"
export * from "./types"

/** Parse, plan and evaluate against a synchronous source. Tests and the compliance runner use it. */
export const runQuery = (
	query: string,
	params: QueryParams,
	source: (request: SelectorRequest) => SelectorData,
	limits?: EvalLimits,
): Result.Result<QueryResult, EvalError> => {
	const parsed = parse(query)
	if (Result.isFailure(parsed)) return Result.fail({ message: parsed.failure.message })
	const expr = parsed.success
	const resolution = resolutionError(expr, params)
	if (resolution !== undefined) return Result.fail({ message: resolution })
	const data = new Map<VectorSelector, SelectorData>()
	for (const [selector, request] of planRequests(expr, params)) data.set(selector, source(request))
	return evaluate({ expr, params, data, ...(limits === undefined ? undefined : { limits }) })
}
