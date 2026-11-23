// The columns of one `ai_evaluations` row, as SQL over an attribute map. The two views that fill the
// table read the same event from different places (a log record's `LogAttributes`, a span event's
// attribute map), so both project through this one function and cannot drift.

import {
	EVALUATION_EXPLANATION_MAX,
	EVALUATION_NAME_MAX,
	EVALUATION_FAIL_LABELS,
	EVALUATION_PASS_LABELS,
	EVALUATION_SCOPES,
	GEN_AI_EVALUATION_ATTRS as OTEL,
	MAPLE_EVALUATION_ATTRS as MAPLE,
} from "../gen-ai-evaluation"
import { Array as Arr } from "effect"

// `lower`, not `lowerUTF8`: local mode's libchdb has no ICU, and every label it matches is ASCII.
const list = (values: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.map(values, (value) => `'${value}'`),
		", ",
	)

/**
 * Every `ai_evaluations` column after `OrgId, Timestamp`, in table order.
 *
 * - `attrs`: the attribute map expression (`LogAttributes`, or the span event's map).
 * - `traceId`, `spanId`: the record's own context, replaced by an explicit target trace (and its span).
 * - `source`: what wrote the row when the emitter did not say.
 */
export const evaluationColumnsSql = (opts: {
	readonly attrs: string
	readonly traceId: string
	readonly spanId: string
	readonly source: string
}): string => {
	const a = (key: string) => `${opts.attrs}['${key}']`
	const label = `lower(trimBoth(${a(OTEL.scoreLabel)}))`
	const verdict = `lower(trimBoth(${a(MAPLE.verdict)}))`
	const scope = `lower(trimBoth(${a(MAPLE.scope)}))`
	// A finite number: `nan` and `inf` parse as floats and would poison every mean.
	const finite = `isFinite(toFloat64OrZero(${a(OTEL.scoreValue)})) AND isNotNull(toFloat64OrNull(${a(OTEL.scoreValue)}))`
	// An explicit target replaces the record's context as a PAIR: a target trace with the record's own
	// span id would name a span from another trace. Lowercased, as span rows store their hex ids.
	const targeted = `${a(MAPLE.targetTraceId)} != ''`
	return `
          if(${targeted}, lower(${a(MAPLE.targetTraceId)}), ${opts.traceId}) AS TraceId,
          if(${targeted}, lower(${a(MAPLE.targetSpanId)}), ${opts.spanId}) AS SpanId,
          if(${scope} IN (${list(EVALUATION_SCOPES)}), ${scope}, if(${targeted} AND ${a(MAPLE.targetSpanId)} = '', 'trace', 'span')) AS Scope,
          ${a(MAPLE.sessionId)} AS SessionId,
          ${a(OTEL.responseId)} AS ResponseId,
          leftUTF8(${a(OTEL.name)}, ${EVALUATION_NAME_MAX}) AS Name,
          if(${finite}, toFloat64OrZero(${a(OTEL.scoreValue)}), 0) AS ScoreValue,
          toUInt8(${finite}) AS HasScore,
          ${a(OTEL.scoreLabel)} AS ScoreLabel,
          multiIf(${verdict} IN ('pass', 'fail'), ${verdict}, ${label} IN (${list(EVALUATION_PASS_LABELS)}), 'pass', ${label} IN (${list(EVALUATION_FAIL_LABELS)}), 'fail', '') AS Verdict,
          leftUTF8(${a(OTEL.explanation)}, ${EVALUATION_EXPLANATION_MAX}) AS Explanation,
          ${a(OTEL.errorType)} AS ErrorType,
          ${a(MAPLE.annotatorKind)} AS AnnotatorKind,
          coalesce(nullIf(${a(MAPLE.source)}, ''), '${opts.source}') AS Source,
          ${a(MAPLE.evaluatorId)} AS EvaluatorId,
          ${a(MAPLE.evaluatorVersion)} AS EvaluatorVersion,
          ${a(MAPLE.experimentId)} AS ExperimentId,
          ${a(MAPLE.identifier)} AS Identifier,
          ${a(MAPLE.judgeModel)} AS JudgeModel`
}
