// The evaluation result Maple stores: the OTel GenAI `gen_ai.evaluation.result` event, plus the
// few facts the convention has no attribute for yet.
//
// The event arrives as an OTLP log record (its `event_name`, which the ingest gateway copies to
// `LogAttributes['event.name']`) or as a span event on the evaluated span. `ai_evaluations_mv`
// and `ai_evaluations_span_events_mv` project both into `ai_evaluations`.

/** The OTel event name (semantic-conventions-genai `gen_ai-events.md`, Development). */
export const GEN_AI_EVALUATION_EVENT = "gen_ai.evaluation.result"

/** Attributes the OTel convention defines for the event. */
export const GEN_AI_EVALUATION_ATTRS = {
	name: "gen_ai.evaluation.name",
	scoreValue: "gen_ai.evaluation.score.value",
	scoreLabel: "gen_ai.evaluation.score.label",
	explanation: "gen_ai.evaluation.explanation",
	responseId: "gen_ai.response.id",
	errorType: "error.type",
} as const

/**
 * Maple's own attributes for what the convention leaves out. Pending upstream proposals
 * (semantic-conventions-genai #359, #623, #694) take precedence once they land; these stay as
 * aliases.
 */
export const MAPLE_EVALUATION_ATTRS = {
	/** `span`, `trace` or `session`. Default `span`, or `trace` for a target trace with no target span. */
	scope: "maple_ai.evaluation.scope",
	/** The session a `session`-scope score grades. */
	sessionId: "maple_ai.evaluation.session.id",
	/** `code`, `llm`, `human` or `agent`. */
	annotatorKind: "maple_ai.evaluation.annotator_kind",
	/** Who wrote it: `maple_check`, `maple_online`, ... ; `otel` when absent. */
	source: "maple_ai.evaluation.source",
	evaluatorId: "maple_ai.evaluation.evaluator.id",
	evaluatorVersion: "maple_ai.evaluation.evaluator.version",
	experimentId: "maple_ai.evaluation.experiment.id",
	/** The emitter's key for a score, for re-scores of the same target and name. Stored, not yet
	 *  deduplicated on read. */
	identifier: "maple_ai.evaluation.identifier",
	judgeModel: "maple_ai.evaluation.judge.model",
	/** For a score written outside the evaluated span's context. A target trace replaces the
	 *  record's trace AND span: leave `targetSpanId` unset for a trace-scope score. */
	targetTraceId: "maple_ai.evaluation.target.trace_id",
	targetSpanId: "maple_ai.evaluation.target.span_id",
} as const

/** Longest explanation kept per score, in characters; judges can write essays. */
export const EVALUATION_EXPLANATION_MAX = 4096

export const EVALUATION_SCOPES = ["span", "trace", "session"] as const
export type EvaluationScope = (typeof EVALUATION_SCOPES)[number]

/**
 * A score's verdict, read from its label: `pass` / `fail` for the usual spellings, `''` when the
 * label says neither (a numeric score, or a categorical one like `relevant`).
 */
export const EVALUATION_VERDICTS = ["pass", "fail"] as const
export type EvaluationVerdict = (typeof EVALUATION_VERDICTS)[number] | ""

export const EVALUATION_PASS_LABELS = ["pass", "passed", "true", "yes", "ok", "correct"] as const
export const EVALUATION_FAIL_LABELS = ["fail", "failed", "false", "no", "incorrect"] as const
