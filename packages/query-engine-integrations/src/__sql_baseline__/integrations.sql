-- builder:ai-sessions:aiSessionDetailsQuery:default
SELECT
          if(index_traces.rawSessionId = '', concat('trace:', session_traces.traceId), index_traces.rawSessionId) AS sessionId,
          sum(session_traces.spanCount) AS spanCount,
          sum(session_traces.errorSpanCount) AS errorSpanCount,
          groupUniqArrayArray(session_traces.serviceNames) AS serviceNames,
          toString(min(session_traces.traceStart)) AS startTime,
          toString(fromUnixTimestamp64Nano(max(session_traces.traceEndNanos))) AS endTime,
          intDiv(max(session_traces.traceEndNanos) - toUnixTimestamp64Nano(min(session_traces.traceStart)), 1000000) AS durationMs
        FROM (SELECT
          trace_detail_spans.TraceId AS traceId,
          count() AS spanCount,
          countIf((trace_detail_spans.StatusCode = 'Error' OR (trace_detail_spans.SpanAttributes['maple_ai.vendor.id'] != '' AND (trace_detail_spans.SpanAttributes['error.type'] != '' OR trace_detail_spans.SpanAttributes['gen_ai.response.status'] IN ('failed', 'error'))))) AS errorSpanCount,
          groupUniqArray(trace_detail_spans.ServiceName) AS serviceNames,
          min(trace_detail_spans.Timestamp) AS traceStart,
          max(toUnixTimestamp64Nano(trace_detail_spans.Timestamp) + toInt64(trace_detail_spans.Duration)) AS traceEndNanos
        FROM trace_detail_spans
        WHERE trace_detail_spans.OrgId = 'org_sql_catalog'
          AND trace_detail_spans.Timestamp >= '2026-01-02 09:30:00'
          AND trace_detail_spans.Timestamp <= '2026-01-02 13:30:00'
          AND trace_detail_spans.TraceId IN (SELECT
          agent_traces.traceId AS traceId
        FROM (SELECT
          ai_trace_index.TraceId AS traceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          min(ai_trace_index.Timestamp) AS traceAgentStart,
          max(toUnixTimestamp64Nano(ai_trace_index.Timestamp) + toInt64(ai_trace_index.Duration)) AS traceAgentEndNanos,
          sum(ai_trace_index.IsToolCall) AS toolCalls,
          sum(ai_trace_index.IsError) AS errorAgentSpans,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorId,
          argMin(ai_trace_index.VendorVersion, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorVersion,
          min(tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorAt,
          max(ai_trace_index.Timestamp) AS traceAgentEnd,
          count() AS agentSpanCount,
          groupUniqArrayIf(20)(ai_trace_index.ServiceName, ai_trace_index.ServiceName != '') AS serviceNames,
          groupUniqArrayIf(20)(ai_trace_index.Model, ai_trace_index.Model != '') AS models,
          groupUniqArrayIf(20)(ai_trace_index.AgentName, ai_trace_index.AgentName != '') AS agentNames,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS firstAgentName,
          min(if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS firstAgentAt,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, IsToolCall), IsError = 1) AS failedSpans,
          groupArrayIf(2000)(tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1)), ai_trace_index.Tokens, ai_trace_index.Cost, ai_trace_index.ResponseId, ai_trace_index.IsLlmCall, ai_trace_index.InputTokens, ai_trace_index.CacheReadTokens, ai_trace_index.CacheWriteTokens, ai_trace_index.OutputTokens, ai_trace_index.ReasoningTokens), ((ai_trace_index.Tokens > 0 OR ai_trace_index.Cost > 0) OR ai_trace_index.IsLlmCall = 1)) AS usageSpans,
          groupArrayArray(4000)([tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)) * 2 + 0, if(ai_trace_index.Tokens > 0, if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1))) * 2 + 0), tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)) * 2 + 1, if(ai_trace_index.Cost > 0, if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1))) * 2 + 1)]) AS usageLinks,
          arrayMap(ancestors -> arrayMap((r, t, c) -> tupleConcat(r, (intDiv(t, 2), intDiv(c, 2))), usageSpans, arraySlice(ancestors, 1, length(usageSpans)), arraySlice(ancestors, length(usageSpans) + 1)), [arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayConcat(arrayMap(r -> r.2 * 2, usageSpans), arrayMap(r -> r.2 * 2 + 1, usageSpans))))])[1]))])[1]))])[1]))])[1]])[1] AS usageReporters
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-02 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-02 12:30:00'
        GROUP BY traceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS agent_traces
        WHERE if(agent_traces.rawSessionId = '', concat('trace:', agent_traces.traceId), agent_traces.rawSessionId) IN ('wrun_sql_catalog', 'trace:7f3a4b5c6d7e8f901234567890abcdef'))
        GROUP BY traceId) AS session_traces
        INNER JOIN (SELECT
          agent_traces.traceId AS traceId,
          agent_traces.rawSessionId AS rawSessionId
        FROM (SELECT
          ai_trace_index.TraceId AS traceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          min(ai_trace_index.Timestamp) AS traceAgentStart,
          max(toUnixTimestamp64Nano(ai_trace_index.Timestamp) + toInt64(ai_trace_index.Duration)) AS traceAgentEndNanos,
          sum(ai_trace_index.IsToolCall) AS toolCalls,
          sum(ai_trace_index.IsError) AS errorAgentSpans,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorId,
          argMin(ai_trace_index.VendorVersion, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorVersion,
          min(tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorAt,
          max(ai_trace_index.Timestamp) AS traceAgentEnd,
          count() AS agentSpanCount,
          groupUniqArrayIf(20)(ai_trace_index.ServiceName, ai_trace_index.ServiceName != '') AS serviceNames,
          groupUniqArrayIf(20)(ai_trace_index.Model, ai_trace_index.Model != '') AS models,
          groupUniqArrayIf(20)(ai_trace_index.AgentName, ai_trace_index.AgentName != '') AS agentNames,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS firstAgentName,
          min(if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS firstAgentAt,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, IsToolCall), IsError = 1) AS failedSpans,
          groupArrayIf(2000)(tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1)), ai_trace_index.Tokens, ai_trace_index.Cost, ai_trace_index.ResponseId, ai_trace_index.IsLlmCall, ai_trace_index.InputTokens, ai_trace_index.CacheReadTokens, ai_trace_index.CacheWriteTokens, ai_trace_index.OutputTokens, ai_trace_index.ReasoningTokens), ((ai_trace_index.Tokens > 0 OR ai_trace_index.Cost > 0) OR ai_trace_index.IsLlmCall = 1)) AS usageSpans,
          groupArrayArray(4000)([tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)) * 2 + 0, if(ai_trace_index.Tokens > 0, if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1))) * 2 + 0), tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)) * 2 + 1, if(ai_trace_index.Cost > 0, if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1))) * 2 + 1)]) AS usageLinks,
          arrayMap(ancestors -> arrayMap((r, t, c) -> tupleConcat(r, (intDiv(t, 2), intDiv(c, 2))), usageSpans, arraySlice(ancestors, 1, length(usageSpans)), arraySlice(ancestors, length(usageSpans) + 1)), [arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayConcat(arrayMap(r -> r.2 * 2, usageSpans), arrayMap(r -> r.2 * 2 + 1, usageSpans))))])[1]))])[1]))])[1]))])[1]])[1] AS usageReporters
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-02 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-02 12:30:00'
        GROUP BY traceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS agent_traces
        WHERE if(agent_traces.rawSessionId = '', concat('trace:', agent_traces.traceId), agent_traces.rawSessionId) IN ('wrun_sql_catalog', 'trace:7f3a4b5c6d7e8f901234567890abcdef')) AS index_traces ON session_traces.traceId = index_traces.traceId
        GROUP BY sessionId
        ORDER BY startTime DESC
        FORMAT JSON

-- builder:ai-sessions:aiSessionDetailsQuery:every-counted-filter
SELECT
          if(index_traces.rawSessionId = '', concat('trace:', session_traces.traceId), index_traces.rawSessionId) AS sessionId,
          sum(session_traces.spanCount) AS spanCount,
          sum(session_traces.errorSpanCount) AS errorSpanCount,
          groupUniqArrayArray(session_traces.serviceNames) AS serviceNames,
          toString(min(session_traces.traceStart)) AS startTime,
          toString(fromUnixTimestamp64Nano(max(session_traces.traceEndNanos))) AS endTime,
          intDiv(max(session_traces.traceEndNanos) - toUnixTimestamp64Nano(min(session_traces.traceStart)), 1000000) AS durationMs
        FROM (SELECT
          trace_detail_spans.TraceId AS traceId,
          count() AS spanCount,
          countIf((trace_detail_spans.StatusCode = 'Error' OR (trace_detail_spans.SpanAttributes['maple_ai.vendor.id'] != '' AND (trace_detail_spans.SpanAttributes['error.type'] != '' OR trace_detail_spans.SpanAttributes['gen_ai.response.status'] IN ('failed', 'error'))))) AS errorSpanCount,
          groupUniqArray(trace_detail_spans.ServiceName) AS serviceNames,
          min(trace_detail_spans.Timestamp) AS traceStart,
          max(toUnixTimestamp64Nano(trace_detail_spans.Timestamp) + toInt64(trace_detail_spans.Duration)) AS traceEndNanos
        FROM trace_detail_spans
        WHERE trace_detail_spans.OrgId = 'org_sql_catalog'
          AND trace_detail_spans.Timestamp >= '2026-01-02 09:30:00'
          AND trace_detail_spans.Timestamp <= '2026-01-02 13:30:00'
          AND trace_detail_spans.TraceId IN (SELECT
          agent_traces.traceId AS traceId
        FROM (SELECT
          ai_trace_index.TraceId AS traceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          min(ai_trace_index.Timestamp) AS traceAgentStart,
          max(toUnixTimestamp64Nano(ai_trace_index.Timestamp) + toInt64(ai_trace_index.Duration)) AS traceAgentEndNanos,
          sum(ai_trace_index.IsToolCall) AS toolCalls,
          sum(ai_trace_index.IsError) AS errorAgentSpans,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorId,
          argMin(ai_trace_index.VendorVersion, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorVersion,
          min(tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorAt,
          max(ai_trace_index.Timestamp) AS traceAgentEnd,
          count() AS agentSpanCount,
          groupUniqArrayIf(20)(ai_trace_index.ServiceName, ai_trace_index.ServiceName != '') AS serviceNames,
          groupUniqArrayIf(20)(ai_trace_index.Model, ai_trace_index.Model != '') AS models,
          groupUniqArrayIf(20)(ai_trace_index.AgentName, ai_trace_index.AgentName != '') AS agentNames,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS firstAgentName,
          min(if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS firstAgentAt,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, IsToolCall), IsError = 1) AS failedSpans,
          groupArrayIf(2000)(tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1)), ai_trace_index.Tokens, ai_trace_index.Cost, ai_trace_index.ResponseId, ai_trace_index.IsLlmCall, ai_trace_index.InputTokens, ai_trace_index.CacheReadTokens, ai_trace_index.CacheWriteTokens, ai_trace_index.OutputTokens, ai_trace_index.ReasoningTokens), ((ai_trace_index.Tokens > 0 OR ai_trace_index.Cost > 0) OR ai_trace_index.IsLlmCall = 1)) AS usageSpans,
          groupArrayArray(4000)([tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)) * 2 + 0, if(ai_trace_index.Tokens > 0, if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1))) * 2 + 0), tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)) * 2 + 1, if(ai_trace_index.Cost > 0, if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1))) * 2 + 1)]) AS usageLinks,
          arrayMap(ancestors -> arrayMap((r, t, c) -> tupleConcat(r, (intDiv(t, 2), intDiv(c, 2))), usageSpans, arraySlice(ancestors, 1, length(usageSpans)), arraySlice(ancestors, length(usageSpans) + 1)), [arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayConcat(arrayMap(r -> r.2 * 2, usageSpans), arrayMap(r -> r.2 * 2 + 1, usageSpans))))])[1]))])[1]))])[1]))])[1]])[1] AS usageReporters
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-02 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-02 12:30:00'
        GROUP BY traceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0
          AND countIf(ai_trace_index.DeploymentEnv IN ('production')) > 0
          AND countIf(ai_trace_index.Model IN ('gpt-5.5')) > 0
          AND countIf(ai_trace_index.AgentName IN ('billing-agent')) > 0
          AND countIf(ai_trace_index.ToolName IN ('send_email')) > 0
          AND countIf((ai_trace_index.SessionId LIKE 'wrun\\_01%' OR ai_trace_index.TraceId LIKE 'wrun\\_01%')) > 0) AS agent_traces
        WHERE if(agent_traces.rawSessionId = '', concat('trace:', agent_traces.traceId), agent_traces.rawSessionId) IN ('wrun_sql_catalog', 'trace:7f3a4b5c6d7e8f901234567890abcdef'))
        GROUP BY traceId) AS session_traces
        INNER JOIN (SELECT
          agent_traces.traceId AS traceId,
          agent_traces.rawSessionId AS rawSessionId
        FROM (SELECT
          ai_trace_index.TraceId AS traceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          min(ai_trace_index.Timestamp) AS traceAgentStart,
          max(toUnixTimestamp64Nano(ai_trace_index.Timestamp) + toInt64(ai_trace_index.Duration)) AS traceAgentEndNanos,
          sum(ai_trace_index.IsToolCall) AS toolCalls,
          sum(ai_trace_index.IsError) AS errorAgentSpans,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorId,
          argMin(ai_trace_index.VendorVersion, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorVersion,
          min(tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorAt,
          max(ai_trace_index.Timestamp) AS traceAgentEnd,
          count() AS agentSpanCount,
          groupUniqArrayIf(20)(ai_trace_index.ServiceName, ai_trace_index.ServiceName != '') AS serviceNames,
          groupUniqArrayIf(20)(ai_trace_index.Model, ai_trace_index.Model != '') AS models,
          groupUniqArrayIf(20)(ai_trace_index.AgentName, ai_trace_index.AgentName != '') AS agentNames,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS firstAgentName,
          min(if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS firstAgentAt,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, IsToolCall), IsError = 1) AS failedSpans,
          groupArrayIf(2000)(tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1)), ai_trace_index.Tokens, ai_trace_index.Cost, ai_trace_index.ResponseId, ai_trace_index.IsLlmCall, ai_trace_index.InputTokens, ai_trace_index.CacheReadTokens, ai_trace_index.CacheWriteTokens, ai_trace_index.OutputTokens, ai_trace_index.ReasoningTokens), ((ai_trace_index.Tokens > 0 OR ai_trace_index.Cost > 0) OR ai_trace_index.IsLlmCall = 1)) AS usageSpans,
          groupArrayArray(4000)([tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)) * 2 + 0, if(ai_trace_index.Tokens > 0, if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1))) * 2 + 0), tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)) * 2 + 1, if(ai_trace_index.Cost > 0, if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1))) * 2 + 1)]) AS usageLinks,
          arrayMap(ancestors -> arrayMap((r, t, c) -> tupleConcat(r, (intDiv(t, 2), intDiv(c, 2))), usageSpans, arraySlice(ancestors, 1, length(usageSpans)), arraySlice(ancestors, length(usageSpans) + 1)), [arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayConcat(arrayMap(r -> r.2 * 2, usageSpans), arrayMap(r -> r.2 * 2 + 1, usageSpans))))])[1]))])[1]))])[1]))])[1]])[1] AS usageReporters
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-02 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-02 12:30:00'
        GROUP BY traceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0
          AND countIf(ai_trace_index.DeploymentEnv IN ('production')) > 0
          AND countIf(ai_trace_index.Model IN ('gpt-5.5')) > 0
          AND countIf(ai_trace_index.AgentName IN ('billing-agent')) > 0
          AND countIf(ai_trace_index.ToolName IN ('send_email')) > 0
          AND countIf((ai_trace_index.SessionId LIKE 'wrun\\_01%' OR ai_trace_index.TraceId LIKE 'wrun\\_01%')) > 0) AS agent_traces
        WHERE if(agent_traces.rawSessionId = '', concat('trace:', agent_traces.traceId), agent_traces.rawSessionId) IN ('wrun_sql_catalog', 'trace:7f3a4b5c6d7e8f901234567890abcdef')) AS index_traces ON session_traces.traceId = index_traces.traceId
        GROUP BY sessionId
        ORDER BY startTime DESC
        FORMAT JSON

-- builder:ai-sessions:aiSessionDetailsQuery:filtered
SELECT
          if(index_traces.rawSessionId = '', concat('trace:', session_traces.traceId), index_traces.rawSessionId) AS sessionId,
          sum(session_traces.spanCount) AS spanCount,
          sum(session_traces.errorSpanCount) AS errorSpanCount,
          groupUniqArrayArray(session_traces.serviceNames) AS serviceNames,
          toString(min(session_traces.traceStart)) AS startTime,
          toString(fromUnixTimestamp64Nano(max(session_traces.traceEndNanos))) AS endTime,
          intDiv(max(session_traces.traceEndNanos) - toUnixTimestamp64Nano(min(session_traces.traceStart)), 1000000) AS durationMs
        FROM (SELECT
          trace_detail_spans.TraceId AS traceId,
          count() AS spanCount,
          countIf((trace_detail_spans.StatusCode = 'Error' OR (trace_detail_spans.SpanAttributes['maple_ai.vendor.id'] != '' AND (trace_detail_spans.SpanAttributes['error.type'] != '' OR trace_detail_spans.SpanAttributes['gen_ai.response.status'] IN ('failed', 'error'))))) AS errorSpanCount,
          groupUniqArray(trace_detail_spans.ServiceName) AS serviceNames,
          min(trace_detail_spans.Timestamp) AS traceStart,
          max(toUnixTimestamp64Nano(trace_detail_spans.Timestamp) + toInt64(trace_detail_spans.Duration)) AS traceEndNanos
        FROM trace_detail_spans
        WHERE trace_detail_spans.OrgId = 'org_sql_catalog'
          AND trace_detail_spans.Timestamp >= '2026-01-02 09:30:00'
          AND trace_detail_spans.Timestamp <= '2026-01-02 13:30:00'
          AND trace_detail_spans.TraceId IN (SELECT
          agent_traces.traceId AS traceId
        FROM (SELECT
          ai_trace_index.TraceId AS traceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          min(ai_trace_index.Timestamp) AS traceAgentStart,
          max(toUnixTimestamp64Nano(ai_trace_index.Timestamp) + toInt64(ai_trace_index.Duration)) AS traceAgentEndNanos,
          sum(ai_trace_index.IsToolCall) AS toolCalls,
          sum(ai_trace_index.IsError) AS errorAgentSpans,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorId,
          argMin(ai_trace_index.VendorVersion, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorVersion,
          min(tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorAt,
          max(ai_trace_index.Timestamp) AS traceAgentEnd,
          count() AS agentSpanCount,
          groupUniqArrayIf(20)(ai_trace_index.ServiceName, ai_trace_index.ServiceName != '') AS serviceNames,
          groupUniqArrayIf(20)(ai_trace_index.Model, ai_trace_index.Model != '') AS models,
          groupUniqArrayIf(20)(ai_trace_index.AgentName, ai_trace_index.AgentName != '') AS agentNames,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS firstAgentName,
          min(if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS firstAgentAt,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, IsToolCall), IsError = 1) AS failedSpans,
          groupArrayIf(2000)(tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1)), ai_trace_index.Tokens, ai_trace_index.Cost, ai_trace_index.ResponseId, ai_trace_index.IsLlmCall, ai_trace_index.InputTokens, ai_trace_index.CacheReadTokens, ai_trace_index.CacheWriteTokens, ai_trace_index.OutputTokens, ai_trace_index.ReasoningTokens), ((ai_trace_index.Tokens > 0 OR ai_trace_index.Cost > 0) OR ai_trace_index.IsLlmCall = 1)) AS usageSpans,
          groupArrayArray(4000)([tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)) * 2 + 0, if(ai_trace_index.Tokens > 0, if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1))) * 2 + 0), tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)) * 2 + 1, if(ai_trace_index.Cost > 0, if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1))) * 2 + 1)]) AS usageLinks,
          arrayMap(ancestors -> arrayMap((r, t, c) -> tupleConcat(r, (intDiv(t, 2), intDiv(c, 2))), usageSpans, arraySlice(ancestors, 1, length(usageSpans)), arraySlice(ancestors, length(usageSpans) + 1)), [arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayConcat(arrayMap(r -> r.2 * 2, usageSpans), arrayMap(r -> r.2 * 2 + 1, usageSpans))))])[1]))])[1]))])[1]))])[1]])[1] AS usageReporters
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-02 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-02 12:30:00'
        GROUP BY traceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0
          AND countIf(ai_trace_index.VendorId IN ('eve')) > 0
          AND countIf(ai_trace_index.ServiceName IN ('maple-slack-agent')) > 0) AS agent_traces
        WHERE if(agent_traces.rawSessionId = '', concat('trace:', agent_traces.traceId), agent_traces.rawSessionId) IN ('wrun_sql_catalog', 'trace:7f3a4b5c6d7e8f901234567890abcdef'))
        GROUP BY traceId) AS session_traces
        INNER JOIN (SELECT
          agent_traces.traceId AS traceId,
          agent_traces.rawSessionId AS rawSessionId
        FROM (SELECT
          ai_trace_index.TraceId AS traceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          min(ai_trace_index.Timestamp) AS traceAgentStart,
          max(toUnixTimestamp64Nano(ai_trace_index.Timestamp) + toInt64(ai_trace_index.Duration)) AS traceAgentEndNanos,
          sum(ai_trace_index.IsToolCall) AS toolCalls,
          sum(ai_trace_index.IsError) AS errorAgentSpans,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorId,
          argMin(ai_trace_index.VendorVersion, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorVersion,
          min(tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorAt,
          max(ai_trace_index.Timestamp) AS traceAgentEnd,
          count() AS agentSpanCount,
          groupUniqArrayIf(20)(ai_trace_index.ServiceName, ai_trace_index.ServiceName != '') AS serviceNames,
          groupUniqArrayIf(20)(ai_trace_index.Model, ai_trace_index.Model != '') AS models,
          groupUniqArrayIf(20)(ai_trace_index.AgentName, ai_trace_index.AgentName != '') AS agentNames,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS firstAgentName,
          min(if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS firstAgentAt,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, IsToolCall), IsError = 1) AS failedSpans,
          groupArrayIf(2000)(tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1)), ai_trace_index.Tokens, ai_trace_index.Cost, ai_trace_index.ResponseId, ai_trace_index.IsLlmCall, ai_trace_index.InputTokens, ai_trace_index.CacheReadTokens, ai_trace_index.CacheWriteTokens, ai_trace_index.OutputTokens, ai_trace_index.ReasoningTokens), ((ai_trace_index.Tokens > 0 OR ai_trace_index.Cost > 0) OR ai_trace_index.IsLlmCall = 1)) AS usageSpans,
          groupArrayArray(4000)([tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)) * 2 + 0, if(ai_trace_index.Tokens > 0, if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1))) * 2 + 0), tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)) * 2 + 1, if(ai_trace_index.Cost > 0, if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1))) * 2 + 1)]) AS usageLinks,
          arrayMap(ancestors -> arrayMap((r, t, c) -> tupleConcat(r, (intDiv(t, 2), intDiv(c, 2))), usageSpans, arraySlice(ancestors, 1, length(usageSpans)), arraySlice(ancestors, length(usageSpans) + 1)), [arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayConcat(arrayMap(r -> r.2 * 2, usageSpans), arrayMap(r -> r.2 * 2 + 1, usageSpans))))])[1]))])[1]))])[1]))])[1]])[1] AS usageReporters
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-02 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-02 12:30:00'
        GROUP BY traceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0
          AND countIf(ai_trace_index.VendorId IN ('eve')) > 0
          AND countIf(ai_trace_index.ServiceName IN ('maple-slack-agent')) > 0) AS agent_traces
        WHERE if(agent_traces.rawSessionId = '', concat('trace:', agent_traces.traceId), agent_traces.rawSessionId) IN ('wrun_sql_catalog', 'trace:7f3a4b5c6d7e8f901234567890abcdef')) AS index_traces ON session_traces.traceId = index_traces.traceId
        GROUP BY sessionId
        ORDER BY startTime DESC
        FORMAT JSON

-- builder:ai-sessions:aiSessionDistributionsQuery:default
SELECT
          tupleElement(measured, 1) AS measure,
          sumMap(map(toString(tupleElement(measured, 3)), toUInt64(1))) AS buckets,
          quantile(0.5)(tupleElement(measured, 2)) AS p50,
          quantile(0.95)(tupleElement(measured, 2)) AS p95
        FROM (SELECT
          arrayJoin([tuple('durationMs', durationMs, pow(2, floor(log2(greatest(durationMs / 1000, 1)) * 2) / 2) * 1000), tuple('cost', cost, pow(2, floor(log2(greatest(cost, 0.001)) * 2) / 2)), tuple('totalTokens', totalTokens, pow(2, floor(log2(totalTokens)))), tuple('llmCalls', llmCalls, pow(2, floor(log2(llmCalls)))), tuple('toolCalls', toolCalls, pow(2, floor(log2(toolCalls))))]) AS measured
        FROM (SELECT
          toFloat64(netted_sessions.agentDurationMs) AS durationMs,
          toFloat64(netted_sessions.toolCalls) AS toolCalls,
          toFloat64(arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 2)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, toFloat64(n.2)), arrayFilter(n -> n.1 != '', netted)))))) AS llmCalls,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 3)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.3), arrayFilter(n -> n.1 != '', netted))))) AS totalTokens,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 4)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.4), arrayFilter(n -> n.1 != '', netted))))) AS cost
        FROM (SELECT
          window_sessions.agentDurationMs AS agentDurationMs,
          window_sessions.toolCalls AS toolCalls,
          arrayMap(charged -> arrayMap((r, own, tokenAncestor, costAncestor, parent) -> tuple(r.5, r.6 = 1 AND if((r.3 > 0 OR r.4 > 0), greatest(0., r.3 - own.1) > 0 OR greatest(0., r.4 - own.2) > 0, tokenAncestor.8 = 0 AND costAncestor.8 = 0 AND parent.8 = 0), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.3 - own.1)), if(r.6 = 0 AND own.2 > 0, 0., greatest(0., r.4 - own.2)), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.7 - own.3)), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.8 - own.4)), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.9 - own.5)), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.10 - own.6)), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.11 - own.7))), reporters, arraySlice(charged, 0 * length(reporters) + 1, length(reporters)), arraySlice(charged, 1 * length(reporters) + 1, length(reporters)), arraySlice(charged, 2 * length(reporters) + 1, length(reporters)), arraySlice(charged, 3 * length(reporters) + 1, length(reporters))), [arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), arrayMap(claims -> arrayZip(claims.1, arrayZip(claims.2, claims.3, claims.4, claims.5, claims.6, claims.7, claims.8, claims.9)), [arrayReduce('sumMap', arrayMap(r -> [r.12, r.13, r.1], reporters), arrayMap(r -> [r.3, 0., 0.], reporters), arrayMap(r -> [0., r.4, 0.], reporters), arrayMap(r -> [r.7, 0., 0.], reporters), arrayMap(r -> [r.8, 0., 0.], reporters), arrayMap(r -> [r.9, 0., 0.], reporters), arrayMap(r -> [r.10, 0., 0.], reporters), arrayMap(r -> [r.11, 0., 0.], reporters), arrayMap(r -> [0., 0., 1.], reporters))])[1]), arrayMap(k -> (k, 1, (0., 0., 0., 0., 0., 0., 0., 0.)), arrayConcat(tupleElement(reporters, 1), tupleElement(reporters, 12), tupleElement(reporters, 13), tupleElement(reporters, 2))))])[1]])[1] AS netted
        FROM (SELECT
          if(index_traces.rawSessionId = '', concat('trace:', index_traces.traceId), index_traces.rawSessionId) AS sessionId,
          toString(min(index_traces.traceAgentStart)) AS agentStart,
          toString(fromUnixTimestamp64Nano(max(index_traces.traceAgentEndNanos))) AS agentEnd,
          sum(index_traces.toolCalls) AS toolCalls,
          sum(index_traces.errorAgentSpans) AS errorAgentSpans,
          intDiv(max(index_traces.traceAgentEndNanos) - toUnixTimestamp64Nano(min(index_traces.traceAgentStart)), 1000000) AS agentDurationMs,
          argMin(index_traces.vendorId, index_traces.vendorAt) AS vendorId,
          argMin(index_traces.vendorVersion, index_traces.vendorAt) AS vendorVersion,
          count() AS traceCount,
          sum(index_traces.agentSpanCount) AS spanCount,
          groupUniqArrayArray(index_traces.serviceNames) AS serviceNames,
          groupUniqArrayArray(index_traces.models) AS models,
          groupUniqArrayArray(index_traces.agentNames) AS agentNames,
          argMin(index_traces.firstAgentName, index_traces.firstAgentAt) AS firstAgentName,
          sum(arrayCount(f -> f.3 = 1 AND NOT has(tupleElement(failedSpans, 2), f.1), failedSpans)) AS toolErrors,
          sum(arrayCount(f -> f.3 != 1 AND NOT has(tupleElement(failedSpans, 2), f.1), failedSpans)) AS turnErrors,
          groupArrayArray(2000)(usageReporters) AS reporters
        FROM (SELECT
          ai_trace_index.TraceId AS traceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          min(ai_trace_index.Timestamp) AS traceAgentStart,
          max(toUnixTimestamp64Nano(ai_trace_index.Timestamp) + toInt64(ai_trace_index.Duration)) AS traceAgentEndNanos,
          sum(ai_trace_index.IsToolCall) AS toolCalls,
          sum(ai_trace_index.IsError) AS errorAgentSpans,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorId,
          argMin(ai_trace_index.VendorVersion, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorVersion,
          min(tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorAt,
          max(ai_trace_index.Timestamp) AS traceAgentEnd,
          count() AS agentSpanCount,
          groupUniqArrayIf(20)(ai_trace_index.ServiceName, ai_trace_index.ServiceName != '') AS serviceNames,
          groupUniqArrayIf(20)(ai_trace_index.Model, ai_trace_index.Model != '') AS models,
          groupUniqArrayIf(20)(ai_trace_index.AgentName, ai_trace_index.AgentName != '') AS agentNames,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS firstAgentName,
          min(if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS firstAgentAt,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, IsToolCall), IsError = 1) AS failedSpans,
          groupArrayIf(2000)(tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1)), ai_trace_index.Tokens, ai_trace_index.Cost, ai_trace_index.ResponseId, ai_trace_index.IsLlmCall, ai_trace_index.InputTokens, ai_trace_index.CacheReadTokens, ai_trace_index.CacheWriteTokens, ai_trace_index.OutputTokens, ai_trace_index.ReasoningTokens), ((ai_trace_index.Tokens > 0 OR ai_trace_index.Cost > 0) OR ai_trace_index.IsLlmCall = 1)) AS usageSpans,
          groupArrayArray(4000)([tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)) * 2 + 0, if(ai_trace_index.Tokens > 0, if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1))) * 2 + 0), tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)) * 2 + 1, if(ai_trace_index.Cost > 0, if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1))) * 2 + 1)]) AS usageLinks,
          arrayMap(ancestors -> arrayMap((r, t, c) -> tupleConcat(r, (intDiv(t, 2), intDiv(c, 2))), usageSpans, arraySlice(ancestors, 1, length(usageSpans)), arraySlice(ancestors, length(usageSpans) + 1)), [arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayConcat(arrayMap(r -> r.2 * 2, usageSpans), arrayMap(r -> r.2 * 2 + 1, usageSpans))))])[1]))])[1]))])[1]))])[1]])[1] AS usageReporters
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY traceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS index_traces
        GROUP BY sessionId) AS window_sessions) AS netted_sessions) AS session_measures) AS measured_sessions
        WHERE tupleElement(measured, 2) > 0
        GROUP BY measure
        FORMAT JSON

-- builder:ai-sessions:aiSessionFacetsQuery:default
SELECT
          arrayJoin(facet_traces.names) AS name,
          uniqExact(if(facet_traces.rawSessionId = '', concat('trace:', facet_traces.traceId), facet_traces.rawSessionId)) AS count,
          'vendor' AS facetType
        FROM (SELECT
          ai_trace_index.TraceId AS traceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          groupUniqArrayIf(20)(ai_trace_index.VendorId, ai_trace_index.VendorId != '') AS names
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY traceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS facet_traces
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          arrayJoin(facet_traces.names) AS name,
          uniqExact(if(facet_traces.rawSessionId = '', concat('trace:', facet_traces.traceId), facet_traces.rawSessionId)) AS count,
          'service' AS facetType
        FROM (SELECT
          ai_trace_index.TraceId AS traceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          groupUniqArrayIf(20)(ai_trace_index.ServiceName, ai_trace_index.ServiceName != '') AS names
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY traceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS facet_traces
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          arrayJoin(facet_traces.names) AS name,
          uniqExact(if(facet_traces.rawSessionId = '', concat('trace:', facet_traces.traceId), facet_traces.rawSessionId)) AS count,
          'environment' AS facetType
        FROM (SELECT
          ai_trace_index.TraceId AS traceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          groupUniqArrayIf(20)(ai_trace_index.DeploymentEnv, ai_trace_index.DeploymentEnv != '') AS names
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY traceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS facet_traces
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          arrayJoin(facet_traces.names) AS name,
          uniqExact(if(facet_traces.rawSessionId = '', concat('trace:', facet_traces.traceId), facet_traces.rawSessionId)) AS count,
          'model' AS facetType
        FROM (SELECT
          ai_trace_index.TraceId AS traceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          groupUniqArrayIf(20)(ai_trace_index.Model, ai_trace_index.Model != '') AS names
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY traceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS facet_traces
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          arrayJoin(facet_traces.names) AS name,
          uniqExact(if(facet_traces.rawSessionId = '', concat('trace:', facet_traces.traceId), facet_traces.rawSessionId)) AS count,
          'agent' AS facetType
        FROM (SELECT
          ai_trace_index.TraceId AS traceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          groupUniqArrayIf(20)(ai_trace_index.AgentName, ai_trace_index.AgentName != '') AS names
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY traceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS facet_traces
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          arrayJoin(facet_traces.names) AS name,
          uniqExact(if(facet_traces.rawSessionId = '', concat('trace:', facet_traces.traceId), facet_traces.rawSessionId)) AS count,
          'tool' AS facetType
        FROM (SELECT
          ai_trace_index.TraceId AS traceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          groupUniqArrayIf(20)(ai_trace_index.ToolName, ai_trace_index.ToolName != '') AS names
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY traceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS facet_traces
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
FORMAT JSON

-- builder:ai-sessions:aiSessionPageQuery:default
SELECT
          netted_sessions.sessionId AS sessionId,
          netted_sessions.vendorId AS vendorId,
          netted_sessions.vendorVersion AS vendorVersion,
          netted_sessions.agentStart AS agentStart,
          netted_sessions.agentEnd AS agentEnd,
          netted_sessions.traceCount AS traceCount,
          netted_sessions.spanCount AS spanCount,
          netted_sessions.serviceNames AS serviceNames,
          netted_sessions.models AS models,
          netted_sessions.agentNames AS agentNames,
          netted_sessions.firstAgentName AS firstAgentName,
          netted_sessions.toolCalls AS toolCalls,
          netted_sessions.errorAgentSpans AS errorAgentSpans,
          netted_sessions.toolErrors AS toolErrors,
          netted_sessions.turnErrors AS turnErrors,
          netted_sessions.agentDurationMs AS agentDurationMs,
          toFloat64(arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 2)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, toFloat64(n.2)), arrayFilter(n -> n.1 != '', netted)))))) AS llmCalls,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 3)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.3), arrayFilter(n -> n.1 != '', netted))))) AS totalTokens,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 4)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.4), arrayFilter(n -> n.1 != '', netted))))) AS cost,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 5)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.5), arrayFilter(n -> n.1 != '', netted))))) AS inputTokens,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 6)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.6), arrayFilter(n -> n.1 != '', netted))))) AS cacheReadTokens,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 7)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.7), arrayFilter(n -> n.1 != '', netted))))) AS cacheWriteTokens,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 8)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.8), arrayFilter(n -> n.1 != '', netted))))) AS outputTokens,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 9)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.9), arrayFilter(n -> n.1 != '', netted))))) AS reasoningTokens
        FROM (SELECT
          ranked_sessions.sessionId AS sessionId,
          ranked_sessions.vendorId AS vendorId,
          ranked_sessions.vendorVersion AS vendorVersion,
          ranked_sessions.agentStart AS agentStart,
          ranked_sessions.agentEnd AS agentEnd,
          ranked_sessions.traceCount AS traceCount,
          ranked_sessions.spanCount AS spanCount,
          ranked_sessions.serviceNames AS serviceNames,
          ranked_sessions.models AS models,
          ranked_sessions.agentNames AS agentNames,
          ranked_sessions.firstAgentName AS firstAgentName,
          ranked_sessions.toolCalls AS toolCalls,
          ranked_sessions.errorAgentSpans AS errorAgentSpans,
          ranked_sessions.toolErrors AS toolErrors,
          ranked_sessions.turnErrors AS turnErrors,
          ranked_sessions.agentDurationMs AS agentDurationMs,
          arrayMap(charged -> arrayMap((r, own, tokenAncestor, costAncestor, parent) -> tuple(r.5, r.6 = 1 AND if((r.3 > 0 OR r.4 > 0), greatest(0., r.3 - own.1) > 0 OR greatest(0., r.4 - own.2) > 0, tokenAncestor.8 = 0 AND costAncestor.8 = 0 AND parent.8 = 0), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.3 - own.1)), if(r.6 = 0 AND own.2 > 0, 0., greatest(0., r.4 - own.2)), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.7 - own.3)), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.8 - own.4)), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.9 - own.5)), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.10 - own.6)), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.11 - own.7))), reporters, arraySlice(charged, 0 * length(reporters) + 1, length(reporters)), arraySlice(charged, 1 * length(reporters) + 1, length(reporters)), arraySlice(charged, 2 * length(reporters) + 1, length(reporters)), arraySlice(charged, 3 * length(reporters) + 1, length(reporters))), [arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), arrayMap(claims -> arrayZip(claims.1, arrayZip(claims.2, claims.3, claims.4, claims.5, claims.6, claims.7, claims.8, claims.9)), [arrayReduce('sumMap', arrayMap(r -> [r.12, r.13, r.1], reporters), arrayMap(r -> [r.3, 0., 0.], reporters), arrayMap(r -> [0., r.4, 0.], reporters), arrayMap(r -> [r.7, 0., 0.], reporters), arrayMap(r -> [r.8, 0., 0.], reporters), arrayMap(r -> [r.9, 0., 0.], reporters), arrayMap(r -> [r.10, 0., 0.], reporters), arrayMap(r -> [r.11, 0., 0.], reporters), arrayMap(r -> [0., 0., 1.], reporters))])[1]), arrayMap(k -> (k, 1, (0., 0., 0., 0., 0., 0., 0., 0.)), arrayConcat(tupleElement(reporters, 1), tupleElement(reporters, 12), tupleElement(reporters, 13), tupleElement(reporters, 2))))])[1]])[1] AS netted
        FROM (SELECT
          if(index_traces.rawSessionId = '', concat('trace:', index_traces.traceId), index_traces.rawSessionId) AS sessionId,
          toString(min(index_traces.traceAgentStart)) AS agentStart,
          toString(fromUnixTimestamp64Nano(max(index_traces.traceAgentEndNanos))) AS agentEnd,
          sum(index_traces.toolCalls) AS toolCalls,
          sum(index_traces.errorAgentSpans) AS errorAgentSpans,
          intDiv(max(index_traces.traceAgentEndNanos) - toUnixTimestamp64Nano(min(index_traces.traceAgentStart)), 1000000) AS agentDurationMs,
          argMin(index_traces.vendorId, index_traces.vendorAt) AS vendorId,
          argMin(index_traces.vendorVersion, index_traces.vendorAt) AS vendorVersion,
          count() AS traceCount,
          sum(index_traces.agentSpanCount) AS spanCount,
          groupUniqArrayArray(index_traces.serviceNames) AS serviceNames,
          groupUniqArrayArray(index_traces.models) AS models,
          groupUniqArrayArray(index_traces.agentNames) AS agentNames,
          argMin(index_traces.firstAgentName, index_traces.firstAgentAt) AS firstAgentName,
          sum(arrayCount(f -> f.3 = 1 AND NOT has(tupleElement(failedSpans, 2), f.1), failedSpans)) AS toolErrors,
          sum(arrayCount(f -> f.3 != 1 AND NOT has(tupleElement(failedSpans, 2), f.1), failedSpans)) AS turnErrors,
          groupArrayArray(2000)(usageReporters) AS reporters
        FROM (SELECT
          ai_trace_index.TraceId AS traceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          min(ai_trace_index.Timestamp) AS traceAgentStart,
          max(toUnixTimestamp64Nano(ai_trace_index.Timestamp) + toInt64(ai_trace_index.Duration)) AS traceAgentEndNanos,
          sum(ai_trace_index.IsToolCall) AS toolCalls,
          sum(ai_trace_index.IsError) AS errorAgentSpans,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorId,
          argMin(ai_trace_index.VendorVersion, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorVersion,
          min(tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorAt,
          max(ai_trace_index.Timestamp) AS traceAgentEnd,
          count() AS agentSpanCount,
          groupUniqArrayIf(20)(ai_trace_index.ServiceName, ai_trace_index.ServiceName != '') AS serviceNames,
          groupUniqArrayIf(20)(ai_trace_index.Model, ai_trace_index.Model != '') AS models,
          groupUniqArrayIf(20)(ai_trace_index.AgentName, ai_trace_index.AgentName != '') AS agentNames,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS firstAgentName,
          min(if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS firstAgentAt,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, IsToolCall), IsError = 1) AS failedSpans,
          groupArrayIf(2000)(tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1)), ai_trace_index.Tokens, ai_trace_index.Cost, ai_trace_index.ResponseId, ai_trace_index.IsLlmCall, ai_trace_index.InputTokens, ai_trace_index.CacheReadTokens, ai_trace_index.CacheWriteTokens, ai_trace_index.OutputTokens, ai_trace_index.ReasoningTokens), ((ai_trace_index.Tokens > 0 OR ai_trace_index.Cost > 0) OR ai_trace_index.IsLlmCall = 1)) AS usageSpans,
          groupArrayArray(4000)([tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)) * 2 + 0, if(ai_trace_index.Tokens > 0, if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1))) * 2 + 0), tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)) * 2 + 1, if(ai_trace_index.Cost > 0, if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1))) * 2 + 1)]) AS usageLinks,
          arrayMap(ancestors -> arrayMap((r, t, c) -> tupleConcat(r, (intDiv(t, 2), intDiv(c, 2))), usageSpans, arraySlice(ancestors, 1, length(usageSpans)), arraySlice(ancestors, length(usageSpans) + 1)), [arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayConcat(arrayMap(r -> r.2 * 2, usageSpans), arrayMap(r -> r.2 * 2 + 1, usageSpans))))])[1]))])[1]))])[1]))])[1]])[1] AS usageReporters
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY traceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS index_traces
        GROUP BY sessionId
        ORDER BY agentStart DESC, sessionId ASC
        LIMIT 50) AS ranked_sessions) AS netted_sessions
        ORDER BY agentStart DESC, sessionId ASC
        FORMAT JSON

-- builder:ai-sessions:aiSessionPageQuery:every-filter
SELECT
          netted_sessions.sessionId AS sessionId,
          netted_sessions.vendorId AS vendorId,
          netted_sessions.vendorVersion AS vendorVersion,
          netted_sessions.agentStart AS agentStart,
          netted_sessions.agentEnd AS agentEnd,
          netted_sessions.traceCount AS traceCount,
          netted_sessions.spanCount AS spanCount,
          netted_sessions.serviceNames AS serviceNames,
          netted_sessions.models AS models,
          netted_sessions.agentNames AS agentNames,
          netted_sessions.firstAgentName AS firstAgentName,
          netted_sessions.toolCalls AS toolCalls,
          netted_sessions.errorAgentSpans AS errorAgentSpans,
          netted_sessions.toolErrors AS toolErrors,
          netted_sessions.turnErrors AS turnErrors,
          netted_sessions.agentDurationMs AS agentDurationMs,
          toFloat64(arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 2)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, toFloat64(n.2)), arrayFilter(n -> n.1 != '', netted)))))) AS llmCalls,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 3)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.3), arrayFilter(n -> n.1 != '', netted))))) AS totalTokens,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 4)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.4), arrayFilter(n -> n.1 != '', netted))))) AS cost,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 5)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.5), arrayFilter(n -> n.1 != '', netted))))) AS inputTokens,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 6)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.6), arrayFilter(n -> n.1 != '', netted))))) AS cacheReadTokens,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 7)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.7), arrayFilter(n -> n.1 != '', netted))))) AS cacheWriteTokens,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 8)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.8), arrayFilter(n -> n.1 != '', netted))))) AS outputTokens,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 9)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.9), arrayFilter(n -> n.1 != '', netted))))) AS reasoningTokens
        FROM (SELECT
          ranked_sessions.sessionId AS sessionId,
          ranked_sessions.vendorId AS vendorId,
          ranked_sessions.vendorVersion AS vendorVersion,
          ranked_sessions.agentStart AS agentStart,
          ranked_sessions.agentEnd AS agentEnd,
          ranked_sessions.traceCount AS traceCount,
          ranked_sessions.spanCount AS spanCount,
          ranked_sessions.serviceNames AS serviceNames,
          ranked_sessions.models AS models,
          ranked_sessions.agentNames AS agentNames,
          ranked_sessions.firstAgentName AS firstAgentName,
          ranked_sessions.toolCalls AS toolCalls,
          ranked_sessions.errorAgentSpans AS errorAgentSpans,
          ranked_sessions.toolErrors AS toolErrors,
          ranked_sessions.turnErrors AS turnErrors,
          ranked_sessions.agentDurationMs AS agentDurationMs,
          arrayMap(charged -> arrayMap((r, own, tokenAncestor, costAncestor, parent) -> tuple(r.5, r.6 = 1 AND if((r.3 > 0 OR r.4 > 0), greatest(0., r.3 - own.1) > 0 OR greatest(0., r.4 - own.2) > 0, tokenAncestor.8 = 0 AND costAncestor.8 = 0 AND parent.8 = 0), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.3 - own.1)), if(r.6 = 0 AND own.2 > 0, 0., greatest(0., r.4 - own.2)), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.7 - own.3)), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.8 - own.4)), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.9 - own.5)), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.10 - own.6)), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.11 - own.7))), reporters, arraySlice(charged, 0 * length(reporters) + 1, length(reporters)), arraySlice(charged, 1 * length(reporters) + 1, length(reporters)), arraySlice(charged, 2 * length(reporters) + 1, length(reporters)), arraySlice(charged, 3 * length(reporters) + 1, length(reporters))), [arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), arrayMap(claims -> arrayZip(claims.1, arrayZip(claims.2, claims.3, claims.4, claims.5, claims.6, claims.7, claims.8, claims.9)), [arrayReduce('sumMap', arrayMap(r -> [r.12, r.13, r.1], reporters), arrayMap(r -> [r.3, 0., 0.], reporters), arrayMap(r -> [0., r.4, 0.], reporters), arrayMap(r -> [r.7, 0., 0.], reporters), arrayMap(r -> [r.8, 0., 0.], reporters), arrayMap(r -> [r.9, 0., 0.], reporters), arrayMap(r -> [r.10, 0., 0.], reporters), arrayMap(r -> [r.11, 0., 0.], reporters), arrayMap(r -> [0., 0., 1.], reporters))])[1]), arrayMap(k -> (k, 1, (0., 0., 0., 0., 0., 0., 0., 0.)), arrayConcat(tupleElement(reporters, 1), tupleElement(reporters, 12), tupleElement(reporters, 13), tupleElement(reporters, 2))))])[1]])[1] AS netted
        FROM (SELECT
          if(index_traces.rawSessionId = '', concat('trace:', index_traces.traceId), index_traces.rawSessionId) AS sessionId,
          toString(min(index_traces.traceAgentStart)) AS agentStart,
          toString(fromUnixTimestamp64Nano(max(index_traces.traceAgentEndNanos))) AS agentEnd,
          sum(index_traces.toolCalls) AS toolCalls,
          sum(index_traces.errorAgentSpans) AS errorAgentSpans,
          intDiv(max(index_traces.traceAgentEndNanos) - toUnixTimestamp64Nano(min(index_traces.traceAgentStart)), 1000000) AS agentDurationMs,
          argMin(index_traces.vendorId, index_traces.vendorAt) AS vendorId,
          argMin(index_traces.vendorVersion, index_traces.vendorAt) AS vendorVersion,
          count() AS traceCount,
          sum(index_traces.agentSpanCount) AS spanCount,
          groupUniqArrayArray(index_traces.serviceNames) AS serviceNames,
          groupUniqArrayArray(index_traces.models) AS models,
          groupUniqArrayArray(index_traces.agentNames) AS agentNames,
          argMin(index_traces.firstAgentName, index_traces.firstAgentAt) AS firstAgentName,
          sum(arrayCount(f -> f.3 = 1 AND NOT has(tupleElement(failedSpans, 2), f.1), failedSpans)) AS toolErrors,
          sum(arrayCount(f -> f.3 != 1 AND NOT has(tupleElement(failedSpans, 2), f.1), failedSpans)) AS turnErrors,
          groupArrayArray(2000)(usageReporters) AS reporters
        FROM (SELECT
          ai_trace_index.TraceId AS traceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          min(ai_trace_index.Timestamp) AS traceAgentStart,
          max(toUnixTimestamp64Nano(ai_trace_index.Timestamp) + toInt64(ai_trace_index.Duration)) AS traceAgentEndNanos,
          sum(ai_trace_index.IsToolCall) AS toolCalls,
          sum(ai_trace_index.IsError) AS errorAgentSpans,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorId,
          argMin(ai_trace_index.VendorVersion, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorVersion,
          min(tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorAt,
          max(ai_trace_index.Timestamp) AS traceAgentEnd,
          count() AS agentSpanCount,
          groupUniqArrayIf(20)(ai_trace_index.ServiceName, ai_trace_index.ServiceName != '') AS serviceNames,
          groupUniqArrayIf(20)(ai_trace_index.Model, ai_trace_index.Model != '') AS models,
          groupUniqArrayIf(20)(ai_trace_index.AgentName, ai_trace_index.AgentName != '') AS agentNames,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS firstAgentName,
          min(if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS firstAgentAt,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, IsToolCall), IsError = 1) AS failedSpans,
          groupArrayIf(2000)(tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1)), ai_trace_index.Tokens, ai_trace_index.Cost, ai_trace_index.ResponseId, ai_trace_index.IsLlmCall, ai_trace_index.InputTokens, ai_trace_index.CacheReadTokens, ai_trace_index.CacheWriteTokens, ai_trace_index.OutputTokens, ai_trace_index.ReasoningTokens), ((ai_trace_index.Tokens > 0 OR ai_trace_index.Cost > 0) OR ai_trace_index.IsLlmCall = 1)) AS usageSpans,
          groupArrayArray(4000)([tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)) * 2 + 0, if(ai_trace_index.Tokens > 0, if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1))) * 2 + 0), tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)) * 2 + 1, if(ai_trace_index.Cost > 0, if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1))) * 2 + 1)]) AS usageLinks,
          arrayMap(ancestors -> arrayMap((r, t, c) -> tupleConcat(r, (intDiv(t, 2), intDiv(c, 2))), usageSpans, arraySlice(ancestors, 1, length(usageSpans)), arraySlice(ancestors, length(usageSpans) + 1)), [arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayConcat(arrayMap(r -> r.2 * 2, usageSpans), arrayMap(r -> r.2 * 2 + 1, usageSpans))))])[1]))])[1]))])[1]))])[1]])[1] AS usageReporters
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY traceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0
          AND countIf(ai_trace_index.VendorId IN ('eve')) > 0
          AND countIf(ai_trace_index.ServiceName IN ('maple-slack-agent')) > 0
          AND countIf(ai_trace_index.DeploymentEnv IN ('production')) > 0
          AND countIf(ai_trace_index.Model IN ('gpt-5.5')) > 0
          AND countIf(ai_trace_index.AgentName IN ('billing-agent')) > 0
          AND countIf(ai_trace_index.ToolName IN ('send_email')) > 0
          AND countIf((ai_trace_index.SessionId LIKE 'wrun\\_01%' OR ai_trace_index.TraceId LIKE 'wrun\\_01%')) > 0) AS index_traces
        GROUP BY sessionId
        HAVING errorAgentSpans > 0
          AND NOT (sessionId LIKE 'trace:%')
          AND agentDurationMs >= 1000
          AND agentDurationMs <= 600000
          AND toolCalls >= 1
          AND toolCalls <= 50) AS ranked_sessions) AS netted_sessions
        WHERE cost >= 0.01
          AND cost <= 5
          AND totalTokens >= 100
          AND totalTokens <= 1000000
          AND llmCalls >= 1
          AND llmCalls <= 50
        ORDER BY cost ASC, agentStart DESC, sessionId ASC
        LIMIT 25
        OFFSET 25
        FORMAT JSON

-- builder:ai-sessions:aiSessionPageQuery:filtered
SELECT
          netted_sessions.sessionId AS sessionId,
          netted_sessions.vendorId AS vendorId,
          netted_sessions.vendorVersion AS vendorVersion,
          netted_sessions.agentStart AS agentStart,
          netted_sessions.agentEnd AS agentEnd,
          netted_sessions.traceCount AS traceCount,
          netted_sessions.spanCount AS spanCount,
          netted_sessions.serviceNames AS serviceNames,
          netted_sessions.models AS models,
          netted_sessions.agentNames AS agentNames,
          netted_sessions.firstAgentName AS firstAgentName,
          netted_sessions.toolCalls AS toolCalls,
          netted_sessions.errorAgentSpans AS errorAgentSpans,
          netted_sessions.toolErrors AS toolErrors,
          netted_sessions.turnErrors AS turnErrors,
          netted_sessions.agentDurationMs AS agentDurationMs,
          toFloat64(arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 2)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, toFloat64(n.2)), arrayFilter(n -> n.1 != '', netted)))))) AS llmCalls,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 3)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.3), arrayFilter(n -> n.1 != '', netted))))) AS totalTokens,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 4)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.4), arrayFilter(n -> n.1 != '', netted))))) AS cost,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 5)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.5), arrayFilter(n -> n.1 != '', netted))))) AS inputTokens,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 6)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.6), arrayFilter(n -> n.1 != '', netted))))) AS cacheReadTokens,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 7)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.7), arrayFilter(n -> n.1 != '', netted))))) AS cacheWriteTokens,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 8)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.8), arrayFilter(n -> n.1 != '', netted))))) AS outputTokens,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 9)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.9), arrayFilter(n -> n.1 != '', netted))))) AS reasoningTokens
        FROM (SELECT
          ranked_sessions.sessionId AS sessionId,
          ranked_sessions.vendorId AS vendorId,
          ranked_sessions.vendorVersion AS vendorVersion,
          ranked_sessions.agentStart AS agentStart,
          ranked_sessions.agentEnd AS agentEnd,
          ranked_sessions.traceCount AS traceCount,
          ranked_sessions.spanCount AS spanCount,
          ranked_sessions.serviceNames AS serviceNames,
          ranked_sessions.models AS models,
          ranked_sessions.agentNames AS agentNames,
          ranked_sessions.firstAgentName AS firstAgentName,
          ranked_sessions.toolCalls AS toolCalls,
          ranked_sessions.errorAgentSpans AS errorAgentSpans,
          ranked_sessions.toolErrors AS toolErrors,
          ranked_sessions.turnErrors AS turnErrors,
          ranked_sessions.agentDurationMs AS agentDurationMs,
          arrayMap(charged -> arrayMap((r, own, tokenAncestor, costAncestor, parent) -> tuple(r.5, r.6 = 1 AND if((r.3 > 0 OR r.4 > 0), greatest(0., r.3 - own.1) > 0 OR greatest(0., r.4 - own.2) > 0, tokenAncestor.8 = 0 AND costAncestor.8 = 0 AND parent.8 = 0), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.3 - own.1)), if(r.6 = 0 AND own.2 > 0, 0., greatest(0., r.4 - own.2)), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.7 - own.3)), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.8 - own.4)), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.9 - own.5)), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.10 - own.6)), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.11 - own.7))), reporters, arraySlice(charged, 0 * length(reporters) + 1, length(reporters)), arraySlice(charged, 1 * length(reporters) + 1, length(reporters)), arraySlice(charged, 2 * length(reporters) + 1, length(reporters)), arraySlice(charged, 3 * length(reporters) + 1, length(reporters))), [arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), arrayMap(claims -> arrayZip(claims.1, arrayZip(claims.2, claims.3, claims.4, claims.5, claims.6, claims.7, claims.8, claims.9)), [arrayReduce('sumMap', arrayMap(r -> [r.12, r.13, r.1], reporters), arrayMap(r -> [r.3, 0., 0.], reporters), arrayMap(r -> [0., r.4, 0.], reporters), arrayMap(r -> [r.7, 0., 0.], reporters), arrayMap(r -> [r.8, 0., 0.], reporters), arrayMap(r -> [r.9, 0., 0.], reporters), arrayMap(r -> [r.10, 0., 0.], reporters), arrayMap(r -> [r.11, 0., 0.], reporters), arrayMap(r -> [0., 0., 1.], reporters))])[1]), arrayMap(k -> (k, 1, (0., 0., 0., 0., 0., 0., 0., 0.)), arrayConcat(tupleElement(reporters, 1), tupleElement(reporters, 12), tupleElement(reporters, 13), tupleElement(reporters, 2))))])[1]])[1] AS netted
        FROM (SELECT
          if(index_traces.rawSessionId = '', concat('trace:', index_traces.traceId), index_traces.rawSessionId) AS sessionId,
          toString(min(index_traces.traceAgentStart)) AS agentStart,
          toString(fromUnixTimestamp64Nano(max(index_traces.traceAgentEndNanos))) AS agentEnd,
          sum(index_traces.toolCalls) AS toolCalls,
          sum(index_traces.errorAgentSpans) AS errorAgentSpans,
          intDiv(max(index_traces.traceAgentEndNanos) - toUnixTimestamp64Nano(min(index_traces.traceAgentStart)), 1000000) AS agentDurationMs,
          argMin(index_traces.vendorId, index_traces.vendorAt) AS vendorId,
          argMin(index_traces.vendorVersion, index_traces.vendorAt) AS vendorVersion,
          count() AS traceCount,
          sum(index_traces.agentSpanCount) AS spanCount,
          groupUniqArrayArray(index_traces.serviceNames) AS serviceNames,
          groupUniqArrayArray(index_traces.models) AS models,
          groupUniqArrayArray(index_traces.agentNames) AS agentNames,
          argMin(index_traces.firstAgentName, index_traces.firstAgentAt) AS firstAgentName,
          sum(arrayCount(f -> f.3 = 1 AND NOT has(tupleElement(failedSpans, 2), f.1), failedSpans)) AS toolErrors,
          sum(arrayCount(f -> f.3 != 1 AND NOT has(tupleElement(failedSpans, 2), f.1), failedSpans)) AS turnErrors,
          groupArrayArray(2000)(usageReporters) AS reporters
        FROM (SELECT
          ai_trace_index.TraceId AS traceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          min(ai_trace_index.Timestamp) AS traceAgentStart,
          max(toUnixTimestamp64Nano(ai_trace_index.Timestamp) + toInt64(ai_trace_index.Duration)) AS traceAgentEndNanos,
          sum(ai_trace_index.IsToolCall) AS toolCalls,
          sum(ai_trace_index.IsError) AS errorAgentSpans,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorId,
          argMin(ai_trace_index.VendorVersion, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorVersion,
          min(tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorAt,
          max(ai_trace_index.Timestamp) AS traceAgentEnd,
          count() AS agentSpanCount,
          groupUniqArrayIf(20)(ai_trace_index.ServiceName, ai_trace_index.ServiceName != '') AS serviceNames,
          groupUniqArrayIf(20)(ai_trace_index.Model, ai_trace_index.Model != '') AS models,
          groupUniqArrayIf(20)(ai_trace_index.AgentName, ai_trace_index.AgentName != '') AS agentNames,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS firstAgentName,
          min(if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS firstAgentAt,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, IsToolCall), IsError = 1) AS failedSpans,
          groupArrayIf(2000)(tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1)), ai_trace_index.Tokens, ai_trace_index.Cost, ai_trace_index.ResponseId, ai_trace_index.IsLlmCall, ai_trace_index.InputTokens, ai_trace_index.CacheReadTokens, ai_trace_index.CacheWriteTokens, ai_trace_index.OutputTokens, ai_trace_index.ReasoningTokens), ((ai_trace_index.Tokens > 0 OR ai_trace_index.Cost > 0) OR ai_trace_index.IsLlmCall = 1)) AS usageSpans,
          groupArrayArray(4000)([tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)) * 2 + 0, if(ai_trace_index.Tokens > 0, if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1))) * 2 + 0), tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)) * 2 + 1, if(ai_trace_index.Cost > 0, if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1))) * 2 + 1)]) AS usageLinks,
          arrayMap(ancestors -> arrayMap((r, t, c) -> tupleConcat(r, (intDiv(t, 2), intDiv(c, 2))), usageSpans, arraySlice(ancestors, 1, length(usageSpans)), arraySlice(ancestors, length(usageSpans) + 1)), [arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayConcat(arrayMap(r -> r.2 * 2, usageSpans), arrayMap(r -> r.2 * 2 + 1, usageSpans))))])[1]))])[1]))])[1]))])[1]])[1] AS usageReporters
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY traceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0
          AND countIf(ai_trace_index.VendorId IN ('eve')) > 0
          AND countIf(ai_trace_index.ServiceName IN ('maple-slack-agent')) > 0) AS index_traces
        GROUP BY sessionId
        ORDER BY agentStart DESC, sessionId ASC
        LIMIT 25
        OFFSET 25) AS ranked_sessions) AS netted_sessions
        ORDER BY agentStart DESC, sessionId ASC
        FORMAT JSON

-- builder:ai-sessions:aiSessionPageQuery:ranked
SELECT
          netted_sessions.sessionId AS sessionId,
          netted_sessions.vendorId AS vendorId,
          netted_sessions.vendorVersion AS vendorVersion,
          netted_sessions.agentStart AS agentStart,
          netted_sessions.agentEnd AS agentEnd,
          netted_sessions.traceCount AS traceCount,
          netted_sessions.spanCount AS spanCount,
          netted_sessions.serviceNames AS serviceNames,
          netted_sessions.models AS models,
          netted_sessions.agentNames AS agentNames,
          netted_sessions.firstAgentName AS firstAgentName,
          netted_sessions.toolCalls AS toolCalls,
          netted_sessions.errorAgentSpans AS errorAgentSpans,
          netted_sessions.toolErrors AS toolErrors,
          netted_sessions.turnErrors AS turnErrors,
          netted_sessions.agentDurationMs AS agentDurationMs,
          toFloat64(arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 2)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, toFloat64(n.2)), arrayFilter(n -> n.1 != '', netted)))))) AS llmCalls,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 3)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.3), arrayFilter(n -> n.1 != '', netted))))) AS totalTokens,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 4)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.4), arrayFilter(n -> n.1 != '', netted))))) AS cost,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 5)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.5), arrayFilter(n -> n.1 != '', netted))))) AS inputTokens,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 6)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.6), arrayFilter(n -> n.1 != '', netted))))) AS cacheReadTokens,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 7)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.7), arrayFilter(n -> n.1 != '', netted))))) AS cacheWriteTokens,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 8)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.8), arrayFilter(n -> n.1 != '', netted))))) AS outputTokens,
          arraySum(tupleElement(arrayFilter(n -> n.1 = '', netted), 9)) + arraySum(mapValues(arrayReduce('maxMap', arrayMap(n -> map(n.1, n.9), arrayFilter(n -> n.1 != '', netted))))) AS reasoningTokens
        FROM (SELECT
          ranked_sessions.sessionId AS sessionId,
          ranked_sessions.vendorId AS vendorId,
          ranked_sessions.vendorVersion AS vendorVersion,
          ranked_sessions.agentStart AS agentStart,
          ranked_sessions.agentEnd AS agentEnd,
          ranked_sessions.traceCount AS traceCount,
          ranked_sessions.spanCount AS spanCount,
          ranked_sessions.serviceNames AS serviceNames,
          ranked_sessions.models AS models,
          ranked_sessions.agentNames AS agentNames,
          ranked_sessions.firstAgentName AS firstAgentName,
          ranked_sessions.toolCalls AS toolCalls,
          ranked_sessions.errorAgentSpans AS errorAgentSpans,
          ranked_sessions.toolErrors AS toolErrors,
          ranked_sessions.turnErrors AS turnErrors,
          ranked_sessions.agentDurationMs AS agentDurationMs,
          arrayMap(charged -> arrayMap((r, own, tokenAncestor, costAncestor, parent) -> tuple(r.5, r.6 = 1 AND if((r.3 > 0 OR r.4 > 0), greatest(0., r.3 - own.1) > 0 OR greatest(0., r.4 - own.2) > 0, tokenAncestor.8 = 0 AND costAncestor.8 = 0 AND parent.8 = 0), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.3 - own.1)), if(r.6 = 0 AND own.2 > 0, 0., greatest(0., r.4 - own.2)), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.7 - own.3)), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.8 - own.4)), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.9 - own.5)), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.10 - own.6)), if(r.6 = 0 AND own.1 > 0, 0., greatest(0., r.11 - own.7))), reporters, arraySlice(charged, 0 * length(reporters) + 1, length(reporters)), arraySlice(charged, 1 * length(reporters) + 1, length(reporters)), arraySlice(charged, 2 * length(reporters) + 1, length(reporters)), arraySlice(charged, 3 * length(reporters) + 1, length(reporters))), [arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), arrayMap(claims -> arrayZip(claims.1, arrayZip(claims.2, claims.3, claims.4, claims.5, claims.6, claims.7, claims.8, claims.9)), [arrayReduce('sumMap', arrayMap(r -> [r.12, r.13, r.1], reporters), arrayMap(r -> [r.3, 0., 0.], reporters), arrayMap(r -> [0., r.4, 0.], reporters), arrayMap(r -> [r.7, 0., 0.], reporters), arrayMap(r -> [r.8, 0., 0.], reporters), arrayMap(r -> [r.9, 0., 0.], reporters), arrayMap(r -> [r.10, 0., 0.], reporters), arrayMap(r -> [r.11, 0., 0.], reporters), arrayMap(r -> [0., 0., 1.], reporters))])[1]), arrayMap(k -> (k, 1, (0., 0., 0., 0., 0., 0., 0., 0.)), arrayConcat(tupleElement(reporters, 1), tupleElement(reporters, 12), tupleElement(reporters, 13), tupleElement(reporters, 2))))])[1]])[1] AS netted
        FROM (SELECT
          if(index_traces.rawSessionId = '', concat('trace:', index_traces.traceId), index_traces.rawSessionId) AS sessionId,
          toString(min(index_traces.traceAgentStart)) AS agentStart,
          toString(fromUnixTimestamp64Nano(max(index_traces.traceAgentEndNanos))) AS agentEnd,
          sum(index_traces.toolCalls) AS toolCalls,
          sum(index_traces.errorAgentSpans) AS errorAgentSpans,
          intDiv(max(index_traces.traceAgentEndNanos) - toUnixTimestamp64Nano(min(index_traces.traceAgentStart)), 1000000) AS agentDurationMs,
          argMin(index_traces.vendorId, index_traces.vendorAt) AS vendorId,
          argMin(index_traces.vendorVersion, index_traces.vendorAt) AS vendorVersion,
          count() AS traceCount,
          sum(index_traces.agentSpanCount) AS spanCount,
          groupUniqArrayArray(index_traces.serviceNames) AS serviceNames,
          groupUniqArrayArray(index_traces.models) AS models,
          groupUniqArrayArray(index_traces.agentNames) AS agentNames,
          argMin(index_traces.firstAgentName, index_traces.firstAgentAt) AS firstAgentName,
          sum(arrayCount(f -> f.3 = 1 AND NOT has(tupleElement(failedSpans, 2), f.1), failedSpans)) AS toolErrors,
          sum(arrayCount(f -> f.3 != 1 AND NOT has(tupleElement(failedSpans, 2), f.1), failedSpans)) AS turnErrors,
          groupArrayArray(2000)(usageReporters) AS reporters
        FROM (SELECT
          ai_trace_index.TraceId AS traceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          min(ai_trace_index.Timestamp) AS traceAgentStart,
          max(toUnixTimestamp64Nano(ai_trace_index.Timestamp) + toInt64(ai_trace_index.Duration)) AS traceAgentEndNanos,
          sum(ai_trace_index.IsToolCall) AS toolCalls,
          sum(ai_trace_index.IsError) AS errorAgentSpans,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorId,
          argMin(ai_trace_index.VendorVersion, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorVersion,
          min(tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS vendorAt,
          max(ai_trace_index.Timestamp) AS traceAgentEnd,
          count() AS agentSpanCount,
          groupUniqArrayIf(20)(ai_trace_index.ServiceName, ai_trace_index.ServiceName != '') AS serviceNames,
          groupUniqArrayIf(20)(ai_trace_index.Model, ai_trace_index.Model != '') AS models,
          groupUniqArrayIf(20)(ai_trace_index.AgentName, ai_trace_index.AgentName != '') AS agentNames,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS firstAgentName,
          min(if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS firstAgentAt,
          groupArrayIf(2000)(tuple(SpanId, ParentSpanId, IsToolCall), IsError = 1) AS failedSpans,
          groupArrayIf(2000)(tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1)), ai_trace_index.Tokens, ai_trace_index.Cost, ai_trace_index.ResponseId, ai_trace_index.IsLlmCall, ai_trace_index.InputTokens, ai_trace_index.CacheReadTokens, ai_trace_index.CacheWriteTokens, ai_trace_index.OutputTokens, ai_trace_index.ReasoningTokens), ((ai_trace_index.Tokens > 0 OR ai_trace_index.Cost > 0) OR ai_trace_index.IsLlmCall = 1)) AS usageSpans,
          groupArrayArray(4000)([tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)) * 2 + 0, if(ai_trace_index.Tokens > 0, if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1))) * 2 + 0), tuple(if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)) * 2 + 1, if(ai_trace_index.Cost > 0, if(ai_trace_index.SpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.SpanId), 1)), if(ai_trace_index.ParentSpanId = '', 0, bitShiftRight(cityHash64(ai_trace_index.ParentSpanId), 1))) * 2 + 1)]) AS usageLinks,
          arrayMap(ancestors -> arrayMap((r, t, c) -> tupleConcat(r, (intDiv(t, 2), intDiv(c, 2))), usageSpans, arraySlice(ancestors, 1, length(usageSpans)), arraySlice(ancestors, length(usageSpans) + 1)), [arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayMap(entries -> arrayMap(sorted -> tupleElement(arraySort(f -> f.3, arrayFilter(f -> f.2 = 1, arrayZip(arrayFill((v, first) -> first = 1, tupleElement(tupleElement(sorted, 1), 3), arrayEnumerateUniq(tupleElement(tupleElement(sorted, 1), 1))), tupleElement(tupleElement(sorted, 1), 2), tupleElement(sorted, 2)))), 1), [arraySort(e -> (e.1.1, e.1.2), arrayZip(entries, arrayEnumerate(entries)))])[1], [arrayConcat(arrayMap(t -> (t.1, 0, t.2), usageLinks), arrayMap(k -> (k, 1, toUInt64(0)), arrayConcat(arrayMap(r -> r.2 * 2, usageSpans), arrayMap(r -> r.2 * 2 + 1, usageSpans))))])[1]))])[1]))])[1]))])[1]])[1] AS usageReporters
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-02 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-02 12:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY traceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0
          AND if(max(ai_trace_index.SessionId) = '', concat('trace:', ai_trace_index.TraceId), max(ai_trace_index.SessionId)) IN ('wrun_sql_catalog', 'trace:7f3a4b5c6d7e8f901234567890abcdef')
          AND countIf(ai_trace_index.VendorId IN ('eve')) > 0) AS index_traces
        GROUP BY sessionId) AS ranked_sessions) AS netted_sessions
        ORDER BY agentDurationMs DESC, agentStart DESC, sessionId ASC
        FORMAT JSON

-- builder:ai-sessions:aiSessionRankQuery:filtered
SELECT
          ranked_sessions.sessionId AS sessionId,
          ranked_sessions.agentStart AS agentStart,
          ranked_sessions.agentEnd AS agentEnd
        FROM (SELECT
          if(index_traces.rawSessionId = '', concat('trace:', index_traces.traceId), index_traces.rawSessionId) AS sessionId,
          toString(min(index_traces.traceAgentStart)) AS agentStart,
          toString(fromUnixTimestamp64Nano(max(index_traces.traceAgentEndNanos))) AS agentEnd,
          sum(index_traces.toolCalls) AS toolCalls,
          sum(index_traces.errorAgentSpans) AS errorAgentSpans,
          intDiv(max(index_traces.traceAgentEndNanos) - toUnixTimestamp64Nano(min(index_traces.traceAgentStart)), 1000000) AS agentDurationMs
        FROM (SELECT
          ai_trace_index.TraceId AS traceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          min(ai_trace_index.Timestamp) AS traceAgentStart,
          max(toUnixTimestamp64Nano(ai_trace_index.Timestamp) + toInt64(ai_trace_index.Duration)) AS traceAgentEndNanos,
          sum(ai_trace_index.IsToolCall) AS toolCalls,
          sum(ai_trace_index.IsError) AS errorAgentSpans
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY traceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0
          AND countIf(ai_trace_index.VendorId IN ('eve')) > 0) AS index_traces
        GROUP BY sessionId
        HAVING errorAgentSpans > 0
        ORDER BY agentDurationMs DESC, agentStart DESC, sessionId ASC
        LIMIT 25
        OFFSET 25) AS ranked_sessions
        FORMAT JSON

-- builder:ai-sessions:aiSessionSpansQuery:ai-scope-after-cursor
SELECT
          trace_detail_spans.TraceId AS traceId,
          trace_detail_spans.SpanId AS spanId,
          trace_detail_spans.ParentSpanId AS parentSpanId,
          trace_detail_spans.SpanName AS spanName,
          trace_detail_spans.SpanKind AS spanKind,
          trace_detail_spans.ServiceName AS serviceName,
          trace_detail_spans.Duration / 1000000 AS durationMs,
          trace_detail_spans.StatusCode AS statusCode,
          trace_detail_spans.StatusMessage AS statusMessage,
          toString(trace_detail_spans.Timestamp) AS timestamp,
          mapFilter((k, v) -> (((k IN ('maple_ai.session.id', 'maple_ai.vendor.id', 'maple_ai.vendor.version', 'maple_ai.agent.name', 'gen_ai.operation.name', 'gen_ai.provider.name', 'gen_ai.system', 'gen_ai.request.model', 'gen_ai.request.max_tokens', 'gen_ai.request.choice.count', 'gen_ai.request.temperature', 'gen_ai.request.top_p', 'gen_ai.request.top_k', 'gen_ai.request.stop_sequences', 'gen_ai.request.frequency_penalty', 'gen_ai.request.presence_penalty', 'gen_ai.request.encoding_formats', 'gen_ai.request.seed', 'gen_ai.openai.request.seed', 'gen_ai.request.stream', 'gen_ai.request.reasoning.level', 'gen_ai.request.previous_response.id', 'gen_ai.request.stream_cursor', 'gen_ai.response.id', 'gen_ai.response.model', 'gen_ai.response.finish_reasons', 'gen_ai.response.finish_reason', 'gen_ai.response.status', 'gen_ai.response.time_to_first_chunk', 'gen_ai.output.type', 'gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens', 'gen_ai.usage.cache_read.input_tokens', 'gen_ai.usage.input_tokens.cached', 'gen_ai.usage.cache_creation.input_tokens', 'gen_ai.usage.cache_write.input_tokens', 'gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens', 'gen_ai.usage.reasoning.output_tokens', 'gen_ai.usage.output_tokens.reasoning', 'gen_ai.usage.cost', 'gen_ai.usage.total_cost', 'maple_ai.llm_call', 'maple_ai.tool_call', 'maple_ai.error', 'maple_ai.usage.input_tokens', 'maple_ai.usage.cache_read_tokens', 'maple_ai.usage.cache_write_tokens', 'maple_ai.usage.output_tokens', 'maple_ai.usage.reasoning_tokens', 'maple_ai.usage.cost', 'gen_ai.conversation.id', 'gen_ai.conversation.compacted', 'gen_ai.agent.id', 'gen_ai.agent.name', 'gen_ai.agent.description', 'gen_ai.agent.version', 'gen_ai.tool.name', 'gen_ai.tool.call.id', 'gen_ai.tool.description', 'gen_ai.tool.type', 'gen_ai.tool.call.arguments', 'gen_ai.tool.call.result', 'gen_ai.tool.definitions', 'gen_ai.system_instructions', 'gen_ai.input.messages', 'gen_ai.prompt', 'gen_ai.output.messages', 'gen_ai.completion', 'gen_ai.data_source.id', 'gen_ai.retrieval.query.text', 'gen_ai.retrieval.top_k', 'gen_ai.retrieval.documents', 'gen_ai.memory.store.id', 'gen_ai.memory.record.id', 'gen_ai.memory.record.count', 'gen_ai.memory.query.text', 'gen_ai.memory.records', 'gen_ai.embeddings.dimension.count', 'gen_ai.evaluation.name', 'gen_ai.evaluation.score.value', 'gen_ai.evaluation.score.label', 'gen_ai.evaluation.explanation', 'gen_ai.prompt.name', 'gen_ai.prompt.version', 'gen_ai.workflow.name', 'span.metadata.attempt_index', 'span.metadata.status_code', 'trace.metadata.openrouter.provider_name', 'error.type', 'server.address', 'server.port', 'ai.model.provider', 'ai.model.id', 'ai.response.id', 'ai.response.model', 'ai.response.finishReason', 'gen_ai.client.operation.time_to_first_chunk', 'ai.usage.inputTokens', 'ai.usage.promptTokens', 'ai.usage.cachedInputTokens', 'ai.usage.inputTokenDetails.cacheReadTokens', 'ai.usage.inputTokenDetails.cacheWriteTokens', 'ai.usage.outputTokens', 'ai.usage.completionTokens', 'ai.usage.reasoningTokens', 'ai.usage.outputTokenDetails.reasoningTokens', 'ai.telemetry.functionId', 'ai.toolCall.name', 'ai.toolCall.id', 'ai.toolCall.args', 'ai.toolCall.result', 'ai.prompt.tools', 'ai.prompt.messages', 'ai.prompt', 'llm.provider', 'llm.system', 'llm.model_name', 'llm.finish_reason', 'llm.token_count.prompt', 'llm.token_count.prompt_details.cache_read', 'llm.token_count.completion', 'llm.token_count.completion_details.reasoning', 'llm.cost.total', 'tool.name', 'tool.description', 'llm.tools', 'openinference.span.kind', 'tool.parameters', 'input.value', 'output.value', 'eve.turn.id', 'maple_ai.turn.id') OR k LIKE 'gen_ai.prompt.variable.%') OR k LIKE 'llm.input_messages.%') OR k LIKE 'llm.output_messages.%'), trace_detail_spans.SpanAttributes) AS spanAttributes
        FROM trace_detail_spans
        WHERE trace_detail_spans.OrgId = 'org_sql_catalog'
          AND trace_detail_spans.Timestamp >= '2026-01-01 10:30:00'
          AND trace_detail_spans.Timestamp <= '2026-01-03 14:15:00'
          AND trace_detail_spans.TraceId IN (SELECT
          traces.TraceId AS TraceId
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND (mapContains(traces.SpanAttributes, 'maple_ai.session.id') AND traces.SpanAttributes['maple_ai.session.id'] != '')
          AND traces.SpanAttributes['maple_ai.session.id'] = 'wrun_sql_catalog')
          AND trace_detail_spans.SpanAttributes['maple_ai.vendor.id'] != ''
          AND (trace_detail_spans.Timestamp > '2026-01-01 10:30:00.123456789' OR (trace_detail_spans.Timestamp = '2026-01-01 10:30:00.123456789' AND trace_detail_spans.SpanId > '00000000000007d0'))
        ORDER BY timestamp ASC, spanId ASC
        LIMIT 2000
        FORMAT JSON

-- builder:ai-sessions:aiSessionSpansQuery:default
SELECT
          trace_detail_spans.TraceId AS traceId,
          trace_detail_spans.SpanId AS spanId,
          trace_detail_spans.ParentSpanId AS parentSpanId,
          trace_detail_spans.SpanName AS spanName,
          trace_detail_spans.SpanKind AS spanKind,
          trace_detail_spans.ServiceName AS serviceName,
          trace_detail_spans.Duration / 1000000 AS durationMs,
          trace_detail_spans.StatusCode AS statusCode,
          trace_detail_spans.StatusMessage AS statusMessage,
          toString(trace_detail_spans.Timestamp) AS timestamp,
          mapFilter((k, v) -> (((k IN ('maple_ai.session.id', 'maple_ai.vendor.id', 'maple_ai.vendor.version', 'maple_ai.agent.name', 'gen_ai.operation.name', 'gen_ai.provider.name', 'gen_ai.system', 'gen_ai.request.model', 'gen_ai.request.max_tokens', 'gen_ai.request.choice.count', 'gen_ai.request.temperature', 'gen_ai.request.top_p', 'gen_ai.request.top_k', 'gen_ai.request.stop_sequences', 'gen_ai.request.frequency_penalty', 'gen_ai.request.presence_penalty', 'gen_ai.request.encoding_formats', 'gen_ai.request.seed', 'gen_ai.openai.request.seed', 'gen_ai.request.stream', 'gen_ai.request.reasoning.level', 'gen_ai.request.previous_response.id', 'gen_ai.request.stream_cursor', 'gen_ai.response.id', 'gen_ai.response.model', 'gen_ai.response.finish_reasons', 'gen_ai.response.finish_reason', 'gen_ai.response.status', 'gen_ai.response.time_to_first_chunk', 'gen_ai.output.type', 'gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens', 'gen_ai.usage.cache_read.input_tokens', 'gen_ai.usage.input_tokens.cached', 'gen_ai.usage.cache_creation.input_tokens', 'gen_ai.usage.cache_write.input_tokens', 'gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens', 'gen_ai.usage.reasoning.output_tokens', 'gen_ai.usage.output_tokens.reasoning', 'gen_ai.usage.cost', 'gen_ai.usage.total_cost', 'maple_ai.llm_call', 'maple_ai.tool_call', 'maple_ai.error', 'maple_ai.usage.input_tokens', 'maple_ai.usage.cache_read_tokens', 'maple_ai.usage.cache_write_tokens', 'maple_ai.usage.output_tokens', 'maple_ai.usage.reasoning_tokens', 'maple_ai.usage.cost', 'gen_ai.conversation.id', 'gen_ai.conversation.compacted', 'gen_ai.agent.id', 'gen_ai.agent.name', 'gen_ai.agent.description', 'gen_ai.agent.version', 'gen_ai.tool.name', 'gen_ai.tool.call.id', 'gen_ai.tool.description', 'gen_ai.tool.type', 'gen_ai.tool.call.arguments', 'gen_ai.tool.call.result', 'gen_ai.tool.definitions', 'gen_ai.system_instructions', 'gen_ai.input.messages', 'gen_ai.prompt', 'gen_ai.output.messages', 'gen_ai.completion', 'gen_ai.data_source.id', 'gen_ai.retrieval.query.text', 'gen_ai.retrieval.top_k', 'gen_ai.retrieval.documents', 'gen_ai.memory.store.id', 'gen_ai.memory.record.id', 'gen_ai.memory.record.count', 'gen_ai.memory.query.text', 'gen_ai.memory.records', 'gen_ai.embeddings.dimension.count', 'gen_ai.evaluation.name', 'gen_ai.evaluation.score.value', 'gen_ai.evaluation.score.label', 'gen_ai.evaluation.explanation', 'gen_ai.prompt.name', 'gen_ai.prompt.version', 'gen_ai.workflow.name', 'span.metadata.attempt_index', 'span.metadata.status_code', 'trace.metadata.openrouter.provider_name', 'error.type', 'server.address', 'server.port', 'ai.model.provider', 'ai.model.id', 'ai.response.id', 'ai.response.model', 'ai.response.finishReason', 'gen_ai.client.operation.time_to_first_chunk', 'ai.usage.inputTokens', 'ai.usage.promptTokens', 'ai.usage.cachedInputTokens', 'ai.usage.inputTokenDetails.cacheReadTokens', 'ai.usage.inputTokenDetails.cacheWriteTokens', 'ai.usage.outputTokens', 'ai.usage.completionTokens', 'ai.usage.reasoningTokens', 'ai.usage.outputTokenDetails.reasoningTokens', 'ai.telemetry.functionId', 'ai.toolCall.name', 'ai.toolCall.id', 'ai.toolCall.args', 'ai.toolCall.result', 'ai.prompt.tools', 'ai.prompt.messages', 'ai.prompt', 'llm.provider', 'llm.system', 'llm.model_name', 'llm.finish_reason', 'llm.token_count.prompt', 'llm.token_count.prompt_details.cache_read', 'llm.token_count.completion', 'llm.token_count.completion_details.reasoning', 'llm.cost.total', 'tool.name', 'tool.description', 'llm.tools', 'openinference.span.kind', 'tool.parameters', 'input.value', 'output.value', 'eve.turn.id', 'maple_ai.turn.id') OR k LIKE 'gen_ai.prompt.variable.%') OR k LIKE 'llm.input_messages.%') OR k LIKE 'llm.output_messages.%'), trace_detail_spans.SpanAttributes) AS spanAttributes
        FROM trace_detail_spans
        WHERE trace_detail_spans.OrgId = 'org_sql_catalog'
          AND trace_detail_spans.Timestamp >= '2026-01-01 10:30:00'
          AND trace_detail_spans.Timestamp <= '2026-01-03 14:15:00'
          AND trace_detail_spans.TraceId IN (SELECT
          traces.TraceId AS TraceId
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND (mapContains(traces.SpanAttributes, 'maple_ai.session.id') AND traces.SpanAttributes['maple_ai.session.id'] != '')
          AND traces.SpanAttributes['maple_ai.session.id'] = 'wrun_sql_catalog')
        ORDER BY timestamp ASC, spanId ASC
        LIMIT 2000
        FORMAT JSON

-- builder:ai-sessions:aiSessionSummaryQuery:default
SELECT
          if(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.turn.id'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.conversation.id'], ''), nullIf(trace_detail_spans.SpanAttributes['eve.turn.id'], ''), '') != '', coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.turn.id'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.conversation.id'], ''), nullIf(trace_detail_spans.SpanAttributes['eve.turn.id'], ''), ''), trace_detail_spans.TraceId) AS turnKey,
          max(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.turn.id'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.conversation.id'], ''), nullIf(trace_detail_spans.SpanAttributes['eve.turn.id'], ''), '')) AS conversationId,
          groupUniqArray(trace_detail_spans.TraceId) AS traceIds,
          toString(min(trace_detail_spans.Timestamp)) AS startTime,
          fromUnixTimestamp64Nano(max(toUnixTimestamp64Nano(trace_detail_spans.Timestamp) + toInt64(trace_detail_spans.Duration))) AS endTime,
          intDiv(max(toUnixTimestamp64Nano(trace_detail_spans.Timestamp) + toInt64(trace_detail_spans.Duration)) - toUnixTimestamp64Nano(min(trace_detail_spans.Timestamp)), 1000000) AS durationMs,
          count() AS spanCount,
          countIf(trace_detail_spans.SpanAttributes['maple_ai.vendor.id'] != '') AS aiSpanCount,
          countIf((trace_detail_spans.SpanAttributes['maple_ai.llm_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('chat', 'generate_content', 'text_completion', 'fetch_response') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') NOT IN ('embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step', 'search_memory', 'create_memory', 'update_memory', 'upsert_memory', 'delete_memory', 'create_memory_store', 'delete_memory_store') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '') != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') = ''))))) AS llmCalls,
          countIf((trace_detail_spans.SpanAttributes['maple_ai.tool_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('execute_tool') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') = '' AND trace_detail_spans.SpanAttributes['maple_ai.vendor.id'] != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') != ''))))) AS toolCalls,
          countIf((trace_detail_spans.SpanAttributes['maple_ai.error'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (trace_detail_spans.StatusCode = 'Error' OR (trace_detail_spans.SpanAttributes['maple_ai.vendor.id'] != '' AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['error.type'], ''), '') != '' OR trace_detail_spans.SpanAttributes['gen_ai.response.status'] IN ('failed', 'error'))))))) AS errorSpanCount,
          ifNotFinite(sum(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.input_tokens'], ''), '')) + toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cache_write_tokens'], ''), '')), toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.input_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.prompt_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.inputTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.promptTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.token_count.prompt'], ''), '')))), 0) AS inputTokens,
          ifNotFinite(sum(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.output_tokens'], ''), '')) + toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.reasoning_tokens'], ''), '')), toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.output_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.completion_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.outputTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.completionTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.token_count.completion'], ''), '')))), 0) AS outputTokens,
          ifNotFinite(sum(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cache_read_tokens'], ''), '')), toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.cache_read.input_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.input_tokens.cached'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.cachedInputTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.inputTokenDetails.cacheReadTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.token_count.prompt_details.cache_read'], ''), '')))), 0) AS cacheReadTokens,
          ifNotFinite(sumIf(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.input_tokens'], ''), '')) + toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cache_write_tokens'], ''), '')), toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.input_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.prompt_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.inputTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.promptTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.token_count.prompt'], ''), ''))), (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('chat', 'generate_content', 'text_completion', 'fetch_response') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') NOT IN ('embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step', 'search_memory', 'create_memory', 'update_memory', 'upsert_memory', 'delete_memory', 'create_memory_store', 'delete_memory_store') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '') != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') = ''))))), 0) AS llmInputTokens,
          ifNotFinite(sumIf(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.output_tokens'], ''), '')) + toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.reasoning_tokens'], ''), '')), toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.output_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.completion_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.outputTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.completionTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.token_count.completion'], ''), ''))), (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('chat', 'generate_content', 'text_completion', 'fetch_response') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') NOT IN ('embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step', 'search_memory', 'create_memory', 'update_memory', 'upsert_memory', 'delete_memory', 'create_memory_store', 'delete_memory_store') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '') != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') = ''))))), 0) AS llmOutputTokens,
          ifNotFinite(sumIf(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cache_read_tokens'], ''), '')), toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.cache_read.input_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.input_tokens.cached'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.cachedInputTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.inputTokenDetails.cacheReadTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.token_count.prompt_details.cache_read'], ''), ''))), (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('chat', 'generate_content', 'text_completion', 'fetch_response') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') NOT IN ('embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step', 'search_memory', 'create_memory', 'update_memory', 'upsert_memory', 'delete_memory', 'create_memory_store', 'delete_memory_store') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '') != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') = ''))))), 0) AS llmCacheReadTokens,
          countIf(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cost'], ''), ''), coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.cost'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.total_cost'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.cost.total'], ''), '')) != '') AS costReporters,
          ifNotFinite(sum(toFloat64OrZero(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cost'], ''), ''), coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.cost'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.total_cost'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.cost.total'], ''), '')))), 0) AS cost,
          ifNotFinite(sumIf(toFloat64OrZero(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cost'], ''), ''), coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.cost'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.total_cost'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.cost.total'], ''), ''))), (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('chat', 'generate_content', 'text_completion', 'fetch_response') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') NOT IN ('embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step', 'search_memory', 'create_memory', 'update_memory', 'upsert_memory', 'delete_memory', 'create_memory_store', 'delete_memory_store') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '') != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') = ''))))), 0) AS llmCost,
          groupUniqArrayIf(50)(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', trace_detail_spans.SpanAttributes['maple_ai.model'], coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '')), ((trace_detail_spans.SpanAttributes['maple_ai.llm_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('chat', 'generate_content', 'text_completion', 'fetch_response') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') NOT IN ('embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step', 'search_memory', 'create_memory', 'update_memory', 'upsert_memory', 'delete_memory', 'create_memory_store', 'delete_memory_store') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '') != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') = '')))) AND if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', trace_detail_spans.SpanAttributes['maple_ai.model'], coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '')) != '')) AS models,
          groupUniqArrayIf(50)(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', trace_detail_spans.SpanAttributes['maple_ai.agent.name'], coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.agent.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.telemetry.functionId'], ''), '')), if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', trace_detail_spans.SpanAttributes['maple_ai.agent.name'], coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.agent.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.telemetry.functionId'], ''), '')) != '') AS agentNames
        FROM trace_detail_spans
        WHERE trace_detail_spans.OrgId = 'org_sql_catalog'
          AND trace_detail_spans.Timestamp >= '2026-01-01 10:30:00'
          AND trace_detail_spans.Timestamp <= '2026-01-03 14:15:00'
          AND trace_detail_spans.TraceId IN (SELECT
          traces.TraceId AS TraceId
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND (mapContains(traces.SpanAttributes, 'maple_ai.session.id') AND traces.SpanAttributes['maple_ai.session.id'] != '')
          AND traces.SpanAttributes['maple_ai.session.id'] = 'wrun_sql_catalog')
        GROUP BY turnKey
        ORDER BY startTime ASC
        LIMIT 1001
        FORMAT JSON

-- builder:ai-sessions:aiSessionTotalsQuery:default
SELECT
          uniqExact(trace_detail_spans.TraceId) AS traceCount,
          toString(min(trace_detail_spans.Timestamp)) AS startTime,
          fromUnixTimestamp64Nano(max(toUnixTimestamp64Nano(trace_detail_spans.Timestamp) + toInt64(trace_detail_spans.Duration))) AS endTime,
          intDiv(max(toUnixTimestamp64Nano(trace_detail_spans.Timestamp) + toInt64(trace_detail_spans.Duration)) - toUnixTimestamp64Nano(min(trace_detail_spans.Timestamp)), 1000000) AS durationMs,
          count() AS spanCount,
          countIf(trace_detail_spans.SpanAttributes['maple_ai.vendor.id'] != '') AS aiSpanCount,
          countIf((trace_detail_spans.SpanAttributes['maple_ai.llm_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('chat', 'generate_content', 'text_completion', 'fetch_response') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') NOT IN ('embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step', 'search_memory', 'create_memory', 'update_memory', 'upsert_memory', 'delete_memory', 'create_memory_store', 'delete_memory_store') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '') != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') = ''))))) AS llmCalls,
          countIf((trace_detail_spans.SpanAttributes['maple_ai.tool_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('execute_tool') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') = '' AND trace_detail_spans.SpanAttributes['maple_ai.vendor.id'] != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') != ''))))) AS toolCalls,
          countIf((trace_detail_spans.SpanAttributes['maple_ai.error'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (trace_detail_spans.StatusCode = 'Error' OR (trace_detail_spans.SpanAttributes['maple_ai.vendor.id'] != '' AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['error.type'], ''), '') != '' OR trace_detail_spans.SpanAttributes['gen_ai.response.status'] IN ('failed', 'error'))))))) AS errorSpanCount,
          ifNotFinite(sum(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.input_tokens'], ''), '')) + toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cache_write_tokens'], ''), '')), toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.input_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.prompt_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.inputTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.promptTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.token_count.prompt'], ''), '')))), 0) AS inputTokens,
          ifNotFinite(sum(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.output_tokens'], ''), '')) + toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.reasoning_tokens'], ''), '')), toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.output_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.completion_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.outputTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.completionTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.token_count.completion'], ''), '')))), 0) AS outputTokens,
          ifNotFinite(sum(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cache_read_tokens'], ''), '')), toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.cache_read.input_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.input_tokens.cached'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.cachedInputTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.inputTokenDetails.cacheReadTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.token_count.prompt_details.cache_read'], ''), '')))), 0) AS cacheReadTokens,
          ifNotFinite(sumIf(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.input_tokens'], ''), '')) + toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cache_write_tokens'], ''), '')), toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.input_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.prompt_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.inputTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.promptTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.token_count.prompt'], ''), ''))), (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('chat', 'generate_content', 'text_completion', 'fetch_response') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') NOT IN ('embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step', 'search_memory', 'create_memory', 'update_memory', 'upsert_memory', 'delete_memory', 'create_memory_store', 'delete_memory_store') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '') != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') = ''))))), 0) AS llmInputTokens,
          ifNotFinite(sumIf(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.output_tokens'], ''), '')) + toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.reasoning_tokens'], ''), '')), toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.output_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.completion_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.outputTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.completionTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.token_count.completion'], ''), ''))), (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('chat', 'generate_content', 'text_completion', 'fetch_response') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') NOT IN ('embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step', 'search_memory', 'create_memory', 'update_memory', 'upsert_memory', 'delete_memory', 'create_memory_store', 'delete_memory_store') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '') != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') = ''))))), 0) AS llmOutputTokens,
          ifNotFinite(sumIf(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cache_read_tokens'], ''), '')), toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.cache_read.input_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.input_tokens.cached'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.cachedInputTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.inputTokenDetails.cacheReadTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.token_count.prompt_details.cache_read'], ''), ''))), (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('chat', 'generate_content', 'text_completion', 'fetch_response') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') NOT IN ('embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step', 'search_memory', 'create_memory', 'update_memory', 'upsert_memory', 'delete_memory', 'create_memory_store', 'delete_memory_store') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '') != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') = ''))))), 0) AS llmCacheReadTokens,
          countIf(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cost'], ''), ''), coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.cost'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.total_cost'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.cost.total'], ''), '')) != '') AS costReporters,
          ifNotFinite(sum(toFloat64OrZero(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cost'], ''), ''), coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.cost'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.total_cost'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.cost.total'], ''), '')))), 0) AS cost,
          ifNotFinite(sumIf(toFloat64OrZero(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cost'], ''), ''), coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.cost'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.total_cost'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.cost.total'], ''), ''))), (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('chat', 'generate_content', 'text_completion', 'fetch_response') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') NOT IN ('embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step', 'search_memory', 'create_memory', 'update_memory', 'upsert_memory', 'delete_memory', 'create_memory_store', 'delete_memory_store') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '') != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') = ''))))), 0) AS llmCost,
          groupUniqArrayIf(50)(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', trace_detail_spans.SpanAttributes['maple_ai.model'], coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '')), ((trace_detail_spans.SpanAttributes['maple_ai.llm_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('chat', 'generate_content', 'text_completion', 'fetch_response') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') NOT IN ('embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step', 'search_memory', 'create_memory', 'update_memory', 'upsert_memory', 'delete_memory', 'create_memory_store', 'delete_memory_store') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '') != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') = '')))) AND if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', trace_detail_spans.SpanAttributes['maple_ai.model'], coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '')) != '')) AS models,
          groupUniqArrayIf(50)(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', trace_detail_spans.SpanAttributes['maple_ai.agent.name'], coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.agent.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.telemetry.functionId'], ''), '')), if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', trace_detail_spans.SpanAttributes['maple_ai.agent.name'], coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.agent.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.telemetry.functionId'], ''), '')) != '') AS agentNames
        FROM trace_detail_spans
        WHERE trace_detail_spans.OrgId = 'org_sql_catalog'
          AND trace_detail_spans.Timestamp >= '2026-01-01 10:30:00'
          AND trace_detail_spans.Timestamp <= '2026-01-03 14:15:00'
          AND trace_detail_spans.TraceId IN (SELECT
          traces.TraceId AS TraceId
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND (mapContains(traces.SpanAttributes, 'maple_ai.session.id') AND traces.SpanAttributes['maple_ai.session.id'] != '')
          AND traces.SpanAttributes['maple_ai.session.id'] = 'wrun_sql_catalog')
        FORMAT JSON

-- builder:ai-sessions:aiSessionWindowQuery:default
SELECT
          toString(min(traces.Timestamp) - INTERVAL 86400 SECOND) AS startTime,
          toString(max(traces.Timestamp) + INTERVAL 86400 SECOND) AS endTime,
          count() AS spanCount
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND (mapContains(traces.SpanAttributes, 'maple_ai.session.id') AND traces.SpanAttributes['maple_ai.session.id'] != '')
          AND traces.SpanAttributes['maple_ai.session.id'] = 'wrun_sql_catalog'
        FORMAT JSON

-- builder:ai-sessions:aiTraceSpansQuery:default
SELECT
          trace_detail_spans.TraceId AS traceId,
          trace_detail_spans.SpanId AS spanId,
          trace_detail_spans.ParentSpanId AS parentSpanId,
          trace_detail_spans.SpanName AS spanName,
          trace_detail_spans.SpanKind AS spanKind,
          trace_detail_spans.ServiceName AS serviceName,
          trace_detail_spans.Duration / 1000000 AS durationMs,
          trace_detail_spans.StatusCode AS statusCode,
          trace_detail_spans.StatusMessage AS statusMessage,
          toString(trace_detail_spans.Timestamp) AS timestamp,
          mapFilter((k, v) -> (((k IN ('maple_ai.session.id', 'maple_ai.vendor.id', 'maple_ai.vendor.version', 'maple_ai.agent.name', 'gen_ai.operation.name', 'gen_ai.provider.name', 'gen_ai.system', 'gen_ai.request.model', 'gen_ai.request.max_tokens', 'gen_ai.request.choice.count', 'gen_ai.request.temperature', 'gen_ai.request.top_p', 'gen_ai.request.top_k', 'gen_ai.request.stop_sequences', 'gen_ai.request.frequency_penalty', 'gen_ai.request.presence_penalty', 'gen_ai.request.encoding_formats', 'gen_ai.request.seed', 'gen_ai.openai.request.seed', 'gen_ai.request.stream', 'gen_ai.request.reasoning.level', 'gen_ai.request.previous_response.id', 'gen_ai.request.stream_cursor', 'gen_ai.response.id', 'gen_ai.response.model', 'gen_ai.response.finish_reasons', 'gen_ai.response.finish_reason', 'gen_ai.response.status', 'gen_ai.response.time_to_first_chunk', 'gen_ai.output.type', 'gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens', 'gen_ai.usage.cache_read.input_tokens', 'gen_ai.usage.input_tokens.cached', 'gen_ai.usage.cache_creation.input_tokens', 'gen_ai.usage.cache_write.input_tokens', 'gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens', 'gen_ai.usage.reasoning.output_tokens', 'gen_ai.usage.output_tokens.reasoning', 'gen_ai.usage.cost', 'gen_ai.usage.total_cost', 'maple_ai.llm_call', 'maple_ai.tool_call', 'maple_ai.error', 'maple_ai.usage.input_tokens', 'maple_ai.usage.cache_read_tokens', 'maple_ai.usage.cache_write_tokens', 'maple_ai.usage.output_tokens', 'maple_ai.usage.reasoning_tokens', 'maple_ai.usage.cost', 'gen_ai.conversation.id', 'gen_ai.conversation.compacted', 'gen_ai.agent.id', 'gen_ai.agent.name', 'gen_ai.agent.description', 'gen_ai.agent.version', 'gen_ai.tool.name', 'gen_ai.tool.call.id', 'gen_ai.tool.description', 'gen_ai.tool.type', 'gen_ai.tool.call.arguments', 'gen_ai.tool.call.result', 'gen_ai.tool.definitions', 'gen_ai.system_instructions', 'gen_ai.input.messages', 'gen_ai.prompt', 'gen_ai.output.messages', 'gen_ai.completion', 'gen_ai.data_source.id', 'gen_ai.retrieval.query.text', 'gen_ai.retrieval.top_k', 'gen_ai.retrieval.documents', 'gen_ai.memory.store.id', 'gen_ai.memory.record.id', 'gen_ai.memory.record.count', 'gen_ai.memory.query.text', 'gen_ai.memory.records', 'gen_ai.embeddings.dimension.count', 'gen_ai.evaluation.name', 'gen_ai.evaluation.score.value', 'gen_ai.evaluation.score.label', 'gen_ai.evaluation.explanation', 'gen_ai.prompt.name', 'gen_ai.prompt.version', 'gen_ai.workflow.name', 'span.metadata.attempt_index', 'span.metadata.status_code', 'trace.metadata.openrouter.provider_name', 'error.type', 'server.address', 'server.port', 'ai.model.provider', 'ai.model.id', 'ai.response.id', 'ai.response.model', 'ai.response.finishReason', 'gen_ai.client.operation.time_to_first_chunk', 'ai.usage.inputTokens', 'ai.usage.promptTokens', 'ai.usage.cachedInputTokens', 'ai.usage.inputTokenDetails.cacheReadTokens', 'ai.usage.inputTokenDetails.cacheWriteTokens', 'ai.usage.outputTokens', 'ai.usage.completionTokens', 'ai.usage.reasoningTokens', 'ai.usage.outputTokenDetails.reasoningTokens', 'ai.telemetry.functionId', 'ai.toolCall.name', 'ai.toolCall.id', 'ai.toolCall.args', 'ai.toolCall.result', 'ai.prompt.tools', 'ai.prompt.messages', 'ai.prompt', 'llm.provider', 'llm.system', 'llm.model_name', 'llm.finish_reason', 'llm.token_count.prompt', 'llm.token_count.prompt_details.cache_read', 'llm.token_count.completion', 'llm.token_count.completion_details.reasoning', 'llm.cost.total', 'tool.name', 'tool.description', 'llm.tools', 'openinference.span.kind', 'tool.parameters', 'input.value', 'output.value', 'eve.turn.id', 'maple_ai.turn.id') OR k LIKE 'gen_ai.prompt.variable.%') OR k LIKE 'llm.input_messages.%') OR k LIKE 'llm.output_messages.%'), trace_detail_spans.SpanAttributes) AS spanAttributes
        FROM trace_detail_spans
        WHERE trace_detail_spans.OrgId = 'org_sql_catalog'
          AND trace_detail_spans.Timestamp >= '2026-01-01 10:30:00'
          AND trace_detail_spans.Timestamp <= '2026-01-03 14:15:00'
          AND trace_detail_spans.TraceId = '7f3a4b5c6d7e8f901234567890abcdef'
        ORDER BY timestamp ASC, spanId ASC
        LIMIT 2000
        FORMAT JSON

-- builder:ai-sessions:aiTraceSpansQuery:traces-app-scope
SELECT
          trace_detail_spans.TraceId AS traceId,
          trace_detail_spans.SpanId AS spanId,
          trace_detail_spans.ParentSpanId AS parentSpanId,
          trace_detail_spans.SpanName AS spanName,
          trace_detail_spans.SpanKind AS spanKind,
          trace_detail_spans.ServiceName AS serviceName,
          trace_detail_spans.Duration / 1000000 AS durationMs,
          trace_detail_spans.StatusCode AS statusCode,
          trace_detail_spans.StatusMessage AS statusMessage,
          toString(trace_detail_spans.Timestamp) AS timestamp,
          mapFilter((k, v) -> (((k IN ('maple_ai.session.id', 'maple_ai.vendor.id', 'maple_ai.vendor.version', 'maple_ai.agent.name', 'gen_ai.operation.name', 'gen_ai.provider.name', 'gen_ai.system', 'gen_ai.request.model', 'gen_ai.request.max_tokens', 'gen_ai.request.choice.count', 'gen_ai.request.temperature', 'gen_ai.request.top_p', 'gen_ai.request.top_k', 'gen_ai.request.stop_sequences', 'gen_ai.request.frequency_penalty', 'gen_ai.request.presence_penalty', 'gen_ai.request.encoding_formats', 'gen_ai.request.seed', 'gen_ai.openai.request.seed', 'gen_ai.request.stream', 'gen_ai.request.reasoning.level', 'gen_ai.request.previous_response.id', 'gen_ai.request.stream_cursor', 'gen_ai.response.id', 'gen_ai.response.model', 'gen_ai.response.finish_reasons', 'gen_ai.response.finish_reason', 'gen_ai.response.status', 'gen_ai.response.time_to_first_chunk', 'gen_ai.output.type', 'gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens', 'gen_ai.usage.cache_read.input_tokens', 'gen_ai.usage.input_tokens.cached', 'gen_ai.usage.cache_creation.input_tokens', 'gen_ai.usage.cache_write.input_tokens', 'gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens', 'gen_ai.usage.reasoning.output_tokens', 'gen_ai.usage.output_tokens.reasoning', 'gen_ai.usage.cost', 'gen_ai.usage.total_cost', 'maple_ai.llm_call', 'maple_ai.tool_call', 'maple_ai.error', 'maple_ai.usage.input_tokens', 'maple_ai.usage.cache_read_tokens', 'maple_ai.usage.cache_write_tokens', 'maple_ai.usage.output_tokens', 'maple_ai.usage.reasoning_tokens', 'maple_ai.usage.cost', 'gen_ai.conversation.id', 'gen_ai.conversation.compacted', 'gen_ai.agent.id', 'gen_ai.agent.name', 'gen_ai.agent.description', 'gen_ai.agent.version', 'gen_ai.tool.name', 'gen_ai.tool.call.id', 'gen_ai.tool.description', 'gen_ai.tool.type', 'gen_ai.tool.call.arguments', 'gen_ai.tool.call.result', 'gen_ai.tool.definitions', 'gen_ai.system_instructions', 'gen_ai.input.messages', 'gen_ai.prompt', 'gen_ai.output.messages', 'gen_ai.completion', 'gen_ai.data_source.id', 'gen_ai.retrieval.query.text', 'gen_ai.retrieval.top_k', 'gen_ai.retrieval.documents', 'gen_ai.memory.store.id', 'gen_ai.memory.record.id', 'gen_ai.memory.record.count', 'gen_ai.memory.query.text', 'gen_ai.memory.records', 'gen_ai.embeddings.dimension.count', 'gen_ai.evaluation.name', 'gen_ai.evaluation.score.value', 'gen_ai.evaluation.score.label', 'gen_ai.evaluation.explanation', 'gen_ai.prompt.name', 'gen_ai.prompt.version', 'gen_ai.workflow.name', 'span.metadata.attempt_index', 'span.metadata.status_code', 'trace.metadata.openrouter.provider_name', 'error.type', 'server.address', 'server.port', 'ai.model.provider', 'ai.model.id', 'ai.response.id', 'ai.response.model', 'ai.response.finishReason', 'gen_ai.client.operation.time_to_first_chunk', 'ai.usage.inputTokens', 'ai.usage.promptTokens', 'ai.usage.cachedInputTokens', 'ai.usage.inputTokenDetails.cacheReadTokens', 'ai.usage.inputTokenDetails.cacheWriteTokens', 'ai.usage.outputTokens', 'ai.usage.completionTokens', 'ai.usage.reasoningTokens', 'ai.usage.outputTokenDetails.reasoningTokens', 'ai.telemetry.functionId', 'ai.toolCall.name', 'ai.toolCall.id', 'ai.toolCall.args', 'ai.toolCall.result', 'ai.prompt.tools', 'ai.prompt.messages', 'ai.prompt', 'llm.provider', 'llm.system', 'llm.model_name', 'llm.finish_reason', 'llm.token_count.prompt', 'llm.token_count.prompt_details.cache_read', 'llm.token_count.completion', 'llm.token_count.completion_details.reasoning', 'llm.cost.total', 'tool.name', 'tool.description', 'llm.tools', 'openinference.span.kind', 'tool.parameters', 'input.value', 'output.value', 'eve.turn.id', 'maple_ai.turn.id') OR k LIKE 'gen_ai.prompt.variable.%') OR k LIKE 'llm.input_messages.%') OR k LIKE 'llm.output_messages.%'), trace_detail_spans.SpanAttributes) AS spanAttributes
        FROM trace_detail_spans
        WHERE trace_detail_spans.OrgId = 'org_sql_catalog'
          AND trace_detail_spans.Timestamp >= '2026-01-01 10:30:00'
          AND trace_detail_spans.Timestamp <= '2026-01-03 14:15:00'
          AND trace_detail_spans.TraceId IN ('7f3a4b5c6d7e8f901234567890abcdef', '0123456789abcdef0123456789abcdef')
          AND trace_detail_spans.SpanAttributes['maple_ai.vendor.id'] = ''
        ORDER BY timestamp ASC, spanId ASC
        LIMIT 2000
        FORMAT JSON

-- builder:ai-sessions:aiTraceSummaryQuery:default
SELECT
          if(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.turn.id'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.conversation.id'], ''), nullIf(trace_detail_spans.SpanAttributes['eve.turn.id'], ''), '') != '', coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.turn.id'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.conversation.id'], ''), nullIf(trace_detail_spans.SpanAttributes['eve.turn.id'], ''), ''), trace_detail_spans.TraceId) AS turnKey,
          max(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.turn.id'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.conversation.id'], ''), nullIf(trace_detail_spans.SpanAttributes['eve.turn.id'], ''), '')) AS conversationId,
          groupUniqArray(trace_detail_spans.TraceId) AS traceIds,
          toString(min(trace_detail_spans.Timestamp)) AS startTime,
          fromUnixTimestamp64Nano(max(toUnixTimestamp64Nano(trace_detail_spans.Timestamp) + toInt64(trace_detail_spans.Duration))) AS endTime,
          intDiv(max(toUnixTimestamp64Nano(trace_detail_spans.Timestamp) + toInt64(trace_detail_spans.Duration)) - toUnixTimestamp64Nano(min(trace_detail_spans.Timestamp)), 1000000) AS durationMs,
          count() AS spanCount,
          countIf(trace_detail_spans.SpanAttributes['maple_ai.vendor.id'] != '') AS aiSpanCount,
          countIf((trace_detail_spans.SpanAttributes['maple_ai.llm_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('chat', 'generate_content', 'text_completion', 'fetch_response') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') NOT IN ('embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step', 'search_memory', 'create_memory', 'update_memory', 'upsert_memory', 'delete_memory', 'create_memory_store', 'delete_memory_store') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '') != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') = ''))))) AS llmCalls,
          countIf((trace_detail_spans.SpanAttributes['maple_ai.tool_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('execute_tool') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') = '' AND trace_detail_spans.SpanAttributes['maple_ai.vendor.id'] != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') != ''))))) AS toolCalls,
          countIf((trace_detail_spans.SpanAttributes['maple_ai.error'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (trace_detail_spans.StatusCode = 'Error' OR (trace_detail_spans.SpanAttributes['maple_ai.vendor.id'] != '' AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['error.type'], ''), '') != '' OR trace_detail_spans.SpanAttributes['gen_ai.response.status'] IN ('failed', 'error'))))))) AS errorSpanCount,
          ifNotFinite(sum(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.input_tokens'], ''), '')) + toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cache_write_tokens'], ''), '')), toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.input_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.prompt_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.inputTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.promptTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.token_count.prompt'], ''), '')))), 0) AS inputTokens,
          ifNotFinite(sum(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.output_tokens'], ''), '')) + toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.reasoning_tokens'], ''), '')), toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.output_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.completion_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.outputTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.completionTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.token_count.completion'], ''), '')))), 0) AS outputTokens,
          ifNotFinite(sum(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cache_read_tokens'], ''), '')), toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.cache_read.input_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.input_tokens.cached'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.cachedInputTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.inputTokenDetails.cacheReadTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.token_count.prompt_details.cache_read'], ''), '')))), 0) AS cacheReadTokens,
          ifNotFinite(sumIf(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.input_tokens'], ''), '')) + toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cache_write_tokens'], ''), '')), toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.input_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.prompt_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.inputTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.promptTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.token_count.prompt'], ''), ''))), (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('chat', 'generate_content', 'text_completion', 'fetch_response') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') NOT IN ('embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step', 'search_memory', 'create_memory', 'update_memory', 'upsert_memory', 'delete_memory', 'create_memory_store', 'delete_memory_store') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '') != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') = ''))))), 0) AS llmInputTokens,
          ifNotFinite(sumIf(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.output_tokens'], ''), '')) + toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.reasoning_tokens'], ''), '')), toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.output_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.completion_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.outputTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.completionTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.token_count.completion'], ''), ''))), (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('chat', 'generate_content', 'text_completion', 'fetch_response') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') NOT IN ('embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step', 'search_memory', 'create_memory', 'update_memory', 'upsert_memory', 'delete_memory', 'create_memory_store', 'delete_memory_store') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '') != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') = ''))))), 0) AS llmOutputTokens,
          ifNotFinite(sumIf(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cache_read_tokens'], ''), '')), toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.cache_read.input_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.input_tokens.cached'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.cachedInputTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.inputTokenDetails.cacheReadTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.token_count.prompt_details.cache_read'], ''), ''))), (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('chat', 'generate_content', 'text_completion', 'fetch_response') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') NOT IN ('embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step', 'search_memory', 'create_memory', 'update_memory', 'upsert_memory', 'delete_memory', 'create_memory_store', 'delete_memory_store') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '') != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') = ''))))), 0) AS llmCacheReadTokens,
          countIf(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cost'], ''), ''), coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.cost'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.total_cost'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.cost.total'], ''), '')) != '') AS costReporters,
          ifNotFinite(sum(toFloat64OrZero(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cost'], ''), ''), coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.cost'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.total_cost'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.cost.total'], ''), '')))), 0) AS cost,
          ifNotFinite(sumIf(toFloat64OrZero(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cost'], ''), ''), coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.cost'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.total_cost'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.cost.total'], ''), ''))), (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('chat', 'generate_content', 'text_completion', 'fetch_response') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') NOT IN ('embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step', 'search_memory', 'create_memory', 'update_memory', 'upsert_memory', 'delete_memory', 'create_memory_store', 'delete_memory_store') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '') != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') = ''))))), 0) AS llmCost,
          groupUniqArrayIf(50)(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', trace_detail_spans.SpanAttributes['maple_ai.model'], coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '')), ((trace_detail_spans.SpanAttributes['maple_ai.llm_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('chat', 'generate_content', 'text_completion', 'fetch_response') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') NOT IN ('embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step', 'search_memory', 'create_memory', 'update_memory', 'upsert_memory', 'delete_memory', 'create_memory_store', 'delete_memory_store') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '') != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') = '')))) AND if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', trace_detail_spans.SpanAttributes['maple_ai.model'], coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '')) != '')) AS models,
          groupUniqArrayIf(50)(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', trace_detail_spans.SpanAttributes['maple_ai.agent.name'], coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.agent.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.telemetry.functionId'], ''), '')), if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', trace_detail_spans.SpanAttributes['maple_ai.agent.name'], coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.agent.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.telemetry.functionId'], ''), '')) != '') AS agentNames
        FROM trace_detail_spans
        WHERE trace_detail_spans.OrgId = 'org_sql_catalog'
          AND trace_detail_spans.Timestamp >= '2026-01-01 10:30:00'
          AND trace_detail_spans.Timestamp <= '2026-01-03 14:15:00'
          AND trace_detail_spans.TraceId = '7f3a4b5c6d7e8f901234567890abcdef'
        GROUP BY turnKey
        ORDER BY startTime ASC
        LIMIT 1001
        FORMAT JSON

-- builder:ai-sessions:aiTraceTotalsQuery:default
SELECT
          uniqExact(trace_detail_spans.TraceId) AS traceCount,
          toString(min(trace_detail_spans.Timestamp)) AS startTime,
          fromUnixTimestamp64Nano(max(toUnixTimestamp64Nano(trace_detail_spans.Timestamp) + toInt64(trace_detail_spans.Duration))) AS endTime,
          intDiv(max(toUnixTimestamp64Nano(trace_detail_spans.Timestamp) + toInt64(trace_detail_spans.Duration)) - toUnixTimestamp64Nano(min(trace_detail_spans.Timestamp)), 1000000) AS durationMs,
          count() AS spanCount,
          countIf(trace_detail_spans.SpanAttributes['maple_ai.vendor.id'] != '') AS aiSpanCount,
          countIf((trace_detail_spans.SpanAttributes['maple_ai.llm_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('chat', 'generate_content', 'text_completion', 'fetch_response') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') NOT IN ('embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step', 'search_memory', 'create_memory', 'update_memory', 'upsert_memory', 'delete_memory', 'create_memory_store', 'delete_memory_store') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '') != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') = ''))))) AS llmCalls,
          countIf((trace_detail_spans.SpanAttributes['maple_ai.tool_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('execute_tool') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') = '' AND trace_detail_spans.SpanAttributes['maple_ai.vendor.id'] != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') != ''))))) AS toolCalls,
          countIf((trace_detail_spans.SpanAttributes['maple_ai.error'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (trace_detail_spans.StatusCode = 'Error' OR (trace_detail_spans.SpanAttributes['maple_ai.vendor.id'] != '' AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['error.type'], ''), '') != '' OR trace_detail_spans.SpanAttributes['gen_ai.response.status'] IN ('failed', 'error'))))))) AS errorSpanCount,
          ifNotFinite(sum(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.input_tokens'], ''), '')) + toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cache_write_tokens'], ''), '')), toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.input_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.prompt_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.inputTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.promptTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.token_count.prompt'], ''), '')))), 0) AS inputTokens,
          ifNotFinite(sum(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.output_tokens'], ''), '')) + toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.reasoning_tokens'], ''), '')), toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.output_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.completion_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.outputTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.completionTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.token_count.completion'], ''), '')))), 0) AS outputTokens,
          ifNotFinite(sum(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cache_read_tokens'], ''), '')), toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.cache_read.input_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.input_tokens.cached'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.cachedInputTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.inputTokenDetails.cacheReadTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.token_count.prompt_details.cache_read'], ''), '')))), 0) AS cacheReadTokens,
          ifNotFinite(sumIf(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.input_tokens'], ''), '')) + toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cache_write_tokens'], ''), '')), toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.input_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.prompt_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.inputTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.promptTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.token_count.prompt'], ''), ''))), (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('chat', 'generate_content', 'text_completion', 'fetch_response') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') NOT IN ('embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step', 'search_memory', 'create_memory', 'update_memory', 'upsert_memory', 'delete_memory', 'create_memory_store', 'delete_memory_store') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '') != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') = ''))))), 0) AS llmInputTokens,
          ifNotFinite(sumIf(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.output_tokens'], ''), '')) + toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.reasoning_tokens'], ''), '')), toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.output_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.completion_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.outputTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.completionTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.token_count.completion'], ''), ''))), (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('chat', 'generate_content', 'text_completion', 'fetch_response') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') NOT IN ('embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step', 'search_memory', 'create_memory', 'update_memory', 'upsert_memory', 'delete_memory', 'create_memory_store', 'delete_memory_store') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '') != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') = ''))))), 0) AS llmOutputTokens,
          ifNotFinite(sumIf(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cache_read_tokens'], ''), '')), toFloat64OrZero(coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.cache_read.input_tokens'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.input_tokens.cached'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.cachedInputTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.usage.inputTokenDetails.cacheReadTokens'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.token_count.prompt_details.cache_read'], ''), ''))), (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('chat', 'generate_content', 'text_completion', 'fetch_response') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') NOT IN ('embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step', 'search_memory', 'create_memory', 'update_memory', 'upsert_memory', 'delete_memory', 'create_memory_store', 'delete_memory_store') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '') != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') = ''))))), 0) AS llmCacheReadTokens,
          countIf(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cost'], ''), ''), coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.cost'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.total_cost'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.cost.total'], ''), '')) != '') AS costReporters,
          ifNotFinite(sum(toFloat64OrZero(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cost'], ''), ''), coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.cost'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.total_cost'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.cost.total'], ''), '')))), 0) AS cost,
          ifNotFinite(sumIf(toFloat64OrZero(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', coalesce(nullIf(trace_detail_spans.SpanAttributes['maple_ai.usage.cost'], ''), ''), coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.cost'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.usage.total_cost'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.cost.total'], ''), ''))), (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('chat', 'generate_content', 'text_completion', 'fetch_response') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') NOT IN ('embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step', 'search_memory', 'create_memory', 'update_memory', 'upsert_memory', 'delete_memory', 'create_memory_store', 'delete_memory_store') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '') != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') = ''))))), 0) AS llmCost,
          groupUniqArrayIf(50)(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', trace_detail_spans.SpanAttributes['maple_ai.model'], coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '')), ((trace_detail_spans.SpanAttributes['maple_ai.llm_call'] = '1' OR (NOT (trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '') AND (coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') IN ('chat', 'generate_content', 'text_completion', 'fetch_response') OR ((coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.operation.name'], ''), '') NOT IN ('embeddings', 'retrieval', 'execute_tool', 'invoke_agent', 'create_agent', 'invoke_workflow', 'plan', 'agent_step', 'search_memory', 'create_memory', 'update_memory', 'upsert_memory', 'delete_memory', 'create_memory_store', 'delete_memory_store') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '') != '') AND coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.tool.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.toolCall.name'], ''), nullIf(trace_detail_spans.SpanAttributes['tool.name'], ''), '') = '')))) AND if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', trace_detail_spans.SpanAttributes['maple_ai.model'], coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.response.model'], ''), nullIf(trace_detail_spans.SpanAttributes['gen_ai.request.model'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.model.id'], ''), nullIf(trace_detail_spans.SpanAttributes['llm.model_name'], ''), '')) != '')) AS models,
          groupUniqArrayIf(50)(if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', trace_detail_spans.SpanAttributes['maple_ai.agent.name'], coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.agent.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.telemetry.functionId'], ''), '')), if(trace_detail_spans.SpanAttributes['maple_ai.llm_call'] != '', trace_detail_spans.SpanAttributes['maple_ai.agent.name'], coalesce(nullIf(trace_detail_spans.SpanAttributes['gen_ai.agent.name'], ''), nullIf(trace_detail_spans.SpanAttributes['ai.telemetry.functionId'], ''), '')) != '') AS agentNames
        FROM trace_detail_spans
        WHERE trace_detail_spans.OrgId = 'org_sql_catalog'
          AND trace_detail_spans.Timestamp >= '2026-01-01 10:30:00'
          AND trace_detail_spans.Timestamp <= '2026-01-03 14:15:00'
          AND trace_detail_spans.TraceId = '7f3a4b5c6d7e8f901234567890abcdef'
        FORMAT JSON

-- builder:ai-sessions:aiTraceWindowQuery:default
SELECT
          toString(min(traces.Timestamp) - INTERVAL 86400 SECOND) AS startTime,
          toString(max(traces.Timestamp) + INTERVAL 86400 SECOND) AS endTime,
          count() AS spanCount
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.TraceId = '7f3a4b5c6d7e8f901234567890abcdef'
        FORMAT JSON

-- builder:ai-tools:aiToolDescriptionQuery:default
SELECT
          argMax(ai_trace_index.ToolDescription, ai_trace_index.Timestamp) AS description
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
          AND ai_trace_index.IsToolCall = 1
          AND ai_trace_index.ToolName = 'search_traces'
          AND ai_trace_index.ToolDescription != ''
        FORMAT JSON

-- builder:ai-tools:aiToolErrorBreakdownQuery:default
SELECT
          failing_tool_calls.modelName AS model,
          failing_tool_calls.service AS service,
          count() AS calls
        FROM (SELECT
          ai_trace_index.Timestamp AS ts,
          ai_trace_index.TraceId AS traceId,
          ai_trace_index.SpanId AS spanId,
          if(trace.rawSessionId = '', concat('trace:', ai_trace_index.TraceId), trace.rawSessionId) AS sessionKey,
          ai_trace_index.ToolName AS toolName,
          if(ifNull(parent.parentModel, '') != '', ifNull(parent.parentModel, ''), trace.traceModel) AS modelName,
          trace.traceVendorId AS vendor,
          trace.traceAgentName AS agent,
          ai_trace_index.IsError AS isError,
          ai_trace_index.ServiceName AS service,
          ai_trace_index.ErrorType AS errorType,
          coalesce(nullIf(ai_trace_index.FailedToolCallResult, ''), ai_trace_index.StatusMessage) AS failureMessage,
          toString(ai_trace_index.ErrorFingerprint) AS fingerprint,
          ai_trace_index.Duration AS durationNs
        FROM ai_trace_index
        LEFT JOIN (SELECT
          ai_trace_index.TraceId AS TraceId,
          ai_trace_index.SpanId AS SpanId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS parentModel
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
          AND ai_trace_index.Model != ''
        GROUP BY TraceId, SpanId) AS parent ON (ai_trace_index.TraceId = parent.TraceId AND ai_trace_index.ParentSpanId = parent.SpanId)
        INNER JOIN (SELECT
          ai_trace_index.TraceId AS TraceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS traceModel,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS traceVendorId,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS traceAgentName
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY TraceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS trace ON ai_trace_index.TraceId = trace.TraceId
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
          AND ai_trace_index.IsToolCall = 1
          AND ai_trace_index.ToolName = 'search_traces'
          AND ai_trace_index.ServiceName = 'agent'
          AND if(ifNull(parent.parentModel, '') != '', ifNull(parent.parentModel, ''), trace.traceModel) = 'claude-sonnet-5'
          AND ai_trace_index.IsError = 1) AS failing_tool_calls
        WHERE failing_tool_calls.fingerprint = '12345678901234567890'
        GROUP BY model, service
        ORDER BY calls DESC, model ASC, service ASC
        LIMIT 100
        FORMAT JSON

-- builder:ai-tools:aiToolErrorOccurrencesQuery:default
SELECT
          toString(failing_tool_calls.ts) AS timestamp,
          failing_tool_calls.traceId AS traceId,
          failing_tool_calls.spanId AS spanId,
          failing_tool_calls.sessionKey AS sessionId,
          failing_tool_calls.vendor AS vendorId,
          failing_tool_calls.agent AS agentName,
          failing_tool_calls.modelName AS model,
          failing_tool_calls.service AS service,
          failing_tool_calls.errorType AS errorType,
          failing_tool_calls.failureMessage AS message,
          failing_tool_calls.durationNs AS durationNs
        FROM (SELECT
          ai_trace_index.Timestamp AS ts,
          ai_trace_index.TraceId AS traceId,
          ai_trace_index.SpanId AS spanId,
          if(trace.rawSessionId = '', concat('trace:', ai_trace_index.TraceId), trace.rawSessionId) AS sessionKey,
          ai_trace_index.ToolName AS toolName,
          if(ifNull(parent.parentModel, '') != '', ifNull(parent.parentModel, ''), trace.traceModel) AS modelName,
          trace.traceVendorId AS vendor,
          trace.traceAgentName AS agent,
          ai_trace_index.IsError AS isError,
          ai_trace_index.ServiceName AS service,
          ai_trace_index.ErrorType AS errorType,
          coalesce(nullIf(ai_trace_index.FailedToolCallResult, ''), ai_trace_index.StatusMessage) AS failureMessage,
          toString(ai_trace_index.ErrorFingerprint) AS fingerprint,
          ai_trace_index.Duration AS durationNs
        FROM ai_trace_index
        LEFT JOIN (SELECT
          ai_trace_index.TraceId AS TraceId,
          ai_trace_index.SpanId AS SpanId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS parentModel
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
          AND ai_trace_index.Model != ''
        GROUP BY TraceId, SpanId) AS parent ON (ai_trace_index.TraceId = parent.TraceId AND ai_trace_index.ParentSpanId = parent.SpanId)
        INNER JOIN (SELECT
          ai_trace_index.TraceId AS TraceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS traceModel,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS traceVendorId,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS traceAgentName
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY TraceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS trace ON ai_trace_index.TraceId = trace.TraceId
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
          AND ai_trace_index.IsToolCall = 1
          AND ai_trace_index.ToolName = 'search_traces'
          AND ai_trace_index.ServiceName = 'agent'
          AND if(ifNull(parent.parentModel, '') != '', ifNull(parent.parentModel, ''), trace.traceModel) = 'claude-sonnet-5'
          AND ai_trace_index.IsError = 1) AS failing_tool_calls
        WHERE failing_tool_calls.fingerprint = '12345678901234567890'
          AND failing_tool_calls.sessionKey = 'wrun_sql_catalog'
          AND failing_tool_calls.failureMessage = '{"result":"Invalid tool input: Missing key\\n  at [\\"claim\\"]"}'
          AND (failing_tool_calls.ts < '2026-01-02 11:45:30.000000000' OR (failing_tool_calls.ts = '2026-01-02 11:45:30.000000000' AND failing_tool_calls.spanId < '00000000000007d1'))
        ORDER BY timestamp DESC, spanId DESC
        LIMIT 25
        FORMAT JSON

-- builder:ai-tools:aiToolErrorPayloadsQuery:default
SELECT
          trace_detail_spans.TraceId AS traceId,
          trace_detail_spans.SpanId AS spanId,
          trace_detail_spans.StatusCode AS statusCode,
          mapApply((k, v) -> (k, leftUTF8(v, 16384)), mapFilter((k, v) -> (((k IN ('maple_ai.session.id', 'maple_ai.vendor.id', 'maple_ai.vendor.version', 'maple_ai.agent.name', 'gen_ai.operation.name', 'gen_ai.provider.name', 'gen_ai.system', 'gen_ai.request.model', 'gen_ai.request.max_tokens', 'gen_ai.request.choice.count', 'gen_ai.request.temperature', 'gen_ai.request.top_p', 'gen_ai.request.top_k', 'gen_ai.request.stop_sequences', 'gen_ai.request.frequency_penalty', 'gen_ai.request.presence_penalty', 'gen_ai.request.encoding_formats', 'gen_ai.request.seed', 'gen_ai.openai.request.seed', 'gen_ai.request.stream', 'gen_ai.request.reasoning.level', 'gen_ai.request.previous_response.id', 'gen_ai.request.stream_cursor', 'gen_ai.response.id', 'gen_ai.response.model', 'gen_ai.response.finish_reasons', 'gen_ai.response.finish_reason', 'gen_ai.response.status', 'gen_ai.response.time_to_first_chunk', 'gen_ai.output.type', 'gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens', 'gen_ai.usage.cache_read.input_tokens', 'gen_ai.usage.input_tokens.cached', 'gen_ai.usage.cache_creation.input_tokens', 'gen_ai.usage.cache_write.input_tokens', 'gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens', 'gen_ai.usage.reasoning.output_tokens', 'gen_ai.usage.output_tokens.reasoning', 'gen_ai.usage.cost', 'gen_ai.usage.total_cost', 'maple_ai.llm_call', 'maple_ai.tool_call', 'maple_ai.error', 'maple_ai.usage.input_tokens', 'maple_ai.usage.cache_read_tokens', 'maple_ai.usage.cache_write_tokens', 'maple_ai.usage.output_tokens', 'maple_ai.usage.reasoning_tokens', 'maple_ai.usage.cost', 'gen_ai.conversation.id', 'gen_ai.conversation.compacted', 'gen_ai.agent.id', 'gen_ai.agent.name', 'gen_ai.agent.description', 'gen_ai.agent.version', 'gen_ai.tool.name', 'gen_ai.tool.call.id', 'gen_ai.tool.description', 'gen_ai.tool.type', 'gen_ai.tool.call.arguments', 'gen_ai.tool.call.result', 'gen_ai.tool.definitions', 'gen_ai.system_instructions', 'gen_ai.input.messages', 'gen_ai.prompt', 'gen_ai.output.messages', 'gen_ai.completion', 'gen_ai.data_source.id', 'gen_ai.retrieval.query.text', 'gen_ai.retrieval.top_k', 'gen_ai.retrieval.documents', 'gen_ai.memory.store.id', 'gen_ai.memory.record.id', 'gen_ai.memory.record.count', 'gen_ai.memory.query.text', 'gen_ai.memory.records', 'gen_ai.embeddings.dimension.count', 'gen_ai.evaluation.name', 'gen_ai.evaluation.score.value', 'gen_ai.evaluation.score.label', 'gen_ai.evaluation.explanation', 'gen_ai.prompt.name', 'gen_ai.prompt.version', 'gen_ai.workflow.name', 'span.metadata.attempt_index', 'span.metadata.status_code', 'trace.metadata.openrouter.provider_name', 'error.type', 'server.address', 'server.port', 'ai.model.provider', 'ai.model.id', 'ai.response.id', 'ai.response.model', 'ai.response.finishReason', 'gen_ai.client.operation.time_to_first_chunk', 'ai.usage.inputTokens', 'ai.usage.promptTokens', 'ai.usage.cachedInputTokens', 'ai.usage.inputTokenDetails.cacheReadTokens', 'ai.usage.inputTokenDetails.cacheWriteTokens', 'ai.usage.outputTokens', 'ai.usage.completionTokens', 'ai.usage.reasoningTokens', 'ai.usage.outputTokenDetails.reasoningTokens', 'ai.telemetry.functionId', 'ai.toolCall.name', 'ai.toolCall.id', 'ai.toolCall.args', 'ai.toolCall.result', 'ai.prompt.tools', 'ai.prompt.messages', 'ai.prompt', 'llm.provider', 'llm.system', 'llm.model_name', 'llm.finish_reason', 'llm.token_count.prompt', 'llm.token_count.prompt_details.cache_read', 'llm.token_count.completion', 'llm.token_count.completion_details.reasoning', 'llm.cost.total', 'tool.name', 'tool.description', 'llm.tools', 'openinference.span.kind', 'tool.parameters', 'input.value', 'output.value', 'eve.turn.id', 'maple_ai.turn.id') OR k LIKE 'gen_ai.prompt.variable.%') OR k LIKE 'llm.input_messages.%') OR k LIKE 'llm.output_messages.%'), trace_detail_spans.SpanAttributes)) AS spanAttributes,
          mapApply((k, v) -> (k, length(v)), mapFilter((k, v) -> lengthUTF8(v) > 16384, mapFilter((k, v) -> (((k IN ('maple_ai.session.id', 'maple_ai.vendor.id', 'maple_ai.vendor.version', 'maple_ai.agent.name', 'gen_ai.operation.name', 'gen_ai.provider.name', 'gen_ai.system', 'gen_ai.request.model', 'gen_ai.request.max_tokens', 'gen_ai.request.choice.count', 'gen_ai.request.temperature', 'gen_ai.request.top_p', 'gen_ai.request.top_k', 'gen_ai.request.stop_sequences', 'gen_ai.request.frequency_penalty', 'gen_ai.request.presence_penalty', 'gen_ai.request.encoding_formats', 'gen_ai.request.seed', 'gen_ai.openai.request.seed', 'gen_ai.request.stream', 'gen_ai.request.reasoning.level', 'gen_ai.request.previous_response.id', 'gen_ai.request.stream_cursor', 'gen_ai.response.id', 'gen_ai.response.model', 'gen_ai.response.finish_reasons', 'gen_ai.response.finish_reason', 'gen_ai.response.status', 'gen_ai.response.time_to_first_chunk', 'gen_ai.output.type', 'gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens', 'gen_ai.usage.cache_read.input_tokens', 'gen_ai.usage.input_tokens.cached', 'gen_ai.usage.cache_creation.input_tokens', 'gen_ai.usage.cache_write.input_tokens', 'gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens', 'gen_ai.usage.reasoning.output_tokens', 'gen_ai.usage.output_tokens.reasoning', 'gen_ai.usage.cost', 'gen_ai.usage.total_cost', 'maple_ai.llm_call', 'maple_ai.tool_call', 'maple_ai.error', 'maple_ai.usage.input_tokens', 'maple_ai.usage.cache_read_tokens', 'maple_ai.usage.cache_write_tokens', 'maple_ai.usage.output_tokens', 'maple_ai.usage.reasoning_tokens', 'maple_ai.usage.cost', 'gen_ai.conversation.id', 'gen_ai.conversation.compacted', 'gen_ai.agent.id', 'gen_ai.agent.name', 'gen_ai.agent.description', 'gen_ai.agent.version', 'gen_ai.tool.name', 'gen_ai.tool.call.id', 'gen_ai.tool.description', 'gen_ai.tool.type', 'gen_ai.tool.call.arguments', 'gen_ai.tool.call.result', 'gen_ai.tool.definitions', 'gen_ai.system_instructions', 'gen_ai.input.messages', 'gen_ai.prompt', 'gen_ai.output.messages', 'gen_ai.completion', 'gen_ai.data_source.id', 'gen_ai.retrieval.query.text', 'gen_ai.retrieval.top_k', 'gen_ai.retrieval.documents', 'gen_ai.memory.store.id', 'gen_ai.memory.record.id', 'gen_ai.memory.record.count', 'gen_ai.memory.query.text', 'gen_ai.memory.records', 'gen_ai.embeddings.dimension.count', 'gen_ai.evaluation.name', 'gen_ai.evaluation.score.value', 'gen_ai.evaluation.score.label', 'gen_ai.evaluation.explanation', 'gen_ai.prompt.name', 'gen_ai.prompt.version', 'gen_ai.workflow.name', 'span.metadata.attempt_index', 'span.metadata.status_code', 'trace.metadata.openrouter.provider_name', 'error.type', 'server.address', 'server.port', 'ai.model.provider', 'ai.model.id', 'ai.response.id', 'ai.response.model', 'ai.response.finishReason', 'gen_ai.client.operation.time_to_first_chunk', 'ai.usage.inputTokens', 'ai.usage.promptTokens', 'ai.usage.cachedInputTokens', 'ai.usage.inputTokenDetails.cacheReadTokens', 'ai.usage.inputTokenDetails.cacheWriteTokens', 'ai.usage.outputTokens', 'ai.usage.completionTokens', 'ai.usage.reasoningTokens', 'ai.usage.outputTokenDetails.reasoningTokens', 'ai.telemetry.functionId', 'ai.toolCall.name', 'ai.toolCall.id', 'ai.toolCall.args', 'ai.toolCall.result', 'ai.prompt.tools', 'ai.prompt.messages', 'ai.prompt', 'llm.provider', 'llm.system', 'llm.model_name', 'llm.finish_reason', 'llm.token_count.prompt', 'llm.token_count.prompt_details.cache_read', 'llm.token_count.completion', 'llm.token_count.completion_details.reasoning', 'llm.cost.total', 'tool.name', 'tool.description', 'llm.tools', 'openinference.span.kind', 'tool.parameters', 'input.value', 'output.value', 'eve.turn.id', 'maple_ai.turn.id') OR k LIKE 'gen_ai.prompt.variable.%') OR k LIKE 'llm.input_messages.%') OR k LIKE 'llm.output_messages.%'), trace_detail_spans.SpanAttributes))) AS cutAttributeBytes
        FROM trace_detail_spans
        WHERE trace_detail_spans.OrgId = 'org_sql_catalog'
          AND trace_detail_spans.Timestamp >= '2026-01-02 11:15:00.000000000'
          AND trace_detail_spans.Timestamp <= '2026-01-02 11:45:30.000000000'
          AND (trace_detail_spans.TraceId, trace_detail_spans.SpanId) IN (tuple('7f3a4b5c6d7e8f901234567890abcdef', '00000000000007d0'), tuple('7f3a4b5c6d7e8f901234567890abcdef', '00000000000007d1'))
        FORMAT JSON

-- builder:ai-tools:aiToolErrorSessionsQuery:default
SELECT
          failing_tool_calls.sessionKey AS sessionId,
          anyIf(failing_tool_calls.vendor, failing_tool_calls.vendor != '') AS vendorId,
          anyIf(failing_tool_calls.agent, failing_tool_calls.agent != '') AS agentName,
          anyIf(failing_tool_calls.service, failing_tool_calls.service != '') AS service,
          count() AS hits,
          toString(max(failing_tool_calls.ts)) AS lastSeen
        FROM (SELECT
          ai_trace_index.Timestamp AS ts,
          ai_trace_index.TraceId AS traceId,
          ai_trace_index.SpanId AS spanId,
          if(trace.rawSessionId = '', concat('trace:', ai_trace_index.TraceId), trace.rawSessionId) AS sessionKey,
          ai_trace_index.ToolName AS toolName,
          if(ifNull(parent.parentModel, '') != '', ifNull(parent.parentModel, ''), trace.traceModel) AS modelName,
          trace.traceVendorId AS vendor,
          trace.traceAgentName AS agent,
          ai_trace_index.IsError AS isError,
          ai_trace_index.ServiceName AS service,
          ai_trace_index.ErrorType AS errorType,
          coalesce(nullIf(ai_trace_index.FailedToolCallResult, ''), ai_trace_index.StatusMessage) AS failureMessage,
          toString(ai_trace_index.ErrorFingerprint) AS fingerprint,
          ai_trace_index.Duration AS durationNs
        FROM ai_trace_index
        LEFT JOIN (SELECT
          ai_trace_index.TraceId AS TraceId,
          ai_trace_index.SpanId AS SpanId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS parentModel
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
          AND ai_trace_index.Model != ''
        GROUP BY TraceId, SpanId) AS parent ON (ai_trace_index.TraceId = parent.TraceId AND ai_trace_index.ParentSpanId = parent.SpanId)
        INNER JOIN (SELECT
          ai_trace_index.TraceId AS TraceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS traceModel,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS traceVendorId,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS traceAgentName
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY TraceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS trace ON ai_trace_index.TraceId = trace.TraceId
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
          AND ai_trace_index.IsToolCall = 1
          AND ai_trace_index.ToolName = 'search_traces'
          AND ai_trace_index.ServiceName = 'agent'
          AND if(ifNull(parent.parentModel, '') != '', ifNull(parent.parentModel, ''), trace.traceModel) = 'claude-sonnet-5'
          AND ai_trace_index.IsError = 1) AS failing_tool_calls
        WHERE failing_tool_calls.fingerprint = '12345678901234567890'
        GROUP BY sessionId
        ORDER BY hits DESC, sessionId ASC
        LIMIT 50
        FORMAT JSON

-- builder:ai-tools:aiToolErrorsQuery:default
SELECT
          numbered_tool_calls.fingerprint AS fingerprint,
          argMax(numbered_tool_calls.callErrorType, numbered_tool_calls.ts) AS errorType,
          argMax(numbered_tool_calls.failureMessage, numbered_tool_calls.ts) AS message,
          count() AS calls,
          uniqExact(numbered_tool_calls.sessionKey) AS sessions,
          uniqExact(numbered_tool_calls.failureMessage) AS variants,
          toString(min(numbered_tool_calls.ts)) AS firstSeen,
          toString(max(numbered_tool_calls.ts)) AS lastSeen,
          min(numbered_tool_calls.newerCalls) AS callsSince,
          sumMap(map(bucket, toUInt64(1))) AS trend
        FROM (SELECT
          tool_calls.ts AS ts,
          formatDateTime(toStartOfInterval(tool_calls.ts, INTERVAL 300 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          tool_calls.sessionKey AS sessionKey,
          tool_calls.isError AS isError,
          tool_calls.errorType AS callErrorType,
          tool_calls.failureMessage AS failureMessage,
          tool_calls.fingerprint AS fingerprint,
          row_number() OVER (ORDER BY ts DESC, spanId DESC) - 1 AS newerCalls
        FROM (SELECT
          ai_trace_index.Timestamp AS ts,
          ai_trace_index.TraceId AS traceId,
          ai_trace_index.SpanId AS spanId,
          if(trace.rawSessionId = '', concat('trace:', ai_trace_index.TraceId), trace.rawSessionId) AS sessionKey,
          ai_trace_index.ToolName AS toolName,
          if(ifNull(parent.parentModel, '') != '', ifNull(parent.parentModel, ''), trace.traceModel) AS modelName,
          trace.traceVendorId AS vendor,
          trace.traceAgentName AS agent,
          ai_trace_index.IsError AS isError,
          ai_trace_index.ServiceName AS service,
          ai_trace_index.ErrorType AS errorType,
          coalesce(nullIf(ai_trace_index.FailedToolCallResult, ''), ai_trace_index.StatusMessage) AS failureMessage,
          toString(ai_trace_index.ErrorFingerprint) AS fingerprint,
          ai_trace_index.Duration AS durationNs
        FROM ai_trace_index
        LEFT JOIN (SELECT
          ai_trace_index.TraceId AS TraceId,
          ai_trace_index.SpanId AS SpanId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS parentModel
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
          AND ai_trace_index.Model != ''
        GROUP BY TraceId, SpanId) AS parent ON (ai_trace_index.TraceId = parent.TraceId AND ai_trace_index.ParentSpanId = parent.SpanId)
        INNER JOIN (SELECT
          ai_trace_index.TraceId AS TraceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS traceModel,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS traceVendorId,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS traceAgentName
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY TraceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS trace ON ai_trace_index.TraceId = trace.TraceId
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
          AND ai_trace_index.IsToolCall = 1
          AND ai_trace_index.ToolName = 'search_traces'
          AND ai_trace_index.ServiceName = 'agent'
          AND if(ifNull(parent.parentModel, '') != '', ifNull(parent.parentModel, ''), trace.traceModel) = 'claude-sonnet-5') AS tool_calls) AS numbered_tool_calls
        WHERE numbered_tool_calls.isError = 1
        GROUP BY fingerprint
        ORDER BY calls DESC, fingerprint ASC
        LIMIT 50
        FORMAT JSON

-- builder:ai-tools:aiToolErrorVariantsQuery:default
SELECT
          failing_tool_calls.failureMessage AS message,
          count() AS calls,
          toString(max(failing_tool_calls.ts)) AS lastSeen
        FROM (SELECT
          ai_trace_index.Timestamp AS ts,
          ai_trace_index.TraceId AS traceId,
          ai_trace_index.SpanId AS spanId,
          if(trace.rawSessionId = '', concat('trace:', ai_trace_index.TraceId), trace.rawSessionId) AS sessionKey,
          ai_trace_index.ToolName AS toolName,
          if(ifNull(parent.parentModel, '') != '', ifNull(parent.parentModel, ''), trace.traceModel) AS modelName,
          trace.traceVendorId AS vendor,
          trace.traceAgentName AS agent,
          ai_trace_index.IsError AS isError,
          ai_trace_index.ServiceName AS service,
          ai_trace_index.ErrorType AS errorType,
          coalesce(nullIf(ai_trace_index.FailedToolCallResult, ''), ai_trace_index.StatusMessage) AS failureMessage,
          toString(ai_trace_index.ErrorFingerprint) AS fingerprint,
          ai_trace_index.Duration AS durationNs
        FROM ai_trace_index
        LEFT JOIN (SELECT
          ai_trace_index.TraceId AS TraceId,
          ai_trace_index.SpanId AS SpanId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS parentModel
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
          AND ai_trace_index.Model != ''
        GROUP BY TraceId, SpanId) AS parent ON (ai_trace_index.TraceId = parent.TraceId AND ai_trace_index.ParentSpanId = parent.SpanId)
        INNER JOIN (SELECT
          ai_trace_index.TraceId AS TraceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS traceModel,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS traceVendorId,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS traceAgentName
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY TraceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS trace ON ai_trace_index.TraceId = trace.TraceId
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
          AND ai_trace_index.IsToolCall = 1
          AND ai_trace_index.ToolName = 'search_traces'
          AND ai_trace_index.ServiceName = 'agent'
          AND if(ifNull(parent.parentModel, '') != '', ifNull(parent.parentModel, ''), trace.traceModel) = 'claude-sonnet-5'
          AND ai_trace_index.IsError = 1) AS failing_tool_calls
        WHERE failing_tool_calls.fingerprint = '12345678901234567890'
        GROUP BY message
        ORDER BY calls DESC, message ASC
        LIMIT 20
        FORMAT JSON

-- builder:ai-tools:aiToolsBreakdownsQuery:default
SELECT
          tool_breakdown.toolName AS key,
          count() AS calls,
          uniqExact(tool_breakdown.sessionKey) AS sessions,
          sum(tool_breakdown.isError) AS errors,
          ifNull(ifNotFinite(quantile(0.5)(tool_breakdown.durationNs), 0), 0) AS p50,
          ifNull(ifNotFinite(quantile(0.9)(tool_breakdown.durationNs), 0), 0) AS p90,
          ifNull(ifNotFinite(quantile(0.95)(tool_breakdown.durationNs), 0), 0) AS p95,
          toString(max(tool_breakdown.ts)) AS lastSeen,
          toString(min(tool_breakdown.ts)) AS firstSeen
        FROM (SELECT
          ai_trace_index.Timestamp AS ts,
          ai_trace_index.TraceId AS traceId,
          ai_trace_index.SpanId AS spanId,
          if(trace.rawSessionId = '', concat('trace:', ai_trace_index.TraceId), trace.rawSessionId) AS sessionKey,
          ai_trace_index.ToolName AS toolName,
          if(ifNull(parent.parentModel, '') != '', ifNull(parent.parentModel, ''), trace.traceModel) AS modelName,
          trace.traceVendorId AS vendor,
          trace.traceAgentName AS agent,
          ai_trace_index.IsError AS isError,
          ai_trace_index.ServiceName AS service,
          ai_trace_index.ErrorType AS errorType,
          coalesce(nullIf(ai_trace_index.FailedToolCallResult, ''), ai_trace_index.StatusMessage) AS failureMessage,
          toString(ai_trace_index.ErrorFingerprint) AS fingerprint,
          ai_trace_index.Duration AS durationNs
        FROM ai_trace_index
        LEFT JOIN (SELECT
          ai_trace_index.TraceId AS TraceId,
          ai_trace_index.SpanId AS SpanId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS parentModel
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
          AND ai_trace_index.Model != ''
        GROUP BY TraceId, SpanId) AS parent ON (ai_trace_index.TraceId = parent.TraceId AND ai_trace_index.ParentSpanId = parent.SpanId)
        INNER JOIN (SELECT
          ai_trace_index.TraceId AS TraceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS traceModel,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS traceVendorId,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS traceAgentName
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY TraceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS trace ON ai_trace_index.TraceId = trace.TraceId
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
          AND ai_trace_index.IsToolCall = 1
          AND if(ifNull(parent.parentModel, '') != '', ifNull(parent.parentModel, ''), trace.traceModel) = 'claude-sonnet-5'
          AND ai_trace_index.ToolName ILIKE '%search\\_%'
          AND ai_trace_index.IsError = 1) AS tool_breakdown
        GROUP BY key
        ORDER BY calls DESC, key ASC
        LIMIT 50
        FORMAT JSON

-- builder:ai-tools:aiToolsSeriesQuery:default
SELECT
          formatDateTime(toStartOfInterval(tool_calls.ts, INTERVAL 300 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          if(tool_calls.toolName IN (SELECT
          top_series_keys.rankKey AS topKey
        FROM (SELECT
          series_ranking.toolName AS rankKey,
          count() AS rankCalls
        FROM (SELECT
          ai_trace_index.Timestamp AS ts,
          ai_trace_index.TraceId AS traceId,
          ai_trace_index.SpanId AS spanId,
          if(trace.rawSessionId = '', concat('trace:', ai_trace_index.TraceId), trace.rawSessionId) AS sessionKey,
          ai_trace_index.ToolName AS toolName,
          trace.traceModel AS modelName,
          trace.traceVendorId AS vendor,
          trace.traceAgentName AS agent,
          ai_trace_index.IsError AS isError,
          ai_trace_index.ServiceName AS service,
          ai_trace_index.ErrorType AS errorType,
          coalesce(nullIf(ai_trace_index.FailedToolCallResult, ''), ai_trace_index.StatusMessage) AS failureMessage,
          toString(ai_trace_index.ErrorFingerprint) AS fingerprint,
          ai_trace_index.Duration AS durationNs
        FROM ai_trace_index
        INNER JOIN (SELECT
          ai_trace_index.TraceId AS TraceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS traceModel,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS traceVendorId,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS traceAgentName
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY TraceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS trace ON ai_trace_index.TraceId = trace.TraceId
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
          AND ai_trace_index.IsToolCall = 1) AS series_ranking
        GROUP BY rankKey
        ORDER BY rankCalls DESC, rankKey ASC
        LIMIT 8) AS top_series_keys), tool_calls.toolName, 'other') AS seriesKey,
          count() AS calls,
          uniqExact(tool_calls.sessionKey) AS sessions,
          sum(tool_calls.isError) AS errors,
          ifNull(ifNotFinite(quantile(0.5)(tool_calls.durationNs), 0), 0) AS p50,
          ifNull(ifNotFinite(quantile(0.9)(tool_calls.durationNs), 0), 0) AS p90,
          ifNull(ifNotFinite(quantile(0.95)(tool_calls.durationNs), 0), 0) AS p95
        FROM (SELECT
          ai_trace_index.Timestamp AS ts,
          ai_trace_index.TraceId AS traceId,
          ai_trace_index.SpanId AS spanId,
          if(trace.rawSessionId = '', concat('trace:', ai_trace_index.TraceId), trace.rawSessionId) AS sessionKey,
          ai_trace_index.ToolName AS toolName,
          trace.traceModel AS modelName,
          trace.traceVendorId AS vendor,
          trace.traceAgentName AS agent,
          ai_trace_index.IsError AS isError,
          ai_trace_index.ServiceName AS service,
          ai_trace_index.ErrorType AS errorType,
          coalesce(nullIf(ai_trace_index.FailedToolCallResult, ''), ai_trace_index.StatusMessage) AS failureMessage,
          toString(ai_trace_index.ErrorFingerprint) AS fingerprint,
          ai_trace_index.Duration AS durationNs
        FROM ai_trace_index
        INNER JOIN (SELECT
          ai_trace_index.TraceId AS TraceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS traceModel,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS traceVendorId,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS traceAgentName
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY TraceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS trace ON ai_trace_index.TraceId = trace.TraceId
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
          AND ai_trace_index.IsToolCall = 1) AS tool_calls
        GROUP BY bucket, seriesKey
        ORDER BY bucket ASC, calls DESC, seriesKey ASC
        FORMAT JSON

-- builder:ai-tools:aiToolsSeriesQuery:searched
SELECT
          formatDateTime(toStartOfInterval(tool_calls.ts, INTERVAL 300 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          if(tool_calls.toolName IN (SELECT
          top_series_keys.rankKey AS topKey
        FROM (SELECT
          series_ranking.toolName AS rankKey,
          count() AS rankCalls
        FROM (SELECT
          ai_trace_index.Timestamp AS ts,
          ai_trace_index.TraceId AS traceId,
          ai_trace_index.SpanId AS spanId,
          if(trace.rawSessionId = '', concat('trace:', ai_trace_index.TraceId), trace.rawSessionId) AS sessionKey,
          ai_trace_index.ToolName AS toolName,
          trace.traceModel AS modelName,
          trace.traceVendorId AS vendor,
          trace.traceAgentName AS agent,
          ai_trace_index.IsError AS isError,
          ai_trace_index.ServiceName AS service,
          ai_trace_index.ErrorType AS errorType,
          coalesce(nullIf(ai_trace_index.FailedToolCallResult, ''), ai_trace_index.StatusMessage) AS failureMessage,
          toString(ai_trace_index.ErrorFingerprint) AS fingerprint,
          ai_trace_index.Duration AS durationNs
        FROM ai_trace_index
        INNER JOIN (SELECT
          ai_trace_index.TraceId AS TraceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS traceModel,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS traceVendorId,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS traceAgentName
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY TraceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS trace ON ai_trace_index.TraceId = trace.TraceId
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
          AND ai_trace_index.IsToolCall = 1
          AND ai_trace_index.ToolName ILIKE '%search\\_%'
          AND ai_trace_index.IsError = 1) AS series_ranking
        GROUP BY rankKey
        ORDER BY rankCalls DESC, rankKey ASC
        LIMIT 8) AS top_series_keys), tool_calls.toolName, 'other') AS seriesKey,
          count() AS calls,
          uniqExact(tool_calls.sessionKey) AS sessions,
          sum(tool_calls.isError) AS errors,
          ifNull(ifNotFinite(quantile(0.5)(tool_calls.durationNs), 0), 0) AS p50,
          ifNull(ifNotFinite(quantile(0.9)(tool_calls.durationNs), 0), 0) AS p90,
          ifNull(ifNotFinite(quantile(0.95)(tool_calls.durationNs), 0), 0) AS p95
        FROM (SELECT
          ai_trace_index.Timestamp AS ts,
          ai_trace_index.TraceId AS traceId,
          ai_trace_index.SpanId AS spanId,
          if(trace.rawSessionId = '', concat('trace:', ai_trace_index.TraceId), trace.rawSessionId) AS sessionKey,
          ai_trace_index.ToolName AS toolName,
          trace.traceModel AS modelName,
          trace.traceVendorId AS vendor,
          trace.traceAgentName AS agent,
          ai_trace_index.IsError AS isError,
          ai_trace_index.ServiceName AS service,
          ai_trace_index.ErrorType AS errorType,
          coalesce(nullIf(ai_trace_index.FailedToolCallResult, ''), ai_trace_index.StatusMessage) AS failureMessage,
          toString(ai_trace_index.ErrorFingerprint) AS fingerprint,
          ai_trace_index.Duration AS durationNs
        FROM ai_trace_index
        INNER JOIN (SELECT
          ai_trace_index.TraceId AS TraceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS traceModel,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS traceVendorId,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS traceAgentName
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY TraceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS trace ON ai_trace_index.TraceId = trace.TraceId
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
          AND ai_trace_index.IsToolCall = 1
          AND ai_trace_index.ToolName ILIKE '%search\\_%'
          AND ai_trace_index.IsError = 1) AS tool_calls
        GROUP BY bucket, seriesKey
        ORDER BY bucket ASC, calls DESC, seriesKey ASC
        FORMAT JSON

-- builder:ai-tools:aiToolsSeriesQuery:split-none
SELECT
          formatDateTime(toStartOfInterval(tool_calls.ts, INTERVAL 300 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          '' AS seriesKey,
          count() AS calls,
          uniqExact(tool_calls.sessionKey) AS sessions,
          sum(tool_calls.isError) AS errors,
          ifNull(ifNotFinite(quantile(0.5)(tool_calls.durationNs), 0), 0) AS p50,
          ifNull(ifNotFinite(quantile(0.9)(tool_calls.durationNs), 0), 0) AS p90,
          ifNull(ifNotFinite(quantile(0.95)(tool_calls.durationNs), 0), 0) AS p95
        FROM (SELECT
          ai_trace_index.Timestamp AS ts,
          ai_trace_index.TraceId AS traceId,
          ai_trace_index.SpanId AS spanId,
          if(trace.rawSessionId = '', concat('trace:', ai_trace_index.TraceId), trace.rawSessionId) AS sessionKey,
          ai_trace_index.ToolName AS toolName,
          trace.traceModel AS modelName,
          trace.traceVendorId AS vendor,
          trace.traceAgentName AS agent,
          ai_trace_index.IsError AS isError,
          ai_trace_index.ServiceName AS service,
          ai_trace_index.ErrorType AS errorType,
          coalesce(nullIf(ai_trace_index.FailedToolCallResult, ''), ai_trace_index.StatusMessage) AS failureMessage,
          toString(ai_trace_index.ErrorFingerprint) AS fingerprint,
          ai_trace_index.Duration AS durationNs
        FROM ai_trace_index
        INNER JOIN (SELECT
          ai_trace_index.TraceId AS TraceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS traceModel,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS traceVendorId,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS traceAgentName
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY TraceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS trace ON ai_trace_index.TraceId = trace.TraceId
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
          AND ai_trace_index.IsToolCall = 1
          AND ai_trace_index.ToolName = 'search_traces') AS tool_calls
        GROUP BY bucket, seriesKey
        ORDER BY bucket ASC, calls DESC, seriesKey ASC
        FORMAT JSON

-- builder:ai-tools:aiToolsSeriesQuery:tool-selected
SELECT
          formatDateTime(toStartOfInterval(tool_calls.ts, INTERVAL 300 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          if(tool_calls.modelName IN (SELECT
          top_series_keys.rankKey AS topKey
        FROM (SELECT
          series_ranking.modelName AS rankKey,
          count() AS rankCalls
        FROM (SELECT
          ai_trace_index.Timestamp AS ts,
          ai_trace_index.TraceId AS traceId,
          ai_trace_index.SpanId AS spanId,
          if(trace.rawSessionId = '', concat('trace:', ai_trace_index.TraceId), trace.rawSessionId) AS sessionKey,
          ai_trace_index.ToolName AS toolName,
          if(ifNull(parent.parentModel, '') != '', ifNull(parent.parentModel, ''), trace.traceModel) AS modelName,
          trace.traceVendorId AS vendor,
          trace.traceAgentName AS agent,
          ai_trace_index.IsError AS isError,
          ai_trace_index.ServiceName AS service,
          ai_trace_index.ErrorType AS errorType,
          coalesce(nullIf(ai_trace_index.FailedToolCallResult, ''), ai_trace_index.StatusMessage) AS failureMessage,
          toString(ai_trace_index.ErrorFingerprint) AS fingerprint,
          ai_trace_index.Duration AS durationNs
        FROM ai_trace_index
        LEFT JOIN (SELECT
          ai_trace_index.TraceId AS TraceId,
          ai_trace_index.SpanId AS SpanId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS parentModel
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
          AND ai_trace_index.Model != ''
        GROUP BY TraceId, SpanId) AS parent ON (ai_trace_index.TraceId = parent.TraceId AND ai_trace_index.ParentSpanId = parent.SpanId)
        INNER JOIN (SELECT
          ai_trace_index.TraceId AS TraceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS traceModel,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS traceVendorId,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS traceAgentName
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY TraceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS trace ON ai_trace_index.TraceId = trace.TraceId
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
          AND ai_trace_index.IsToolCall = 1
          AND ai_trace_index.ToolName = 'search_traces') AS series_ranking
        GROUP BY rankKey
        ORDER BY rankCalls DESC, rankKey ASC
        LIMIT 8) AS top_series_keys), tool_calls.modelName, 'other') AS seriesKey,
          count() AS calls,
          uniqExact(tool_calls.sessionKey) AS sessions,
          sum(tool_calls.isError) AS errors,
          ifNull(ifNotFinite(quantile(0.5)(tool_calls.durationNs), 0), 0) AS p50,
          ifNull(ifNotFinite(quantile(0.9)(tool_calls.durationNs), 0), 0) AS p90,
          ifNull(ifNotFinite(quantile(0.95)(tool_calls.durationNs), 0), 0) AS p95
        FROM (SELECT
          ai_trace_index.Timestamp AS ts,
          ai_trace_index.TraceId AS traceId,
          ai_trace_index.SpanId AS spanId,
          if(trace.rawSessionId = '', concat('trace:', ai_trace_index.TraceId), trace.rawSessionId) AS sessionKey,
          ai_trace_index.ToolName AS toolName,
          if(ifNull(parent.parentModel, '') != '', ifNull(parent.parentModel, ''), trace.traceModel) AS modelName,
          trace.traceVendorId AS vendor,
          trace.traceAgentName AS agent,
          ai_trace_index.IsError AS isError,
          ai_trace_index.ServiceName AS service,
          ai_trace_index.ErrorType AS errorType,
          coalesce(nullIf(ai_trace_index.FailedToolCallResult, ''), ai_trace_index.StatusMessage) AS failureMessage,
          toString(ai_trace_index.ErrorFingerprint) AS fingerprint,
          ai_trace_index.Duration AS durationNs
        FROM ai_trace_index
        LEFT JOIN (SELECT
          ai_trace_index.TraceId AS TraceId,
          ai_trace_index.SpanId AS SpanId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS parentModel
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
          AND ai_trace_index.Model != ''
        GROUP BY TraceId, SpanId) AS parent ON (ai_trace_index.TraceId = parent.TraceId AND ai_trace_index.ParentSpanId = parent.SpanId)
        INNER JOIN (SELECT
          ai_trace_index.TraceId AS TraceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS traceModel,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS traceVendorId,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS traceAgentName
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY TraceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS trace ON ai_trace_index.TraceId = trace.TraceId
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
          AND ai_trace_index.IsToolCall = 1
          AND ai_trace_index.ToolName = 'search_traces') AS tool_calls
        GROUP BY bucket, seriesKey
        ORDER BY bucket ASC, calls DESC, seriesKey ASC
        FORMAT JSON

-- builder:ai-tools:aiToolsTotalsQuery:current-only
SELECT
          'current' AS period,
          count() AS calls,
          uniqExact(tool_calls_current.sessionKey) AS sessions,
          sum(tool_calls_current.isError) AS errors,
          ifNull(ifNotFinite(quantile(0.5)(tool_calls_current.durationNs), 0), 0) AS p50,
          ifNull(ifNotFinite(quantile(0.9)(tool_calls_current.durationNs), 0), 0) AS p90,
          ifNull(ifNotFinite(quantile(0.95)(tool_calls_current.durationNs), 0), 0) AS p95,
          if(count() = 0, '', toString(min(tool_calls_current.ts))) AS firstSeen,
          if(count() = 0, '', toString(max(tool_calls_current.ts))) AS lastSeen
        FROM (SELECT
          ai_trace_index.Timestamp AS ts,
          ai_trace_index.TraceId AS traceId,
          ai_trace_index.SpanId AS spanId,
          if(trace.rawSessionId = '', concat('trace:', ai_trace_index.TraceId), trace.rawSessionId) AS sessionKey,
          ai_trace_index.ToolName AS toolName,
          trace.traceModel AS modelName,
          trace.traceVendorId AS vendor,
          trace.traceAgentName AS agent,
          ai_trace_index.IsError AS isError,
          ai_trace_index.ServiceName AS service,
          ai_trace_index.ErrorType AS errorType,
          coalesce(nullIf(ai_trace_index.FailedToolCallResult, ''), ai_trace_index.StatusMessage) AS failureMessage,
          toString(ai_trace_index.ErrorFingerprint) AS fingerprint,
          ai_trace_index.Duration AS durationNs
        FROM ai_trace_index
        INNER JOIN (SELECT
          ai_trace_index.TraceId AS TraceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS traceModel,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS traceVendorId,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS traceAgentName
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY TraceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS trace ON ai_trace_index.TraceId = trace.TraceId
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
          AND ai_trace_index.IsToolCall = 1
          AND ai_trace_index.ToolName = 'search_traces') AS tool_calls_current
FORMAT JSON

-- builder:ai-tools:aiToolsTotalsQuery:default
SELECT
          'current' AS period,
          count() AS calls,
          uniqExact(tool_calls_current.sessionKey) AS sessions,
          sum(tool_calls_current.isError) AS errors,
          ifNull(ifNotFinite(quantile(0.5)(tool_calls_current.durationNs), 0), 0) AS p50,
          ifNull(ifNotFinite(quantile(0.9)(tool_calls_current.durationNs), 0), 0) AS p90,
          ifNull(ifNotFinite(quantile(0.95)(tool_calls_current.durationNs), 0), 0) AS p95,
          if(count() = 0, '', toString(min(tool_calls_current.ts))) AS firstSeen,
          if(count() = 0, '', toString(max(tool_calls_current.ts))) AS lastSeen
        FROM (SELECT
          ai_trace_index.Timestamp AS ts,
          ai_trace_index.TraceId AS traceId,
          ai_trace_index.SpanId AS spanId,
          if(trace.rawSessionId = '', concat('trace:', ai_trace_index.TraceId), trace.rawSessionId) AS sessionKey,
          ai_trace_index.ToolName AS toolName,
          if(ifNull(parent.parentModel, '') != '', ifNull(parent.parentModel, ''), trace.traceModel) AS modelName,
          trace.traceVendorId AS vendor,
          trace.traceAgentName AS agent,
          ai_trace_index.IsError AS isError,
          ai_trace_index.ServiceName AS service,
          ai_trace_index.ErrorType AS errorType,
          coalesce(nullIf(ai_trace_index.FailedToolCallResult, ''), ai_trace_index.StatusMessage) AS failureMessage,
          toString(ai_trace_index.ErrorFingerprint) AS fingerprint,
          ai_trace_index.Duration AS durationNs
        FROM ai_trace_index
        LEFT JOIN (SELECT
          ai_trace_index.TraceId AS TraceId,
          ai_trace_index.SpanId AS SpanId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS parentModel
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
          AND ai_trace_index.Model != ''
        GROUP BY TraceId, SpanId) AS parent ON (ai_trace_index.TraceId = parent.TraceId AND ai_trace_index.ParentSpanId = parent.SpanId)
        INNER JOIN (SELECT
          ai_trace_index.TraceId AS TraceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS traceModel,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS traceVendorId,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS traceAgentName
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY TraceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS trace ON ai_trace_index.TraceId = trace.TraceId
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
          AND ai_trace_index.IsToolCall = 1
          AND ai_trace_index.ToolName = 'search_traces'
          AND if(ifNull(parent.parentModel, '') != '', ifNull(parent.parentModel, ''), trace.traceModel) = 'claude-sonnet-5'
          AND ai_trace_index.ToolName ILIKE '%search\\_%'
          AND ai_trace_index.IsError = 1) AS tool_calls_current
UNION ALL
SELECT
          'previous' AS period,
          count() AS calls,
          uniqExact(tool_calls_previous.sessionKey) AS sessions,
          sum(tool_calls_previous.isError) AS errors,
          ifNull(ifNotFinite(quantile(0.5)(tool_calls_previous.durationNs), 0), 0) AS p50,
          ifNull(ifNotFinite(quantile(0.9)(tool_calls_previous.durationNs), 0), 0) AS p90,
          ifNull(ifNotFinite(quantile(0.95)(tool_calls_previous.durationNs), 0), 0) AS p95,
          if(count() = 0, '', toString(min(tool_calls_previous.ts))) AS firstSeen,
          if(count() = 0, '', toString(max(tool_calls_previous.ts))) AS lastSeen
        FROM (SELECT
          ai_trace_index.Timestamp AS ts,
          ai_trace_index.TraceId AS traceId,
          ai_trace_index.SpanId AS spanId,
          if(trace.rawSessionId = '', concat('trace:', ai_trace_index.TraceId), trace.rawSessionId) AS sessionKey,
          ai_trace_index.ToolName AS toolName,
          if(ifNull(parent.parentModel, '') != '', ifNull(parent.parentModel, ''), trace.traceModel) AS modelName,
          trace.traceVendorId AS vendor,
          trace.traceAgentName AS agent,
          ai_trace_index.IsError AS isError,
          ai_trace_index.ServiceName AS service,
          ai_trace_index.ErrorType AS errorType,
          coalesce(nullIf(ai_trace_index.FailedToolCallResult, ''), ai_trace_index.StatusMessage) AS failureMessage,
          toString(ai_trace_index.ErrorFingerprint) AS fingerprint,
          ai_trace_index.Duration AS durationNs
        FROM ai_trace_index
        LEFT JOIN (SELECT
          ai_trace_index.TraceId AS TraceId,
          ai_trace_index.SpanId AS SpanId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS parentModel
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2025-12-30 06:45:00'
          AND ai_trace_index.Timestamp <= '2026-01-01 10:30:00'
          AND ai_trace_index.Model != ''
        GROUP BY TraceId, SpanId) AS parent ON (ai_trace_index.TraceId = parent.TraceId AND ai_trace_index.ParentSpanId = parent.SpanId)
        INNER JOIN (SELECT
          ai_trace_index.TraceId AS TraceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS traceModel,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS traceVendorId,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS traceAgentName
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2025-12-30 06:45:00'
          AND ai_trace_index.Timestamp <= '2026-01-01 10:30:00'
        GROUP BY TraceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS trace ON ai_trace_index.TraceId = trace.TraceId
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2025-12-30 06:45:00'
          AND ai_trace_index.Timestamp <= '2026-01-01 10:30:00'
          AND ai_trace_index.IsToolCall = 1
          AND ai_trace_index.ToolName = 'search_traces'
          AND if(ifNull(parent.parentModel, '') != '', ifNull(parent.parentModel, ''), trace.traceModel) = 'claude-sonnet-5'
          AND ai_trace_index.ToolName ILIKE '%search\\_%'
          AND ai_trace_index.IsError = 1) AS tool_calls_previous
UNION ALL
SELECT
          'window' AS period,
          0 AS calls,
          uniqExact(if(window_traces.rawSessionId = '', concat('trace:', window_traces.TraceId), window_traces.rawSessionId)) AS sessions,
          0 AS errors,
          0 AS p50,
          0 AS p90,
          0 AS p95,
          '' AS firstSeen,
          '' AS lastSeen
        FROM (SELECT
          ai_trace_index.TraceId AS TraceId,
          max(ai_trace_index.SessionId) AS rawSessionId,
          anyIf(ai_trace_index.Model, ai_trace_index.Model != '') AS traceModel,
          argMin(ai_trace_index.VendorId, tuple(if(ai_trace_index.SessionId != '', 0, 1), ai_trace_index.Timestamp)) AS traceVendorId,
          argMin(ai_trace_index.AgentName, if(ai_trace_index.AgentName != '', ai_trace_index.Timestamp, toDateTime('2106-01-01 00:00:00'))) AS traceAgentName
        FROM ai_trace_index
        WHERE ai_trace_index.OrgId = 'org_sql_catalog'
          AND ai_trace_index.Timestamp >= '2026-01-01 10:30:00'
          AND ai_trace_index.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY TraceId
        HAVING countIf((((ai_trace_index.SessionId != '' OR ai_trace_index.IsLlmCall = 1) OR ai_trace_index.IsToolCall = 1) OR ai_trace_index.AgentName != '')) > 0) AS window_traces
FORMAT JSON

-- builder:billing-usage:dailyProductEventCountQuery:default
SELECT
          toStartOfInterval(product_events.Timestamp, INTERVAL 86400 SECOND) AS day,
          count() AS events
        FROM product_events
        WHERE product_events.OrgId = 'org_sql_catalog'
          AND product_events.Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND product_events.Timestamp <= toDateTime('2026-01-03 14:15:00')
          AND product_events.Kind != 'navigation'
        GROUP BY day
        ORDER BY day ASC
        FORMAT JSON

-- builder:billing-usage:dailySessionCountQuery:default
SELECT
          toStartOfInterval(session_replays.StartTime, INTERVAL 86400 SECOND) AS day,
          uniqExact(session_replays.SessionId) AS sessions
        FROM session_replays
        WHERE session_replays.OrgId = 'org_sql_catalog'
          AND session_replays.StartTime >= toDateTime('2026-01-01 10:30:00')
          AND session_replays.StartTime <= toDateTime('2026-01-03 14:15:00')
        GROUP BY day
        ORDER BY day ASC
        FORMAT JSON

-- builder:billing-usage:dailySignalVolumeQuery:default
SELECT
          toStartOfInterval(service_usage.Hour, INTERVAL 86400 SECOND) AS day,
          sum(service_usage.LogSizeBytes) AS logBytes,
          sum(service_usage.TraceSizeBytes) AS traceBytes,
          sum(service_usage.SumMetricSizeBytes) + sum(service_usage.GaugeMetricSizeBytes) + sum(service_usage.HistogramMetricSizeBytes) + sum(service_usage.ExpHistogramMetricSizeBytes) AS metricBytes
        FROM service_usage
        WHERE service_usage.OrgId = 'org_sql_catalog'
          AND service_usage.Hour >= toStartOfHour(toDateTime('2026-01-01 10:30:00'))
          AND service_usage.Hour <= toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY day
        ORDER BY day ASC
        FORMAT JSON

-- builder:cloudflare-infra-breakdowns:cloudflareZoneBreakdownCoverageSQL:default
SELECT
          formatDateTime(min(metrics_sum.TimeUnix), '%Y-%m-%dT%H:%i:%S.%fZ') AS coverageStart,
          sum(metrics_sum.Value) AS attributedRequests
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.ServiceName = 'cloudflare-zone-example-com'
          AND metrics_sum.MetricName = 'cloudflare.http.requests.by_path'
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
        FORMAT JSON

-- builder:cloudflare-infra-breakdowns:cloudflareZoneBreakdownTimeseriesSQL:default
SELECT
          formatDateTime(toStartOfInterval(metrics_sum.TimeUnix, INTERVAL 300 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          if(metrics_sum.Attributes['url.path'] IN ('/api/v2/traces'), metrics_sum.Attributes['url.path'], 'other') AS key,
          sum(metrics_sum.Value) AS requests
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.ServiceName = 'cloudflare-zone-example-com'
          AND metrics_sum.MetricName = 'cloudflare.http.requests.by_path'
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY bucket, key
        ORDER BY bucket ASC, key ASC
        FORMAT JSON

-- builder:cloudflare-infra-breakdowns:cloudflareZoneBreakdownTotalsSQL:default
SELECT
          metrics_sum.Attributes['url.path'] AS key,
          sumIf(metrics_sum.Value, metrics_sum.MetricName = 'cloudflare.http.requests.by_path') AS requests,
          sumIf(metrics_sum.Value, metrics_sum.MetricName = 'cloudflare.http.errors.by_path') AS errors5xx,
          sumIf(metrics_sum.Value, metrics_sum.MetricName = 'cloudflare.http.bytes.by_path') AS bytes
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.ServiceName = 'cloudflare-zone-example-com'
          AND metrics_sum.MetricName IN ('cloudflare.http.requests.by_path', 'cloudflare.http.errors.by_path', 'cloudflare.http.bytes.by_path')
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY key
        ORDER BY requests DESC
        LIMIT 100
        FORMAT JSON

-- builder:cloudflare-infra-breakdowns:cloudflareZoneFacetsQuery:default
SELECT
          if(metrics_sum.Attributes['server.address'] != '', metrics_sum.Attributes['server.address'], metrics_sum.Attributes['http.host']) AS name,
          sum(metrics_sum.Value) AS count,
          'host' AS facetType
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.ServiceName = 'cloudflare-zone-example-com'
          AND metrics_sum.MetricName = 'cloudflare.http.requests'
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
          AND if(metrics_sum.Attributes['server.address'] != '', metrics_sum.Attributes['server.address'], metrics_sum.Attributes['http.host']) != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          metrics_sum.Attributes['cache.status'] AS name,
          sum(metrics_sum.Value) AS count,
          'cacheStatus' AS facetType
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.ServiceName = 'cloudflare-zone-example-com'
          AND metrics_sum.MetricName = 'cloudflare.http.requests'
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_sum.Attributes['cache.status'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          metrics_sum.Attributes['http.status_class'] AS name,
          sum(metrics_sum.Value) AS count,
          'statusClass' AS facetType
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.ServiceName = 'cloudflare-zone-example-com'
          AND metrics_sum.MetricName = 'cloudflare.http.requests'
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_sum.Attributes['http.status_class'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
UNION ALL
SELECT
          metrics_sum.Attributes['url.path'] AS name,
          sum(metrics_sum.Value) AS count,
          'path' AS facetType
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.ServiceName = 'cloudflare-zone-example-com'
          AND metrics_sum.MetricName = 'cloudflare.http.requests.by_path'
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_sum.Attributes['url.path'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 200
UNION ALL
SELECT
          metrics_sum.Attributes['geo.country_iso_code'] AS name,
          sum(metrics_sum.Value) AS count,
          'country' AS facetType
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.ServiceName = 'cloudflare-zone-example-com'
          AND metrics_sum.MetricName = 'cloudflare.http.requests.by_country'
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_sum.Attributes['geo.country_iso_code'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          metrics_sum.Attributes['http.request.method'] AS name,
          sum(metrics_sum.Value) AS count,
          'method' AS facetType
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.ServiceName = 'cloudflare-zone-example-com'
          AND metrics_sum.MetricName = 'cloudflare.http.requests.by_client'
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_sum.Attributes['http.request.method'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          metrics_sum.Attributes['network.protocol.version'] AS name,
          sum(metrics_sum.Value) AS count,
          'protocol' AS facetType
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.ServiceName = 'cloudflare-zone-example-com'
          AND metrics_sum.MetricName = 'cloudflare.http.requests.by_client'
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_sum.Attributes['network.protocol.version'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
UNION ALL
SELECT
          metrics_sum.Attributes['cloudflare.device.type'] AS name,
          sum(metrics_sum.Value) AS count,
          'deviceType' AS facetType
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.ServiceName = 'cloudflare-zone-example-com'
          AND metrics_sum.MetricName = 'cloudflare.http.requests.by_client'
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
          AND metrics_sum.Attributes['cloudflare.device.type'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
FORMAT JSON

-- builder:cloudflare-infra-extended:cloudflareDurableObjectCountersSQL:default
SELECT
          metrics_sum.ServiceName AS serviceName,
          sumIf(metrics_sum.Value, metrics_sum.MetricName = 'cloudflare.durable_object.requests') AS requests,
          sumIf(metrics_sum.Value, metrics_sum.MetricName = 'cloudflare.durable_object.errors') AS errors
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.MetricName IN ('cloudflare.durable_object.requests', 'cloudflare.durable_object.errors')
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY serviceName
        ORDER BY requests DESC
        LIMIT 500
        FORMAT JSON

-- builder:cloudflare-infra-extended:cloudflareQueueGaugesSQL:default
SELECT
          metrics_gauge.ServiceName AS serviceName,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, metrics_gauge.MetricName = 'cloudflare.queue.backlog.messages'), 0), 0) AS backlogMessages,
          maxIf(metrics_gauge.Value, metrics_gauge.MetricName = 'cloudflare.queue.backlog.messages') AS backlogMessagesMax,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, metrics_gauge.MetricName = 'cloudflare.queue.backlog.bytes'), 0), 0) AS backlogBytes,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, metrics_gauge.MetricName = 'cloudflare.queue.consumer.concurrency'), 0), 0) AS consumerConcurrency
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.MetricName IN ('cloudflare.queue.backlog.messages', 'cloudflare.queue.backlog.bytes', 'cloudflare.queue.consumer.concurrency')
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY serviceName
        ORDER BY backlogMessagesMax DESC
        LIMIT 500
        FORMAT JSON

-- builder:cloudflare-infra-extended:cloudflareZoneDnsBreakdownSQL:default
SELECT
          metrics_sum.Attributes['dns.query_name'] AS queryName,
          sum(metrics_sum.Value) AS queries,
          sumIf(metrics_sum.Value, metrics_sum.Attributes['dns.response_code'] = 'NXDOMAIN') AS nxdomain
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.ServiceName = 'cloudflare-zone-example-com'
          AND metrics_sum.MetricName = 'cloudflare.dns.queries'
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY queryName
        ORDER BY queries DESC
        LIMIT 25
        FORMAT JSON

-- builder:cloudflare-infra-extended:cloudflareZoneDnsTimeseriesSQL:default
SELECT
          formatDateTime(toStartOfInterval(metrics_sum.TimeUnix, INTERVAL 300 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          metrics_sum.Attributes['dns.response_code'] AS responseCode,
          sum(metrics_sum.Value) AS queries
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.ServiceName = 'cloudflare-zone-example-com'
          AND metrics_sum.MetricName = 'cloudflare.dns.queries'
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY bucket, responseCode
        ORDER BY bucket ASC, responseCode ASC
        FORMAT JSON

-- builder:cloudflare-infra-extended:cloudflareZoneFirewallTimeseriesSQL:default
SELECT
          formatDateTime(toStartOfInterval(metrics_sum.TimeUnix, INTERVAL 300 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          metrics_sum.Attributes['firewall.action'] AS action,
          sum(metrics_sum.Value) AS events
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.ServiceName = 'cloudflare-zone-example-com'
          AND metrics_sum.MetricName = 'cloudflare.firewall.events'
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY bucket, action
        ORDER BY bucket ASC, action ASC
        FORMAT JSON

-- builder:cloudflare-infra-extended:cloudflareZoneFirewallTopSQL:default
SELECT
          metrics_sum.Attributes['firewall.source'] AS source,
          metrics_sum.Attributes['firewall.action'] AS action,
          metrics_sum.Attributes['firewall.rule_id'] AS ruleId,
          if(metrics_sum.Attributes['server.address'] != '', metrics_sum.Attributes['server.address'], metrics_sum.Attributes['http.host']) AS host,
          sum(metrics_sum.Value) AS events
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.ServiceName = 'cloudflare-zone-example-com'
          AND metrics_sum.MetricName = 'cloudflare.firewall.events'
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY source, action, ruleId, host
        ORDER BY events DESC
        LIMIT 25
        FORMAT JSON

-- builder:cloudflare-infra:cloudflareWorkerCountersSQL:default
SELECT
          metrics_sum.ServiceName AS serviceName,
          sumIf(metrics_sum.Value, metrics_sum.MetricName = 'cloudflare.worker.requests') AS requests,
          sumIf(metrics_sum.Value, metrics_sum.MetricName = 'cloudflare.worker.errors') AS errors,
          sumIf(metrics_sum.Value, metrics_sum.MetricName = 'cloudflare.worker.subrequests') AS subrequests
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.MetricName IN ('cloudflare.worker.requests', 'cloudflare.worker.errors', 'cloudflare.worker.subrequests')
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY serviceName
        ORDER BY requests DESC
        LIMIT 500
        FORMAT JSON

-- builder:cloudflare-infra:cloudflareWorkerLatencySQL:default
SELECT
          metrics_gauge.ServiceName AS serviceName,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, (metrics_gauge.MetricName = 'cloudflare.worker.cpu_time' AND metrics_gauge.Attributes['quantile'] = '0.5')), 0), 0) AS cpuP50Ms,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, (metrics_gauge.MetricName = 'cloudflare.worker.cpu_time' AND metrics_gauge.Attributes['quantile'] = '0.99')), 0), 0) AS cpuP99Ms,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, (metrics_gauge.MetricName = 'cloudflare.worker.duration' AND metrics_gauge.Attributes['quantile'] = '0.5')), 0), 0) AS durationP50Ms,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, (metrics_gauge.MetricName = 'cloudflare.worker.duration' AND metrics_gauge.Attributes['quantile'] = '0.99')), 0), 0) AS durationP99Ms
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.MetricName IN ('cloudflare.worker.duration', 'cloudflare.worker.cpu_time')
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY serviceName
        LIMIT 500
        FORMAT JSON

-- builder:cloudflare-infra:cloudflareZoneCacheTimeseriesSQL:default
SELECT
          formatDateTime(toStartOfInterval(metrics_sum.TimeUnix, INTERVAL 300 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          metrics_sum.Attributes['cache.status'] AS cacheStatus,
          sum(metrics_sum.Value) AS requests
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.ServiceName = 'cloudflare-zone-example-com'
          AND metrics_sum.MetricName = 'cloudflare.http.requests'
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY bucket, cacheStatus
        ORDER BY bucket ASC, cacheStatus ASC
        FORMAT JSON

-- builder:cloudflare-infra:cloudflareZoneCountersSQL:default
SELECT
          metrics_sum.ServiceName AS serviceName,
          sumIf(metrics_sum.Value, metrics_sum.MetricName = 'cloudflare.http.requests') AS requests,
          sumIf(metrics_sum.Value, (metrics_sum.MetricName = 'cloudflare.http.requests' AND metrics_sum.Attributes['http.status_class'] = '5xx')) AS errors5xx,
          sumIf(metrics_sum.Value, (metrics_sum.MetricName = 'cloudflare.http.requests' AND metrics_sum.Attributes['cache.status'] IN ('hit', 'stale', 'revalidated', 'updating'))) AS cacheHits,
          sumIf(metrics_sum.Value, metrics_sum.MetricName = 'cloudflare.http.bytes') AS bytes,
          sumIf(metrics_sum.Value, metrics_sum.MetricName = 'cloudflare.http.visits') AS visits
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.MetricName IN ('cloudflare.http.requests', 'cloudflare.http.bytes', 'cloudflare.http.visits')
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY serviceName
        ORDER BY requests DESC
        LIMIT 500
        FORMAT JSON

-- builder:cloudflare-infra:cloudflareZoneCountersSQL:filtered
SELECT
          metrics_sum.ServiceName AS serviceName,
          sumIf(metrics_sum.Value, metrics_sum.MetricName = 'cloudflare.http.requests') AS requests,
          sumIf(metrics_sum.Value, (metrics_sum.MetricName = 'cloudflare.http.requests' AND metrics_sum.Attributes['http.status_class'] = '5xx')) AS errors5xx,
          sumIf(metrics_sum.Value, (metrics_sum.MetricName = 'cloudflare.http.requests' AND metrics_sum.Attributes['cache.status'] IN ('hit', 'stale', 'revalidated', 'updating'))) AS cacheHits,
          sumIf(metrics_sum.Value, metrics_sum.MetricName = 'cloudflare.http.bytes') AS bytes,
          sumIf(metrics_sum.Value, metrics_sum.MetricName = 'cloudflare.http.visits') AS visits
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.MetricName IN ('cloudflare.http.requests', 'cloudflare.http.bytes', 'cloudflare.http.visits')
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
          AND if(metrics_sum.Attributes['server.address'] != '', metrics_sum.Attributes['server.address'], metrics_sum.Attributes['http.host']) IN ('example.com')
          AND metrics_sum.Attributes['http.status_class'] IN ('5xx')
        GROUP BY serviceName
        ORDER BY requests DESC
        LIMIT 500
        FORMAT JSON

-- builder:cloudflare-infra:cloudflareZoneLatencySQL:default
SELECT
          metrics_gauge.ServiceName AS serviceName,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, (metrics_gauge.MetricName = 'cloudflare.http.edge.ttfb' AND metrics_gauge.Attributes['quantile'] = '0.5')), 0), 0) AS ttfbP50Ms,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, (metrics_gauge.MetricName = 'cloudflare.http.edge.ttfb' AND metrics_gauge.Attributes['quantile'] = '0.95')), 0), 0) AS ttfbP95Ms,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, (metrics_gauge.MetricName = 'cloudflare.http.edge.ttfb' AND metrics_gauge.Attributes['quantile'] = '0.99')), 0), 0) AS ttfbP99Ms,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, (metrics_gauge.MetricName = 'cloudflare.http.origin.duration' AND metrics_gauge.Attributes['quantile'] = '0.5')), 0), 0) AS originP50Ms,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, (metrics_gauge.MetricName = 'cloudflare.http.origin.duration' AND metrics_gauge.Attributes['quantile'] = '0.95')), 0), 0) AS originP95Ms,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, (metrics_gauge.MetricName = 'cloudflare.http.origin.duration' AND metrics_gauge.Attributes['quantile'] = '0.99')), 0), 0) AS originP99Ms
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.MetricName IN ('cloudflare.http.edge.ttfb', 'cloudflare.http.origin.duration')
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY serviceName
        LIMIT 500
        FORMAT JSON

-- builder:cloudflare-infra:cloudflareZoneLatencyTimeseriesSQL:default
SELECT
          formatDateTime(toStartOfInterval(metrics_gauge.TimeUnix, INTERVAL 300 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, (metrics_gauge.MetricName = 'cloudflare.http.edge.ttfb' AND metrics_gauge.Attributes['quantile'] = '0.5')), 0), 0) AS ttfbP50Ms,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, (metrics_gauge.MetricName = 'cloudflare.http.edge.ttfb' AND metrics_gauge.Attributes['quantile'] = '0.95')), 0), 0) AS ttfbP95Ms,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, (metrics_gauge.MetricName = 'cloudflare.http.edge.ttfb' AND metrics_gauge.Attributes['quantile'] = '0.99')), 0), 0) AS ttfbP99Ms,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, (metrics_gauge.MetricName = 'cloudflare.http.origin.duration' AND metrics_gauge.Attributes['quantile'] = '0.5')), 0), 0) AS originP50Ms,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, (metrics_gauge.MetricName = 'cloudflare.http.origin.duration' AND metrics_gauge.Attributes['quantile'] = '0.95')), 0), 0) AS originP95Ms,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, (metrics_gauge.MetricName = 'cloudflare.http.origin.duration' AND metrics_gauge.Attributes['quantile'] = '0.99')), 0), 0) AS originP99Ms
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.ServiceName = 'cloudflare-zone-example-com'
          AND metrics_gauge.MetricName IN ('cloudflare.http.edge.ttfb', 'cloudflare.http.origin.duration')
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:cloudflare-infra:cloudflareZoneStatusTimeseriesSQL:default
SELECT
          formatDateTime(toStartOfInterval(metrics_sum.TimeUnix, INTERVAL 300 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          metrics_sum.Attributes['http.status_class'] AS statusClass,
          sum(metrics_sum.Value) AS requests
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.ServiceName = 'cloudflare-zone-example-com'
          AND metrics_sum.MetricName = 'cloudflare.http.requests'
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY bucket, statusClass
        ORDER BY bucket ASC, statusClass ASC
        FORMAT JSON

-- builder:cloudflare-infra:cloudflareZoneStatusTimeseriesSQL:filtered
SELECT
          formatDateTime(toStartOfInterval(metrics_sum.TimeUnix, INTERVAL 300 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          metrics_sum.Attributes['http.status_class'] AS statusClass,
          sum(metrics_sum.Value) AS requests
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.ServiceName = 'cloudflare-zone-example-com'
          AND metrics_sum.MetricName = 'cloudflare.http.requests'
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
          AND if(metrics_sum.Attributes['server.address'] != '', metrics_sum.Attributes['server.address'], metrics_sum.Attributes['http.host']) IN ('example.com')
          AND metrics_sum.Attributes['http.status_class'] IN ('5xx')
        GROUP BY bucket, statusClass
        ORDER BY bucket ASC, statusClass ASC
        FORMAT JSON

-- builder:cloudflare-infra:cloudflareZoneTimeseriesSQL:default
SELECT
          metrics_sum.ServiceName AS serviceName,
          formatDateTime(toStartOfInterval(metrics_sum.TimeUnix, INTERVAL 300 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          sumIf(metrics_sum.Value, metrics_sum.MetricName = 'cloudflare.http.requests') AS requests,
          sumIf(metrics_sum.Value, (metrics_sum.MetricName = 'cloudflare.http.requests' AND metrics_sum.Attributes['http.status_class'] = '5xx')) AS errors5xx,
          sumIf(metrics_sum.Value, (metrics_sum.MetricName = 'cloudflare.http.requests' AND metrics_sum.Attributes['cache.status'] IN ('hit', 'stale', 'revalidated', 'updating'))) AS cacheHits,
          sumIf(metrics_sum.Value, metrics_sum.MetricName = 'cloudflare.http.bytes') AS bytes,
          sumIf(metrics_sum.Value, metrics_sum.MetricName = 'cloudflare.http.visits') AS visits
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.MetricName IN ('cloudflare.http.requests', 'cloudflare.http.bytes', 'cloudflare.http.visits')
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY serviceName, bucket
        ORDER BY serviceName ASC, bucket ASC
        FORMAT JSON

-- builder:cloudflare-infra:cloudflareZoneTimeseriesSQL:filtered
SELECT
          metrics_sum.ServiceName AS serviceName,
          formatDateTime(toStartOfInterval(metrics_sum.TimeUnix, INTERVAL 300 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          sumIf(metrics_sum.Value, metrics_sum.MetricName = 'cloudflare.http.requests') AS requests,
          sumIf(metrics_sum.Value, (metrics_sum.MetricName = 'cloudflare.http.requests' AND metrics_sum.Attributes['http.status_class'] = '5xx')) AS errors5xx,
          sumIf(metrics_sum.Value, (metrics_sum.MetricName = 'cloudflare.http.requests' AND metrics_sum.Attributes['cache.status'] IN ('hit', 'stale', 'revalidated', 'updating'))) AS cacheHits,
          sumIf(metrics_sum.Value, metrics_sum.MetricName = 'cloudflare.http.bytes') AS bytes,
          sumIf(metrics_sum.Value, metrics_sum.MetricName = 'cloudflare.http.visits') AS visits
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.MetricName IN ('cloudflare.http.requests', 'cloudflare.http.bytes', 'cloudflare.http.visits')
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
          AND if(metrics_sum.Attributes['server.address'] != '', metrics_sum.Attributes['server.address'], metrics_sum.Attributes['http.host']) IN ('example.com')
          AND metrics_sum.Attributes['http.status_class'] IN ('5xx')
        GROUP BY serviceName, bucket
        ORDER BY serviceName ASC, bucket ASC
        FORMAT JSON

-- builder:cloudflare-map:cloudflareServiceCountersSQL:default
SELECT
          metrics_sum.ServiceName AS serviceName,
          sumIf(metrics_sum.Value, metrics_sum.MetricName = 'cloudflare.worker.requests') AS requests,
          sumIf(metrics_sum.Value, metrics_sum.MetricName = 'cloudflare.worker.errors') AS errorCount
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.MetricName IN ('cloudflare.worker.requests', 'cloudflare.worker.errors')
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY serviceName
        ORDER BY requests DESC
        LIMIT 500
        FORMAT JSON

-- builder:cloudflare-map:cloudflareServiceLatencySQL:default
SELECT
          metrics_gauge.ServiceName AS serviceName,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, (metrics_gauge.MetricName = 'cloudflare.worker.duration' AND metrics_gauge.Attributes['quantile'] = '0.99')), 0), 0) AS latencyP99Ms,
          ifNull(ifNotFinite(avgIf(metrics_gauge.Value, (metrics_gauge.MetricName = 'cloudflare.worker.cpu_time' AND metrics_gauge.Attributes['quantile'] = '0.99')), 0), 0) AS cpuP99Ms
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.MetricName IN ('cloudflare.worker.duration', 'cloudflare.worker.cpu_time')
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY serviceName
        LIMIT 500
        FORMAT JSON

-- builder:cloudflare-usage:cloudflareUsageQuery:default
SELECT
          metrics_sum.ServiceName AS serviceName,
          formatDateTime(toStartOfInterval(metrics_sum.TimeUnix, INTERVAL 3600 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          sum(metrics_sum.Value) AS requests,
          count() AS datapoints,
          formatDateTime(max(metrics_sum.TimeUnix), '%Y-%m-%dT%H:%i:%S.%fZ') AS lastTimeUnix
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.MetricName IN ('cloudflare.http.requests', 'cloudflare.worker.requests')
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY serviceName, bucket
        ORDER BY serviceName ASC, bucket ASC
        FORMAT JSON

-- builder:cloudflare-usage:cloudflareUsageStatsQuery:default
SELECT
          sumIf(metrics_sum.Value, (metrics_sum.MetricName IN ('cloudflare.http.requests', 'cloudflare.worker.requests') AND metrics_sum.TimeUnix < '2026-01-02 10:30:00')) AS previousRequests,
          sumIf(metrics_sum.Value, ((metrics_sum.MetricName = 'cloudflare.firewall.events' AND metrics_sum.Attributes['firewall.action'] IN ('block', 'challenge', 'jschallenge', 'managed_challenge')) AND metrics_sum.TimeUnix >= '2026-01-02 10:30:00')) AS firewallBlockedEvents
        FROM metrics_sum
        WHERE metrics_sum.OrgId = 'org_sql_catalog'
          AND metrics_sum.MetricName IN ('cloudflare.http.requests', 'cloudflare.worker.requests', 'cloudflare.firewall.events')
          AND metrics_sum.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_sum.TimeUnix <= '2026-01-03 14:15:00'
        FORMAT JSON

-- builder:internal:dbStatementSamplesQuery:default
SELECT
          coalesce(nullIf(traces.SpanAttributes['db.query.fingerprint'], ''), traces.SpanAttributes['db.statement.fingerprint']) AS fingerprint,
          any(traces.SpanAttributes['query.context']) AS context,
          any(traces.SpanAttributes['query.profile']) AS profile,
          any(coalesce(nullIf(traces.SpanAttributes['db.query.text'], ''), traces.SpanAttributes['db.statement'])) AS sampleSql,
          count() AS sampleCount,
          ifNull(ifNotFinite(quantile(0.5)(traces.Duration) / 1000000, 0), 0) AS p50DurationMs,
          ifNull(ifNotFinite(quantile(0.95)(traces.Duration) / 1000000, 0), 0) AS p95DurationMs,
          ifNull(ifNotFinite(quantile(0.99)(traces.Duration) / 1000000, 0), 0) AS p99DurationMs,
          max(traces.Duration) / 1000000 AS maxDurationMs
        FROM traces
        WHERE traces.OrgId = 'org_sql_catalog'
          AND traces.SpanName = 'WarehouseQueryService.executeSql'
          AND traces.Timestamp >= '2026-01-01 10:30:00'
          AND traces.Timestamp <= '2026-01-03 14:15:00'
          AND coalesce(nullIf(traces.SpanAttributes['db.query.fingerprint'], ''), traces.SpanAttributes['db.statement.fingerprint']) != ''
        GROUP BY fingerprint
        ORDER BY p95DurationMs DESC
        LIMIT 25
        FORMAT JSON

-- builder:planetscale-infra:planetscaleBranchInfraTimeseriesSQL:default
SELECT
          toStartOfInterval(points.t, INTERVAL 300 SECOND) AS bucket,
          ifNull(ifNotFinite(avg(points.totalConnections), 0), 0) AS connectionsAvg,
          max(points.cpuMax) AS cpuMaxPercent,
          max(points.memMax) AS memMaxPercent,
          max(points.lagMax) AS replicaLagMaxSeconds,
          maxIf(100 - points.availableBytes / points.capacityBytes * 100, (points.availableSamples > 0 AND points.capacityBytes > 0)) AS storageUsedPercent,
          sum(points.availableSamples) AS storageSamples
        FROM (SELECT
          metrics_gauge.TimeUnix AS t,
          sumIf(metrics_gauge.Value, metrics_gauge.MetricName IN ('planetscale_edge_active_connections', 'planetscale_edge_postgres_active_connections')) AS totalConnections,
          maxIf(metrics_gauge.Value, metrics_gauge.MetricName IN ('planetscale_pods_cpu_util_percentages')) AS cpuMax,
          maxIf(metrics_gauge.Value, metrics_gauge.MetricName IN ('planetscale_pods_mem_util_percentages')) AS memMax,
          maxIf(metrics_gauge.Value, metrics_gauge.MetricName IN ('planetscale_mysql_replica_lag_seconds', 'planetscale_vttablet_replication_lag', 'planetscale_postgres_replica_lag_seconds')) AS lagMax,
          maxIf(metrics_gauge.Value, metrics_gauge.MetricName IN ('planetscale_volume_capacity_bytes')) AS capacityBytes,
          minIf(metrics_gauge.Value, metrics_gauge.MetricName IN ('planetscale_volume_available_bytes')) AS availableBytes,
          countIf(metrics_gauge.MetricName IN ('planetscale_volume_available_bytes')) AS availableSamples
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.MetricName IN ('planetscale_edge_active_connections', 'planetscale_edge_postgres_active_connections', 'planetscale_pods_cpu_util_percentages', 'planetscale_pods_mem_util_percentages', 'planetscale_mysql_replica_lag_seconds', 'planetscale_vttablet_replication_lag', 'planetscale_postgres_replica_lag_seconds', 'planetscale_volume_capacity_bytes', 'planetscale_volume_available_bytes')
          AND coalesce(nullIf(metrics_gauge.Attributes['planetscale_database_name'], ''), metrics_gauge.Attributes['planetscale_database']) = 'maple-prd'
          AND coalesce(nullIf(metrics_gauge.Attributes['planetscale_branch_name'], ''), metrics_gauge.Attributes['planetscale_branch']) = 'main'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY t) AS points
        GROUP BY bucket
        ORDER BY bucket ASC
        LIMIT 2000
        FORMAT JSON

-- builder:planetscale-infra:planetscaleInfraTimeseriesSQL:default
SELECT
          toStartOfInterval(points.t, INTERVAL 300 SECOND) AS bucket,
          ifNull(ifNotFinite(avg(points.totalConnections), 0), 0) AS connectionsAvg,
          max(points.cpuMax) AS cpuMaxPercent,
          max(points.memMax) AS memMaxPercent,
          max(points.lagMax) AS replicaLagMaxSeconds,
          maxIf(100 - points.availableBytes / points.capacityBytes * 100, (points.availableSamples > 0 AND points.capacityBytes > 0)) AS storageUsedPercent,
          sum(points.availableSamples) AS storageSamples
        FROM (SELECT
          metrics_gauge.TimeUnix AS t,
          sumIf(metrics_gauge.Value, metrics_gauge.MetricName IN ('planetscale_edge_active_connections', 'planetscale_edge_postgres_active_connections')) AS totalConnections,
          maxIf(metrics_gauge.Value, metrics_gauge.MetricName IN ('planetscale_pods_cpu_util_percentages')) AS cpuMax,
          maxIf(metrics_gauge.Value, metrics_gauge.MetricName IN ('planetscale_pods_mem_util_percentages')) AS memMax,
          maxIf(metrics_gauge.Value, metrics_gauge.MetricName IN ('planetscale_mysql_replica_lag_seconds', 'planetscale_vttablet_replication_lag', 'planetscale_postgres_replica_lag_seconds')) AS lagMax,
          maxIf(metrics_gauge.Value, metrics_gauge.MetricName IN ('planetscale_volume_capacity_bytes')) AS capacityBytes,
          minIf(metrics_gauge.Value, metrics_gauge.MetricName IN ('planetscale_volume_available_bytes')) AS availableBytes,
          countIf(metrics_gauge.MetricName IN ('planetscale_volume_available_bytes')) AS availableSamples
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.MetricName IN ('planetscale_edge_active_connections', 'planetscale_edge_postgres_active_connections', 'planetscale_pods_cpu_util_percentages', 'planetscale_pods_mem_util_percentages', 'planetscale_mysql_replica_lag_seconds', 'planetscale_vttablet_replication_lag', 'planetscale_postgres_replica_lag_seconds', 'planetscale_volume_capacity_bytes', 'planetscale_volume_available_bytes')
          AND coalesce(nullIf(metrics_gauge.Attributes['planetscale_database_name'], ''), metrics_gauge.Attributes['planetscale_database']) = 'maple-prd'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY t) AS points
        GROUP BY bucket
        ORDER BY bucket ASC
        LIMIT 2000
        FORMAT JSON

-- builder:planetscale-map:planetscaleBranchConnectionsSQL:default
SELECT
          conn.database AS database,
          conn.branch AS branch,
          ifNull(ifNotFinite(avg(conn.totalConnections), 0), 0) AS connectionsAvg,
          max(conn.totalConnections) AS connectionsMax
        FROM (SELECT
          coalesce(nullIf(metrics_gauge.Attributes['planetscale_database_name'], ''), metrics_gauge.Attributes['planetscale_database']) AS database,
          coalesce(nullIf(metrics_gauge.Attributes['planetscale_branch_name'], ''), metrics_gauge.Attributes['planetscale_branch']) AS branch,
          metrics_gauge.TimeUnix AS t,
          sum(metrics_gauge.Value) AS totalConnections
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.MetricName IN ('planetscale_edge_active_connections', 'planetscale_edge_postgres_active_connections')
          AND coalesce(nullIf(metrics_gauge.Attributes['planetscale_database_name'], ''), metrics_gauge.Attributes['planetscale_database']) = 'maple-prd'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY database, branch, t) AS conn
        GROUP BY database, branch
        LIMIT 500
        FORMAT JSON

-- builder:planetscale-map:planetscaleBranchGaugesSQL:default
SELECT
          coalesce(nullIf(metrics_gauge.Attributes['planetscale_database_name'], ''), metrics_gauge.Attributes['planetscale_database']) AS database,
          coalesce(nullIf(metrics_gauge.Attributes['planetscale_branch_name'], ''), metrics_gauge.Attributes['planetscale_branch']) AS branch,
          maxIf(metrics_gauge.Value, metrics_gauge.MetricName IN ('planetscale_pods_cpu_util_percentages')) AS cpuMaxPercent,
          maxIf(metrics_gauge.Value, metrics_gauge.MetricName IN ('planetscale_pods_mem_util_percentages')) AS memMaxPercent,
          maxIf(metrics_gauge.Value, metrics_gauge.MetricName IN ('planetscale_mysql_replica_lag_seconds', 'planetscale_vttablet_replication_lag', 'planetscale_postgres_replica_lag_seconds')) AS replicaLagMaxSeconds
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.MetricName IN ('planetscale_pods_cpu_util_percentages', 'planetscale_pods_mem_util_percentages', 'planetscale_mysql_replica_lag_seconds', 'planetscale_vttablet_replication_lag', 'planetscale_postgres_replica_lag_seconds')
          AND coalesce(nullIf(metrics_gauge.Attributes['planetscale_database_name'], ''), metrics_gauge.Attributes['planetscale_database']) = 'maple-prd'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY database, branch
        LIMIT 500
        FORMAT JSON

-- builder:planetscale-map:planetscaleBranchStorageSQL:default
SELECT
          vol.database AS database,
          vol.branch AS branch,
          if((vol.capacityBytes > 0 AND vol.samples > 0), 100 - vol.availableBytes / vol.capacityBytes * 100, 0) AS storageUsedPercent,
          vol.capacityBytes AS storageCapacityBytes,
          vol.availableBytes AS storageAvailableBytes,
          vol.samples AS storageSamples
        FROM (SELECT
          coalesce(nullIf(metrics_gauge.Attributes['planetscale_database_name'], ''), metrics_gauge.Attributes['planetscale_database']) AS database,
          coalesce(nullIf(metrics_gauge.Attributes['planetscale_branch_name'], ''), metrics_gauge.Attributes['planetscale_branch']) AS branch,
          maxIf(metrics_gauge.Value, metrics_gauge.MetricName IN ('planetscale_volume_capacity_bytes')) AS capacityBytes,
          minIf(metrics_gauge.Value, metrics_gauge.MetricName IN ('planetscale_volume_available_bytes')) AS availableBytes,
          countIf(metrics_gauge.MetricName IN ('planetscale_volume_available_bytes')) AS samples
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.MetricName IN ('planetscale_volume_capacity_bytes', 'planetscale_volume_available_bytes')
          AND coalesce(nullIf(metrics_gauge.Attributes['planetscale_database_name'], ''), metrics_gauge.Attributes['planetscale_database']) = 'maple-prd'
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY database, branch) AS vol
        LIMIT 500
        FORMAT JSON

-- builder:planetscale-map:planetscaleConnectionsSQL:default
SELECT
          conn.database AS database,
          ifNull(ifNotFinite(avg(conn.totalConnections), 0), 0) AS connectionsAvg,
          max(conn.totalConnections) AS connectionsMax
        FROM (SELECT
          coalesce(nullIf(metrics_gauge.Attributes['planetscale_database_name'], ''), metrics_gauge.Attributes['planetscale_database']) AS database,
          metrics_gauge.TimeUnix AS t,
          sum(metrics_gauge.Value) AS totalConnections
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.MetricName IN ('planetscale_edge_active_connections', 'planetscale_edge_postgres_active_connections')
          AND coalesce(nullIf(metrics_gauge.Attributes['planetscale_database_name'], ''), metrics_gauge.Attributes['planetscale_database']) != ''
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY database, t) AS conn
        GROUP BY database
        LIMIT 500
        FORMAT JSON

-- builder:planetscale-map:planetscaleGaugesSQL:default
SELECT
          coalesce(nullIf(metrics_gauge.Attributes['planetscale_database_name'], ''), metrics_gauge.Attributes['planetscale_database']) AS database,
          maxIf(metrics_gauge.Value, metrics_gauge.MetricName IN ('planetscale_pods_cpu_util_percentages')) AS cpuMaxPercent,
          maxIf(metrics_gauge.Value, metrics_gauge.MetricName IN ('planetscale_pods_mem_util_percentages')) AS memMaxPercent,
          maxIf(metrics_gauge.Value, metrics_gauge.MetricName IN ('planetscale_mysql_replica_lag_seconds', 'planetscale_vttablet_replication_lag', 'planetscale_postgres_replica_lag_seconds')) AS replicaLagMaxSeconds
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.MetricName IN ('planetscale_pods_cpu_util_percentages', 'planetscale_pods_mem_util_percentages', 'planetscale_mysql_replica_lag_seconds', 'planetscale_vttablet_replication_lag', 'planetscale_postgres_replica_lag_seconds')
          AND coalesce(nullIf(metrics_gauge.Attributes['planetscale_database_name'], ''), metrics_gauge.Attributes['planetscale_database']) != ''
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY database
        LIMIT 500
        FORMAT JSON

-- builder:planetscale-map:planetscaleStorageSQL:default
SELECT
          vol.database AS database,
          max(if((vol.capacityBytes > 0 AND vol.samples > 0), 100 - vol.availableBytes / vol.capacityBytes * 100, 0)) AS storageUsedPercent,
          sum(vol.samples) AS storageSamples
        FROM (SELECT
          coalesce(nullIf(metrics_gauge.Attributes['planetscale_database_name'], ''), metrics_gauge.Attributes['planetscale_database']) AS database,
          coalesce(nullIf(metrics_gauge.Attributes['planetscale_branch_name'], ''), metrics_gauge.Attributes['planetscale_branch']) AS branch,
          maxIf(metrics_gauge.Value, metrics_gauge.MetricName IN ('planetscale_volume_capacity_bytes')) AS capacityBytes,
          minIf(metrics_gauge.Value, metrics_gauge.MetricName IN ('planetscale_volume_available_bytes')) AS availableBytes,
          countIf(metrics_gauge.MetricName IN ('planetscale_volume_available_bytes')) AS samples
        FROM metrics_gauge
        WHERE metrics_gauge.OrgId = 'org_sql_catalog'
          AND metrics_gauge.MetricName IN ('planetscale_volume_capacity_bytes', 'planetscale_volume_available_bytes')
          AND coalesce(nullIf(metrics_gauge.Attributes['planetscale_database_name'], ''), metrics_gauge.Attributes['planetscale_database']) != ''
          AND metrics_gauge.TimeUnix >= '2026-01-01 10:30:00'
          AND metrics_gauge.TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY database, branch) AS vol
        GROUP BY database
        LIMIT 500
        FORMAT JSON

-- builder:setup-audit:auditAttributeKeyInventoryQuery:default
SELECT
          attribute_keys_hourly.AttributeScope AS scope,
          attribute_keys_hourly.AttributeKey AS attributeKey,
          sum(attribute_keys_hourly.UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE attribute_keys_hourly.OrgId = 'org_sql_catalog'
          AND attribute_keys_hourly.AttributeScope IN ('span', 'resource', 'log', 'metric')
          AND attribute_keys_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_keys_hourly.Hour <= '2026-01-03 14:15:00'
        GROUP BY scope, attributeKey
        ORDER BY usageCount DESC
        LIMIT 25
        FORMAT JSON

-- builder:setup-audit:auditDbEdgeIdentityQuery:default
SELECT
          service_map_db_edges_hourly.ServiceName AS serviceName,
          service_map_db_edges_hourly.DbSystem AS dbSystem,
          sum(service_map_db_edges_hourly.CallCount) AS callCount,
          sumIf(service_map_db_edges_hourly.CallCount, service_map_db_edges_hourly.DbNamespace = '') AS unknownNamespaceCallCount
        FROM service_map_db_edges_hourly
        WHERE service_map_db_edges_hourly.OrgId = 'org_sql_catalog'
          AND service_map_db_edges_hourly.Hour >= toStartOfHour(toDateTime('2026-01-01 10:30:00'))
          AND service_map_db_edges_hourly.Hour <= toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND service_map_db_edges_hourly.DbSystem != ''
        GROUP BY serviceName, dbSystem
        ORDER BY callCount DESC
        LIMIT 25
        FORMAT JSON

-- builder:setup-audit:auditLogCorrelationQuery:default
SELECT
          logs.ServiceName AS serviceName,
          count() AS logCount,
          countIf(logs.TraceId = '') AS uncorrelatedCount,
          countIf(upper(SeverityText) IN ('ERROR', 'FATAL')) AS errorLogCount,
          countIf((logs.TraceId = '' AND upper(SeverityText) IN ('ERROR', 'FATAL'))) AS uncorrelatedErrorCount
        FROM logs
        WHERE logs.OrgId = 'org_sql_catalog'
          AND logs.TimestampTime >= '2026-01-01 10:30:00'
          AND logs.TimestampTime <= '2026-01-03 14:15:00'
          AND logs.Timestamp >= '2026-01-01 10:30:00'
          AND logs.Timestamp <= '2026-01-03 14:15:00'
        GROUP BY serviceName
        ORDER BY logCount DESC
        LIMIT 500
        FORMAT JSON

-- builder:setup-audit:auditLogSeverityByServiceQuery:default
SELECT
          logs_aggregates_hourly.ServiceName AS serviceName,
          logs_aggregates_hourly.SeverityText AS severityText,
          sum(logs_aggregates_hourly.Count) AS logCount
        FROM logs_aggregates_hourly
        WHERE logs_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND logs_aggregates_hourly.Hour >= toStartOfHour(toDateTime('2026-01-01 10:30:00'))
          AND logs_aggregates_hourly.Hour <= toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY serviceName, severityText
        ORDER BY logCount DESC
        LIMIT 25
        FORMAT JSON

-- builder:setup-audit:auditMetricLabelCardinalityQuery:default
SELECT
          attribute_values_hourly.AttributeKey AS attributeKey,
          uniq(attribute_values_hourly.AttributeValue) AS valueCardinality,
          sum(attribute_values_hourly.UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE attribute_values_hourly.OrgId = 'org_sql_catalog'
          AND attribute_values_hourly.AttributeScope = 'metric'
          AND attribute_values_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_values_hourly.Hour <= '2026-01-03 14:15:00'
        GROUP BY attributeKey
        ORDER BY valueCardinality DESC
        LIMIT 25
        FORMAT JSON

-- builder:setup-audit:auditOrphanSpansSQL:default
SELECT
          c.ServiceName AS serviceName,
          count() AS childCount,
          countIf(p.SpanId = '') AS orphanCount,
          countIf((p.SpanId = '' AND match(c.TraceState, 'th:[0-9a-f]+'))) AS sampledOrphanCount,
          groupUniqArrayIf(3)(c.TraceId, p.SpanId = '') AS sampleTraceIds
        FROM (SELECT
          service_map_children.TraceId AS TraceId,
          service_map_children.ParentSpanId AS ParentSpanId,
          service_map_children.ServiceName AS ServiceName,
          service_map_children.TraceState AS TraceState
        FROM service_map_children
        WHERE service_map_children.OrgId = 'org_sql_catalog'
          AND service_map_children.Timestamp >= '2026-01-01 10:30:00'
          AND service_map_children.Timestamp < '2026-01-03 14:15:00'
          AND service_map_children.ParentSpanId != '') AS c
        LEFT JOIN (SELECT
          service_map_spans.TraceId AS TraceId,
          service_map_spans.SpanId AS SpanId
        FROM service_map_spans
        WHERE service_map_spans.OrgId = 'org_sql_catalog'
          AND service_map_spans.Timestamp >= '2026-01-01 08:30:00'
          AND service_map_spans.Timestamp < '2026-01-03 14:15:00') AS p ON (c.TraceId = p.TraceId AND c.ParentSpanId = p.SpanId)
        GROUP BY serviceName
        ORDER BY orphanCount DESC
        LIMIT 200
        FORMAT JSON

-- builder:setup-audit:auditPeerValueInventoryQuery:default
SELECT
          attribute_values_hourly.AttributeKey AS attributeKey,
          attribute_values_hourly.AttributeValue AS attributeValue,
          sum(attribute_values_hourly.UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE attribute_values_hourly.OrgId = 'org_sql_catalog'
          AND attribute_values_hourly.AttributeScope = 'span'
          AND attribute_values_hourly.AttributeKey IN ('service.peer.name', 'peer.service', 'db.system', 'db.system.name', 'messaging.system', 'rpc.system.name', 'rpc.system')
          AND attribute_values_hourly.Hour >= '2026-01-01 10:30:00'
          AND attribute_values_hourly.Hour <= '2026-01-03 14:15:00'
          AND attribute_values_hourly.AttributeValue != ''
        GROUP BY attributeKey, attributeValue
        ORDER BY usageCount DESC
        LIMIT 25
        FORMAT JSON

-- builder:setup-audit:auditRootlessTracesSQL:default
SELECT
          t.entryService AS entryService,
          count() AS traceCount,
          countIf(r.TraceId = '') AS rootlessCount,
          countIf((r.TraceId = '' AND t.isSampled = 1)) AS sampledRootlessCount
        FROM (SELECT
          service_map_children.TraceId AS TraceId,
          argMin(service_map_children.ServiceName, service_map_children.Timestamp) AS entryService,
          max(match(service_map_children.TraceState, 'th:[0-9a-f]+')) AS isSampled
        FROM service_map_children
        WHERE service_map_children.OrgId = 'org_sql_catalog'
          AND service_map_children.Timestamp >= '2026-01-01 10:30:00'
          AND service_map_children.Timestamp < '2026-01-03 14:15:00'
        GROUP BY TraceId) AS t
        LEFT JOIN (SELECT
          trace_list_mv.TraceId AS TraceId
        FROM trace_list_mv
        WHERE trace_list_mv.OrgId = 'org_sql_catalog'
          AND trace_list_mv.Timestamp >= '2026-01-01 08:30:00'
          AND trace_list_mv.Timestamp < '2026-01-03 14:15:00'
        GROUP BY TraceId) AS r ON t.TraceId = r.TraceId
        GROUP BY entryService
        ORDER BY rootlessCount DESC
        LIMIT 200
        FORMAT JSON

-- builder:setup-audit:auditSamplingByServiceQuery:default
SELECT
          service_overview_hourly.ServiceName AS serviceName,
          sum(service_overview_hourly.SpanCount) AS spanCount,
          sum(service_overview_hourly.EstimatedSpanCount) AS estimatedSpanCount,
          sumIf(service_overview_hourly.SpanCount, service_overview_hourly.CommitSha != '') AS commitTaggedSpanCount
        FROM service_overview_hourly
        WHERE service_overview_hourly.OrgId = 'org_sql_catalog'
          AND service_overview_hourly.Hour >= toStartOfHour(toDateTime('2026-01-01 10:30:00'))
          AND service_overview_hourly.Hour <= toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY serviceName
        ORDER BY spanCount DESC
        LIMIT 25
        FORMAT JSON

-- builder:setup-audit:auditSpanProfileByServiceQuery:default
SELECT
          traces_aggregates_hourly.ServiceName AS serviceName,
          sum(traces_aggregates_hourly.WeightedCount) AS weightedSpanCount,
          sum(traces_aggregates_hourly.WeightedErrorCount) AS weightedErrorCount,
          sumIf(traces_aggregates_hourly.WeightedCount, traces_aggregates_hourly.SpanKind = 'Server') AS serverCount,
          sumIf(traces_aggregates_hourly.WeightedCount, traces_aggregates_hourly.SpanKind = 'Consumer') AS consumerCount,
          sumIf(traces_aggregates_hourly.WeightedCount, traces_aggregates_hourly.SpanKind = 'Client') AS clientCount,
          sumIf(traces_aggregates_hourly.WeightedCount, traces_aggregates_hourly.SpanKind = 'Producer') AS producerCount,
          sumIf(traces_aggregates_hourly.WeightedCount, traces_aggregates_hourly.DeploymentEnv = '') AS noEnvCount,
          uniq(traces_aggregates_hourly.SpanName) AS spanNameCount,
          groupUniqArrayIf(5)(StatusCode, StatusCode NOT IN ('Ok', 'Error', 'Unset', '')) AS badStatusCodes,
          groupUniqArrayIf(5)(SpanKind, SpanKind NOT IN ('Server', 'Client', 'Producer', 'Consumer', 'Internal', '')) AS badSpanKinds
        FROM traces_aggregates_hourly
        WHERE traces_aggregates_hourly.OrgId = 'org_sql_catalog'
          AND traces_aggregates_hourly.Hour >= toStartOfHour(toDateTime('2026-01-01 10:30:00'))
          AND traces_aggregates_hourly.Hour <= toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY serviceName
        ORDER BY weightedSpanCount DESC
        LIMIT 25
        FORMAT JSON