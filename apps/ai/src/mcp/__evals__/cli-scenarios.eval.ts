import { ToolCallScorer } from "vitest-evals"
import { describeMapleEval, predictToolCalls } from "./utils"

// Investigation scenarios ported from the former `apps/cli/EVALS.md` suite.
// That file documented real Maple-production investigations as `maple <cmd>`
// CLI invocations with prose "Expect:" notes — runnable by a human, but never
// asserted in CI. Each CLI command maps to an MCP tool, so here they become
// tool-selection evals: given the natural-language investigation, does the model
// pick the right tool with the right key args? Cases already covered by
// observability.eval.ts (list_services, diagnose_service, service_map,
// find_errors{service}, inspect_trace, search_logs{trace_id}, error_detail+trend,
// mine_log_patterns) are intentionally omitted to avoid duplication.

const SVC = {
	subscriptions: "subscriptions-api",
	stripe: "consumer-stripe-v2",
	appStore: "consumer-app-store-connect",
	googlePlay: "consumer-google-play-to-or",
} as const

const SPAN = {
	bearer: "AuthnV2Live.bearer",
	stripe: "processStripeV2",
	sql: "sql.execute",
} as const

const ATTR = { key: "applicationId", value: "16408" } as const

describeMapleEval("CLI investigation scenarios (ported from EVALS.md)", {
	data: async () => [
		// § 1 · Service discovery — top operations
		{
			input: `What are the top operations for the ${SVC.stripe} service by request count?`,
			expectedTools: [
				{
					name: "get_service_top_operations",
					arguments: { service_name: SVC.stripe, metric: "count" },
				},
			],
		},
		{
			input: `Which operations in ${SVC.subscriptions} have the worst error rate?`,
			expectedTools: [
				{
					name: "get_service_top_operations",
					arguments: { service_name: SVC.subscriptions, metric: "error_rate" },
				},
			],
		},

		// § 2 · Span-level trace search
		{
			input: `Find traces with a span named "${SPAN.bearer}".`,
			expectedTools: [{ name: "search_traces", arguments: { span_name: SPAN.bearer } }],
		},
		{
			input: `Show me "${SPAN.stripe}" spans in the ${SVC.stripe} service.`,
			expectedTools: [
				{ name: "search_traces", arguments: { span_name: SPAN.stripe, service: SVC.stripe } },
			],
		},
		{
			input: `Find failed "PublicApiKeyAuthn" spans in ${SVC.subscriptions} — errors only.`,
			expectedTools: [
				{
					name: "search_traces",
					arguments: {
						span_name: "PublicApiKeyAuthn",
						service: SVC.subscriptions,
						has_error: true,
					},
				},
			],
		},
		{
			input: `Find "${SPAN.sql}" spans that took longer than 10 seconds.`,
			expectedTools: [
				{ name: "search_traces", arguments: { span_name: SPAN.sql, min_duration_ms: 10000 } },
			],
		},

		// § 3 · Attribute-based search
		{
			input: `Find traces where ${ATTR.key} is ${ATTR.value}.`,
			expectedTools: [
				{
					name: "search_traces",
					arguments: { attribute_key: ATTR.key, attribute_value: ATTR.value },
				},
			],
		},
		{
			input: `Show only error traces for ${ATTR.key} ${ATTR.value}.`,
			expectedTools: [
				{
					name: "search_traces",
					arguments: { attribute_key: ATTR.key, attribute_value: ATTR.value, has_error: true },
				},
			],
		},
		{
			input: `Find "Stripe" spans that carry ${ATTR.key}=${ATTR.value}.`,
			expectedTools: [
				{
					name: "search_traces",
					arguments: { span_name: "Stripe", attribute_key: ATTR.key, attribute_value: ATTR.value },
				},
			],
		},
		{
			input: "What are some recent values of the deviceId attribute on traces?",
			expectedTools: [{ name: "explore_attributes", arguments: { source: "traces", key: "deviceId" } }],
		},

		// § 5 · Error investigation (list, no service filter)
		{
			input: "List all the error types across the system in the last 6 hours.",
			expectedTools: [{ name: "find_errors" }],
		},

		// § 6 · Analytics — breakdown
		{
			input: "Break down error rate by service so I can see the worst offenders.",
			expectedTools: [
				{
					name: "query_data",
					arguments: {
						source: "traces",
						kind: "breakdown",
						metric: "error_rate",
						group_by: "service",
					},
				},
			],
		},
		{
			input: `Show P95 latency by span name for ${SVC.subscriptions}.`,
			expectedTools: [
				{
					name: "query_data",
					arguments: {
						source: "traces",
						kind: "breakdown",
						metric: "p95_duration",
						group_by: "span_name",
						service_name: SVC.subscriptions,
					},
				},
			],
		},

		// § 7 · Analytics — timeseries
		{
			input: `Plot error rate over time for ${SVC.appStore}.`,
			expectedTools: [
				{
					name: "query_data",
					arguments: {
						source: "traces",
						kind: "timeseries",
						metric: "error_rate",
						service_name: SVC.appStore,
					},
				},
			],
		},
		{
			input: "Chart request count over time, split by service.",
			expectedTools: [
				{
					name: "query_data",
					arguments: { source: "traces", kind: "timeseries", metric: "count", group_by: "service" },
				},
			],
		},

		// § 8 · Log search
		{
			input: `Show ERROR-level logs for ${SVC.googlePlay}.`,
			expectedTools: [
				{ name: "search_logs", arguments: { service: SVC.googlePlay, severity: "ERROR" } },
			],
		},
		{
			input: `Find logs in ${SVC.subscriptions} that mention "publicApiKey".`,
			expectedTools: [
				{ name: "search_logs", arguments: { service: SVC.subscriptions, search: "publicApiKey" } },
			],
		},

		// § 9 · Attribute discovery
		{
			input: "List the span-level attribute keys available on traces.",
			expectedTools: [{ name: "explore_attributes", arguments: { source: "traces", scope: "span" } }],
		},
		{
			input: "What resource-level attribute keys do my traces have?",
			expectedTools: [
				{ name: "explore_attributes", arguments: { source: "traces", scope: "resource" } },
			],
		},
	],
	task: predictToolCalls,
	scorers: [ToolCallScorer({ params: "fuzzy" })],
	threshold: 0.7,
})
