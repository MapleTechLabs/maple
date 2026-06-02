import { ToolCallScorer } from "vitest-evals"
import { describeMapleEval, predictToolCalls, FIXTURES } from "./utils"

// Disambiguation evals: prompts where two tools are plausible and the model must
// pick the better one. Each case has a single clear best answer (ambiguous-by-
// design prompts are avoided — they'd make a flaky `requireAll` scorer). These
// guard against tool-selection drift as descriptions evolve.
describeMapleEval("tool disambiguation", {
	data: async () => [
		// "slowest" is a first-class tool, not search_traces + a sort arg.
		{
			input: "Which traces are taking the longest right now?",
			expectedTools: [{ name: "find_slow_traces" }],
		},
		// High-volume log triage → pattern mining, not a raw log dump.
		{
			input: `The ${FIXTURES.service} service is spamming thousands of repetitive log lines — collapse them into the distinct templates.`,
			expectedTools: [{ name: "mine_log_patterns" }],
		},
		// "already tracked as an issue / its status" → the issue tracker, not find_errors.
		{
			input: "Is the checkout timeout already tracked as an issue, and what's its status?",
			expectedTools: [{ name: "list_error_issues" }],
		},
		// A specific fingerprint with sample traces → error_detail, not the find_errors list.
		{
			input: `Show me sample traces and correlated logs for error fingerprint ${FIXTURES.fingerprint}.`,
			expectedTools: [{ name: "error_detail", arguments: { fingerprint: FIXTURES.fingerprint } }],
		},
		// Grouping by status code is query_data's job, not get_service_top_operations.
		{
			input: "Break down request counts grouped by HTTP status code.",
			expectedTools: [
				{
					name: "query_data",
					arguments: { source: "traces", kind: "breakdown", metric: "count", group_by: "status_code" },
				},
			],
		},
	],
	task: predictToolCalls,
	scorers: [ToolCallScorer({ params: "fuzzy" })],
	threshold: 0.7,
})
