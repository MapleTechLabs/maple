import { ToolCallScorer } from "vitest-evals"
import { describeMapleEval, predictToolCalls, FIXTURES } from "./utils"

// Tool-selection + argument evals over the observability surface (the tools
// Part 1 touched). The model is handed every MCP tool and must pick the right
// one with the right key args. Tools are NOT executed — no warehouse needed.
describeMapleEval("observability tool selection", {
	data: async () => [
		{
			input: `What errors are happening in the ${FIXTURES.service} service in the last hour?`,
			expectedTools: [{ name: "find_errors", arguments: { service: FIXTURES.service } }],
		},
		{
			input: "Show me the slowest traces right now.",
			expectedTools: [{ name: "find_slow_traces" }],
		},
		{
			input: `Walk me through the full span tree for trace ${FIXTURES.traceId}.`,
			expectedTools: [{ name: "inspect_trace", arguments: { trace_id: FIXTURES.traceId } }],
		},
		{
			input: `Show the full attributes of span ${FIXTURES.spanId} in trace ${FIXTURES.traceId}.`,
			expectedTools: [
				{ name: "inspect_span", arguments: { trace_id: FIXTURES.traceId, span_id: FIXTURES.spanId } },
			],
		},
		{
			input: `Show me the logs for trace ${FIXTURES.traceId}.`,
			expectedTools: [{ name: "search_logs", arguments: { trace_id: FIXTURES.traceId } }],
		},
		{
			input: `Is error ${FIXTURES.fingerprint} getting worse over time?`,
			expectedTools: [
				{
					name: "error_detail",
					arguments: { fingerprint: FIXTURES.fingerprint, include_timeseries: true },
				},
			],
		},
		{
			input: "What services do I have and how healthy are they?",
			expectedTools: [{ name: "list_services" }],
		},
		{
			input: `Give me a deep health investigation of the ${FIXTURES.service} service.`,
			expectedTools: [{ name: "diagnose_service", arguments: { service_name: FIXTURES.service } }],
		},
		{
			input: "Group recent log noise into patterns so I can see what's spamming.",
			expectedTools: [{ name: "mine_log_patterns" }],
		},
		{
			input: "Which services call which, and where are the errors between them?",
			expectedTools: [{ name: "service_map" }],
		},
	],
	task: predictToolCalls,
	// Fuzzy arg matching tolerates case + extra params; requireAll (default)
	// means every expected tool must be called.
	scorers: [ToolCallScorer({ params: "fuzzy" })],
	threshold: 0.7,
})
