/**
 * Migration 0033 — Claude Code's cost reaches `ai_trace_index`.
 *
 * Claude Code prices a model call only on its `api_request` log event
 * (`LogAttributes['cost_usd']`), never on its `claude_code.llm_request` span,
 * so every index read priced its sessions at nothing. A second view into the
 * index, `ai_trace_index_claude_code_cost_mv`, writes one usage record per such
 * event: `ResponseId` the event's `request_id` — the value the span carries as
 * `gen_ai.response.id` — and `Cost` its `cost_usd`, with no tokens, no model
 * and no call or failure flag. The session sums already take the largest claim
 * per response id, so the call is priced by the event and counted and measured
 * by the span. `SpanId` is `usage:<request_id>`: never `''` and never a real
 * span id, so the usage netting cannot charge it against another reporter, and
 * a count of agent spans can leave it out.
 *
 * NOTHING IS BACKFILLED: events already in `logs` stay unpriced in the index
 * until `logs`' 30-day TTL ages them out. The managed side accepts the same gap
 * (a `SELECT *` forward query on `ai_trace_index` keeps Tinybird from replaying
 * `logs` or `traces` through the views).
 *
 * `requiredForIngest: false` — the gateway writes `logs`, never this table.
 *
 * The CREATE statement below is the verbatim DDL as the schema emitter produced
 * it at v33. Frozen history: never re-derive it from a later snapshot.
 */
export const migration_0033_ai_trace_index_claude_code_cost = {
	version: 33,
	description:
		"Materialize the cost of each Claude Code model call into ai_trace_index from its api_request log event, keyed by the request id its llm_request span carries",
	requiredForIngest: false,
	statements: [
		"CREATE MATERIALIZED VIEW IF NOT EXISTS ai_trace_index_claude_code_cost_mv TO ai_trace_index AS\nSELECT\n          OrgId,\n          Timestamp,\n          TraceId,\n          LogAttributes['session.id'] AS SessionId,\n          'claude_agent_sdk' AS VendorId,\n          ServiceName,\n          coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) AS DeploymentEnv,\n          '' AS Model,\n          '' AS AgentName,\n          '' AS ToolName,\n          concat('usage:', LogAttributes['request_id']) AS SpanId,\n          '' AS ParentSpanId,\n          0 AS Duration,\n          0 AS IsError,\n          0 AS IsLlmCall,\n          0 AS IsToolCall,\n          0 AS Tokens,\n          toFloat64OrZero(LogAttributes['cost_usd']) AS Cost,\n          LogAttributes['request_id'] AS ResponseId,\n          '' AS VendorVersion,\n          0 AS InputTokens,\n          0 AS CacheReadTokens,\n          0 AS CacheWriteTokens,\n          0 AS OutputTokens,\n          0 AS ReasoningTokens,\n          '' AS ErrorType,\n          '' AS StatusMessage,\n          '' AS ToolDescription,\n          '' AS FailedToolCallResult,\n          0 AS ErrorFingerprint\n        FROM logs\n        WHERE ScopeName = 'com.anthropic.claude_code.events'\n          AND LogAttributes['event.name'] = 'api_request'\n          AND TraceId != ''\n          AND LogAttributes['request_id'] != ''\n          AND LogAttributes['session.id'] != ''\n          AND isFinite(toFloat64OrZero(LogAttributes['cost_usd']))\n          AND toFloat64OrZero(LogAttributes['cost_usd']) > 0",
	],
} as const
