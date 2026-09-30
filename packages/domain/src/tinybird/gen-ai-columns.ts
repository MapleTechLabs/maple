// The facts of one GenAI span that `ai_trace_index` carries, as SQL.
//
// Every fact the index aggregates or filters on is decided by the ingest
// gateway, once per span, and written onto the span as a `maple_ai.*` stamp
// (`MAPLE_AI_STAMP_ATTRS`, decided in `apps/ingest/src/ai_session/facts.rs`
// and `usage.rs`): whether the span is a model call or a tool call, whether it
// failed, its model, agent and tool, and a model call's usage as five disjoint
// buckets. So the view is a projection of those stamps plus generic OTel
// fields, and holds no vendor rule: a dialect is taught to the gateway, where
// the span is still whole, never to this SQL. The detail page reads the same
// stamps, which is what keeps the list and the page equal.
//
// The one computation left here is generic: the failure fingerprint, hashed
// through the redaction chain `error_events` fingerprints messages with.

import type { Expr } from "@maple-dev/effect-clickhouse/expr"
import * as CH from "@maple-dev/effect-clickhouse/expr"
import { compile } from "@maple-dev/effect-clickhouse/sql"
import * as T from "@maple-dev/effect-clickhouse/types"
import { applyRedactions, chRedactChain, MSG_TEXT_REDACTIONS } from "./fingerprint"
import { MAPLE_AI_STAMP_ATTRS } from "../gen-ai"

const sql = (expr: Expr<unknown>): string => compile(expr.toFragment())

const attr = (key: string): Expr<string> =>
	CH.mapGet(CH.dynamicColumn<Record<string, string>>("SpanAttributes"), key)

/** A gateway flag: `1` where it stamped `"1"`. */
const flag = (key: string): Expr<number> => CH.compileFnCall<number>("toUInt8", attr(key).eq("1"))

const number = (key: string): Expr<number> => CH.toFloat64OrZero(attr(key))

/** Characters, not bytes: `left` cuts mid-codepoint on any text holding one. */
const leftUTF8 = (value: Expr<string>, chars: number): Expr<string> =>
	CH.compileFnCall<string>("leftUTF8", value, CH.lit(chars))

/**
 * How much of a span's status message the index carries. A status message and
 * nothing else is what most failures carry, so it is the identity of a failure
 * group as often as the type is — but a framework that puts a stack trace there
 * would otherwise make the index as wide as the raw span.
 */
const GENAI_STATUS_MESSAGE_MAX = 400

/** How much of a failure's text is redacted and hashed: no longer than the
 *  status message the index carries, nor the failed tool call's result the
 *  gateway cuts, so a fingerprint is a function of its row's own
 *  `FailedToolCallResult` and `StatusMessage`. */
const GENAI_ERROR_FINGERPRINT_CHARS = 400

const statusMessage = leftUTF8(CH.dynamicColumn<string>("StatusMessage"), GENAI_STATUS_MESSAGE_MAX)
const failedToolCallResult = attr(MAPLE_AI_STAMP_ATTRS.toolErrorResult)
const input = number(MAPLE_AI_STAMP_ATTRS.inputTokens)
const cacheRead = number(MAPLE_AI_STAMP_ATTRS.cacheReadTokens)
const cacheWrite = number(MAPLE_AI_STAMP_ATTRS.cacheWriteTokens)
const output = number(MAPLE_AI_STAMP_ATTRS.outputTokens)
const reasoning = number(MAPLE_AI_STAMP_ATTRS.reasoningTokens)

/**
 * The failure group a failed span belongs to, `0` on every other span: a hash
 * of its failed tool call's result, else of its status message, after the
 * redactions `error_events` fingerprints messages with — so a missing key at
 * `["evidence"][0]` and at `["evidence"][1]` is one group, and a timeout that
 * reports its elapsed milliseconds is one group rather than one per call.
 */
const errorFingerprint = CH.if_(
	attr(MAPLE_AI_STAMP_ATTRS.error).eq("1"),
	CH.cityHash64(
		CH.rawExpr(
			chRedactChain(
				sql(
					leftUTF8(
						CH.coalesce(CH.nullIf(failedToolCallResult, ""), statusMessage),
						GENAI_ERROR_FINGERPRINT_CHARS,
					),
				),
				MSG_TEXT_REDACTIONS,
			),
			T.string,
		),
	),
	CH.lit(0),
)

/**
 * The text the fingerprint hashes, from a failed row's own columns — the
 * TypeScript mirror its grouping is tested against, as
 * `computeFingerprintInputs` is for `error_events`. Cut by code point, as
 * `leftUTF8` cuts. If you change one, change both.
 */
export const genAiErrorFingerprintText = (row: {
	readonly failedToolCallResult: string
	readonly statusMessage: string
}): string =>
	applyRedactions(
		Array.from(row.failedToolCallResult !== "" ? row.failedToolCallResult : row.statusMessage)
			.slice(0, GENAI_ERROR_FINGERPRINT_CHARS)
			.join(""),
		MSG_TEXT_REDACTIONS,
	)

/** SQL text for the materialized view and the migration DDL. */
export const GENAI_MODEL_SQL = sql(attr(MAPLE_AI_STAMP_ATTRS.model))
export const GENAI_AGENT_NAME_SQL = sql(attr(MAPLE_AI_STAMP_ATTRS.agentName))
export const GENAI_TOOL_NAME_SQL = sql(attr(MAPLE_AI_STAMP_ATTRS.toolName))
export const GENAI_RESPONSE_ID_SQL = sql(attr(MAPLE_AI_STAMP_ATTRS.responseId))
export const GENAI_IS_LLM_CALL_SQL = sql(flag(MAPLE_AI_STAMP_ATTRS.llmCall))
export const GENAI_IS_TOOL_CALL_SQL = sql(flag(MAPLE_AI_STAMP_ATTRS.toolCall))
export const GENAI_IS_ERROR_SQL = sql(flag(MAPLE_AI_STAMP_ATTRS.error))
export const GENAI_TOKENS_SQL = sql(input.add(cacheRead).add(cacheWrite).add(output).add(reasoning))
export const GENAI_COST_SQL = sql(number(MAPLE_AI_STAMP_ATTRS.cost))
/** Plain OTel semconv: why the span failed, where it named a reason. */
export const GENAI_ERROR_TYPE_SQL = sql(attr("error.type"))
export const GENAI_STATUS_MESSAGE_SQL = sql(statusMessage)
export const GENAI_TOOL_DESCRIPTION_SQL = sql(attr(MAPLE_AI_STAMP_ATTRS.toolDescription))
export const GENAI_FAILED_TOOL_CALL_RESULT_SQL = sql(failedToolCallResult)
export const GENAI_ERROR_FINGERPRINT_SQL = sql(errorFingerprint)
export const GENAI_INPUT_TOKENS_SQL = sql(input)
export const GENAI_CACHE_READ_TOKENS_SQL = sql(cacheRead)
export const GENAI_CACHE_WRITE_TOKENS_SQL = sql(cacheWrite)
export const GENAI_OUTPUT_TOKENS_SQL = sql(output)
export const GENAI_REASONING_TOKENS_SQL = sql(reasoning)
