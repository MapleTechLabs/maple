/**
 * Migration 0035 — `ai_trace_index_mv` projects the ingest gateway's stamps.
 *
 * The view used to decide every GenAI fact itself, at insert: which span is a
 * model call or a tool call (operation lists, span-name needles), whether it
 * failed, the model, agent, tool and response id coalesced across each
 * dialect's keys, and the usage under a per-provider convention. Those rules
 * were integration knowledge in SQL, copied by hand from the read side, and
 * the two drifted. The gateway now decides each of them once per span and
 * stamps it as a `maple_ai.*` attribute (`MAPLE_AI_STAMP_ATTRS`,
 * `apps/ingest/src/ai_session/facts.rs`), so the view reads those keys and
 * nothing else — plus the generic columns, `error.type`, and the failure
 * fingerprint's redaction chain. A dialect is now taught to the gateway.
 *
 * No column changes. NOTHING IS BACKFILLED: rows materialized before this
 * migration keep the values the old view gave them until raw `traces`' 30-day
 * TTL ages them out. The gateway must stamp before this view runs, or the
 * spans ingested in between materialize as neither a call nor a tool, with no
 * usage — so the ingest deploy goes first.
 *
 * The view is dropped and recreated because a materialized view's SELECT is
 * frozen at creation.
 *
 * `requiredForIngest: false` — the gateway writes `traces`, never this table.
 *
 * The CREATE statement below is the verbatim DDL as the schema emitter produced
 * it at v35. Frozen history: never re-derive it from a later snapshot.
 */
export const migration_0035_ai_trace_index_gateway_stamps = {
	version: 35,
	description: "Recreate ai_trace_index_mv as a projection of the ingest gateway's maple_ai.* stamps",
	requiredForIngest: false,
	statements: [
		"DROP VIEW IF EXISTS ai_trace_index_mv",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS ai_trace_index_mv TO ai_trace_index AS\nSELECT\n          OrgId,\n          Timestamp,\n          TraceId,\n          SpanAttributes['maple_ai.session.id'] AS SessionId,\n          SpanAttributes['maple_ai.vendor.id'] AS VendorId,\n          ServiceName,\n          coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) AS DeploymentEnv,\n          SpanAttributes['maple_ai.model'] AS Model,\n          SpanAttributes['maple_ai.agent.name'] AS AgentName,\n          SpanAttributes['maple_ai.tool.name'] AS ToolName,\n          SpanId,\n          ParentSpanId,\n          Duration,\n          toUInt8(SpanAttributes['maple_ai.error'] = '1') AS IsError,\n          toUInt8(SpanAttributes['maple_ai.llm_call'] = '1') AS IsLlmCall,\n          toUInt8(SpanAttributes['maple_ai.tool_call'] = '1') AS IsToolCall,\n          toFloat64OrZero(SpanAttributes['maple_ai.usage.input_tokens']) + toFloat64OrZero(SpanAttributes['maple_ai.usage.cache_read_tokens']) + toFloat64OrZero(SpanAttributes['maple_ai.usage.cache_write_tokens']) + toFloat64OrZero(SpanAttributes['maple_ai.usage.output_tokens']) + toFloat64OrZero(SpanAttributes['maple_ai.usage.reasoning_tokens']) AS Tokens,\n          toFloat64OrZero(SpanAttributes['maple_ai.usage.cost']) AS Cost,\n          SpanAttributes['maple_ai.response.id'] AS ResponseId,\n          SpanAttributes['maple_ai.vendor.version'] AS VendorVersion,\n          toFloat64OrZero(SpanAttributes['maple_ai.usage.input_tokens']) AS InputTokens,\n          toFloat64OrZero(SpanAttributes['maple_ai.usage.cache_read_tokens']) AS CacheReadTokens,\n          toFloat64OrZero(SpanAttributes['maple_ai.usage.cache_write_tokens']) AS CacheWriteTokens,\n          toFloat64OrZero(SpanAttributes['maple_ai.usage.output_tokens']) AS OutputTokens,\n          toFloat64OrZero(SpanAttributes['maple_ai.usage.reasoning_tokens']) AS ReasoningTokens,\n          SpanAttributes['error.type'] AS ErrorType,\n          leftUTF8(StatusMessage, 400) AS StatusMessage,\n          SpanAttributes['maple_ai.tool.description'] AS ToolDescription,\n          SpanAttributes['maple_ai.tool.error_result'] AS FailedToolCallResult,\n          if(SpanAttributes['maple_ai.error'] = '1', cityHash64(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(leftUTF8(coalesce(nullIf(SpanAttributes['maple_ai.tool.error_result'], ''), leftUTF8(StatusMessage, 400)), 400), '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\\\.[a-zA-Z]{2,}', 'EMAIL'), 'https?://[^/ )\"]+', ''), '/(Users|home)/[^/ ]+', '/~'), '[?][A-Za-z0-9_]+=[^ )\"]*', '?#'), '\\'[^\\' ]*/[^\\' ]*\\'|\\'[^\\' ]{25,}\\'', '\\'#\\''), '\"[^\" ]*/[^\" ]*\"|\"[^\" ]{25,}\"', '\"#\"'), '`[^` ]*/[^` ]*`|`[^` ]{25,}`', '`#`'), '[0-9a-fA-F-]{6,}|[0-9]+', '#')), 0) AS ErrorFingerprint\n        FROM traces\n        WHERE SpanAttributes['maple_ai.vendor.id'] != ''",
	],
} as const
