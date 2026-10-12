/**
 * Tool-use tasks: one user message to the production chat agent, graded on what the calls mean.
 *
 * Ported tasks come from the old selection suites and `apps/cli/EVALS.md`; their targets now list
 * every acceptable answer instead of one exact argument object. New tasks are negative cases (no
 * tool fits, a read must not mutate, an ambiguous destructive request) and near-miss phrasings,
 * after BFCL's irrelevance category and MCP-Bench's fuzzy tasks. `tasks.test.ts` checks every
 * target against the live tool schemas, so a rename breaks that test instead of these scores.
 *
 * Tier: ported tasks were at ceiling, so they are `regression`; new ones start as `capability`
 * and move once they pass every trial on every target model.
 */
import { FIXTURES } from "../../mcp/__evals__/utils"
import { INFRA_WORLD } from "../../mcp/__evals__/infra-world"
import type { EvalTask } from "../runner"
import { answerMentions, call, calls, never, noTools, type Check } from "../targets"

export interface ToolTask extends EvalTask {
	readonly input: string
	readonly expect: ReadonlyArray<Check>
	/** Tool results after which the turn is stopped; enough to reach the target, not to wander. */
	readonly maxToolCalls?: number
}

const SVC = {
	api: FIXTURES.service,
	subscriptions: "subscriptions-api",
	stripe: "consumer-stripe-v2",
	appStore: "consumer-app-store-connect",
	googlePlay: "consumer-google-play-to-or",
} as const

const ATTR = { key: "applicationId", value: "16408" } as const
const ISSUE = FIXTURES.issueId
const PR_42 = "https://github.com/acme/api/pull/42"
const PR_99 = "https://github.com/acme/api/pull/99"

/** Tools that change an error issue; a question about one must not reach for them. */
const ISSUE_MUTATIONS = [
	"claim_error_issue",
	"release_error_issue",
	"transition_error_issue",
	"transition_error_issues",
	"propose_fix",
	"link_pull_request",
	"comment_on_error_issue",
	"set_issue_severity",
] as const

const regression = (
	id: string,
	tags: ReadonlyArray<string>,
	input: string,
	...expect: ReadonlyArray<Check>
): ToolTask => ({
	id,
	tier: "regression",
	tags,
	input,
	expect,
})

/** Outcome tasks are graded on the answer, so the turn needs room to finish one. */
const withRoom = (task: ToolTask): ToolTask => ({ ...task, maxToolCalls: 10 })

const capability = (
	id: string,
	tags: ReadonlyArray<string>,
	input: string,
	...expect: ReadonlyArray<Check>
): ToolTask => ({
	id,
	tier: "capability",
	tags,
	input,
	expect,
})

export const TOOL_TASKS: ReadonlyArray<ToolTask> = [
	// Observability basics.
	regression(
		"errors-in-service",
		["errors"],
		`What errors are happening in the ${SVC.api} service in the last hour?`,
		calls(call("find_errors", { service: SVC.api })),
	),
	regression(
		"slowest-traces",
		["traces"],
		"Show me the slowest traces right now.",
		calls(call("find_slow_traces")),
	),
	regression(
		"trace-tree",
		["traces"],
		`Walk me through the full span tree for trace ${FIXTURES.traceId}.`,
		calls(call("inspect_trace", { trace_id: FIXTURES.traceId })),
	),
	regression(
		"span-attributes",
		["traces"],
		`Show the full attributes of span ${FIXTURES.spanId} in trace ${FIXTURES.traceId}.`,
		calls(call("inspect_span", { trace_id: FIXTURES.traceId, span_id: FIXTURES.spanId })),
	),
	regression(
		"trace-logs",
		["logs"],
		`Show me the logs for trace ${FIXTURES.traceId}.`,
		calls(call("search_logs", { trace_id: FIXTURES.traceId })),
	),
	regression(
		"error-trend",
		["errors"],
		`Is error ${FIXTURES.fingerprint} getting worse over time?`,
		calls(call("error_detail", { fingerprint: FIXTURES.fingerprint, include_timeseries: true })),
	),
	regression(
		"services-health",
		["services"],
		"What services do I have and how healthy are they?",
		calls(call("list_services")),
	),
	regression(
		"deep-health",
		["services"],
		`Give me a deep health investigation of the ${SVC.api} service.`,
		calls(call("diagnose_service", { service: SVC.api })),
	),
	regression(
		"log-patterns",
		["logs"],
		"Group recent log noise into patterns so I can see what's spamming.",
		calls(call("mine_log_patterns")),
	),
	regression(
		"service-map",
		["services"],
		"Which services call which, and where are the errors between them?",
		calls(call("service_map")),
	),

	// Investigation scenarios from apps/cli/EVALS.md.
	regression(
		"top-operations-by-count",
		["services", "analytics"],
		`What are the top operations for the ${SVC.stripe} service by request count?`,
		calls(
			call("get_service_top_operations", { service: SVC.stripe, metric: { orDefault: "count" } }),
			call("query_data", {
				kind: "breakdown",
				group_by: "span_name",
				service: SVC.stripe,
				metric: { orDefault: "count" },
			}),
		),
	),
	regression(
		"operations-worst-error-rate",
		["services", "analytics"],
		`Which operations in ${SVC.subscriptions} have the worst error rate?`,
		calls(
			call("get_service_top_operations", { service: SVC.subscriptions, metric: "error_rate" }),
			call("query_data", {
				kind: "breakdown",
				group_by: "span_name",
				service: SVC.subscriptions,
				metric: "error_rate",
			}),
		),
	),
	regression(
		"spans-by-name",
		["traces"],
		'Find traces with a span named "AuthnV2Live.bearer".',
		calls(call("search_traces", { span_name: "AuthnV2Live.bearer" })),
	),
	regression(
		"spans-by-name-in-service",
		["traces"],
		`Show me "processStripeV2" spans in the ${SVC.stripe} service.`,
		calls(call("search_traces", { span_name: "processStripeV2", service: SVC.stripe })),
	),
	regression(
		"failed-spans",
		["traces"],
		`Find failed "PublicApiKeyAuthn" spans in ${SVC.subscriptions}, errors only.`,
		calls(
			call("search_traces", {
				span_name: "PublicApiKeyAuthn",
				service: SVC.subscriptions,
				has_error: true,
			}),
		),
	),
	regression(
		"slow-sql-spans",
		["traces"],
		'Find "sql.execute" spans that took longer than 10 seconds.',
		calls(call("search_traces", { span_name: "sql.execute", min_duration_ms: 10_000 })),
	),
	regression(
		"traces-by-attribute",
		["traces", "attributes"],
		`Find traces where ${ATTR.key} is ${ATTR.value}.`,
		calls(call("search_traces", { attribute_key: ATTR.key, attribute_value: ATTR.value })),
	),
	regression(
		"error-traces-by-attribute",
		["traces", "attributes"],
		`Show only error traces for ${ATTR.key} ${ATTR.value}.`,
		calls(
			call("search_traces", { attribute_key: ATTR.key, attribute_value: ATTR.value, has_error: true }),
		),
	),
	regression(
		"spans-by-name-and-attribute",
		["traces", "attributes"],
		`Find "Stripe" spans that carry ${ATTR.key}=${ATTR.value}.`,
		calls(
			call("search_traces", {
				span_name: { includes: "stripe" },
				attribute_key: ATTR.key,
				attribute_value: ATTR.value,
			}),
		),
	),
	regression(
		"attribute-values",
		["attributes"],
		"What are some recent values of the deviceId attribute on traces?",
		calls(call("explore_attributes", { source: "traces", key: "deviceId" })),
	),
	regression(
		"all-error-types",
		["errors"],
		"List all the error types across the system in the last 6 hours.",
		calls(call("find_errors", { service: { absent: true } })),
	),
	withRoom(
		regression(
			"error-rate-by-service",
			["analytics", "outcome"],
			"Break down error rate by service so I can see the worst offenders.",
			// list_services already shows each service's error rate, so it answers this as well.
			calls(
				call("query_data", {
					source: "traces",
					kind: "breakdown",
					metric: "error_rate",
					group_by: { orDefault: "service" },
				}),
				call("list_services"),
			),
			// 640 errors in 12,100 requests: the world's worst offender by rate.
			answerMentions("consumer-app-store-connect"),
		),
	),
	regression(
		"p95-by-span-name",
		["analytics"],
		`Show P95 latency by span name for ${SVC.subscriptions}.`,
		calls(
			call("query_data", {
				source: "traces",
				kind: "breakdown",
				metric: "p95_duration",
				group_by: "span_name",
				service: SVC.subscriptions,
			}),
			call("get_service_top_operations", { service: SVC.subscriptions, metric: "p95_duration" }),
		),
	),
	regression(
		"error-rate-timeseries",
		["analytics"],
		`Plot error rate over time for ${SVC.appStore}.`,
		calls(
			call("query_data", {
				source: "traces",
				kind: "timeseries",
				metric: "error_rate",
				service: SVC.appStore,
			}),
		),
	),
	regression(
		"request-count-timeseries-by-service",
		["analytics"],
		"Chart request count over time, split by service.",
		calls(
			call("query_data", {
				source: "traces",
				kind: "timeseries",
				metric: { orDefault: "count" },
				group_by: "service",
			}),
		),
	),
	regression(
		"error-logs-for-service",
		["logs"],
		`Show ERROR-level logs for ${SVC.googlePlay}.`,
		calls(call("search_logs", { service: SVC.googlePlay, severity: "ERROR" })),
	),
	regression(
		"logs-mentioning",
		["logs"],
		`Find logs in ${SVC.subscriptions} that mention "publicApiKey".`,
		calls(call("search_logs", { service: SVC.subscriptions, search: { includes: "publicApiKey" } })),
	),
	regression(
		"span-attribute-keys",
		["attributes"],
		"List the span-level attribute keys available on traces.",
		// Span is the default scope, so leaving it out asks the same question.
		calls(call("explore_attributes", { source: "traces", scope: { orDefault: "span" } })),
	),
	regression(
		"resource-attribute-keys",
		["attributes"],
		"What resource-level attribute keys do my traces have?",
		calls(call("explore_attributes", { source: "traces", scope: "resource" })),
	),

	// Disambiguation: two tools are plausible, one is clearly better.
	regression(
		"longest-traces",
		["traces", "disambiguation"],
		"Which traces are taking the longest right now?",
		calls(call("find_slow_traces")),
	),
	regression(
		"collapse-log-spam",
		["logs", "disambiguation"],
		`The ${SVC.api} service is spamming thousands of repetitive log lines. Collapse them into the distinct templates.`,
		calls(call("mine_log_patterns")),
	),
	regression(
		"is-it-tracked",
		["issues", "disambiguation"],
		"Is the checkout timeout already tracked as an issue, and what's its status?",
		calls(call("list_error_issues")),
		never(...ISSUE_MUTATIONS),
	),
	regression(
		"fingerprint-samples",
		["errors", "disambiguation"],
		`Show me sample traces and correlated logs for error fingerprint ${FIXTURES.fingerprint}.`,
		calls(call("error_detail", { fingerprint: FIXTURES.fingerprint })),
	),
	regression(
		"status-code-breakdown",
		["analytics", "disambiguation"],
		"Break down request counts grouped by HTTP status code.",
		calls(
			call("query_data", {
				source: "traces",
				kind: "breakdown",
				group_by: "status_code",
				metric: { orDefault: "count" },
			}),
			// Grouping by the semconv attribute itself answers the same question.
			call("query_data", {
				source: "traces",
				kind: "breakdown",
				group_by: "attribute",
				attribute_key: { includes: "status_code" },
				metric: { orDefault: "count" },
			}),
		),
	),

	// Error issue workflow. Mutations are approval-gated in chat, so a proposal is the call.
	regression(
		"claim-issue",
		["issues"],
		`I'm going to start working on error issue ${ISSUE}. Pick it up so nobody else duplicates the work.`,
		// A transition to in_progress takes the lease too, so both claim.
		calls(
			call("claim_error_issue", { issue_id: ISSUE }),
			call("transition_error_issue", { issue_id: ISSUE, to_state: "in_progress" }),
		),
	),
	regression(
		"who-is-working",
		["issues"],
		`Is anyone currently working on error issue ${ISSUE}?`,
		calls(call("list_error_issue_events", { issue_id: ISSUE }), call("list_error_issues")),
		never(...ISSUE_MUTATIONS),
	),
	regression(
		"record-fix",
		["issues"],
		`I fixed error issue ${ISSUE}. The PR is ${PR_42}. Record the fix.`,
		// Both record it: propose_fix also moves the issue to in_review, link_pull_request leaves it
		// for the merge to move. Neither description makes the other wrong for "record the fix".
		calls(
			call("propose_fix", { issue_id: ISSUE, pr_url: PR_42 }),
			call("link_pull_request", { issue_id: ISSUE, pull_request_url: PR_42 }),
		),
		// propose_fix claims and moves the issue itself; walking the state machine first is the bug.
		never("transition_error_issue"),
	),
	regression(
		"link-existing-pr",
		["issues"],
		`PR ${PR_99} already covers error issue ${ISSUE}. Attach it so the fix gets verified after it merges.`,
		calls(call("link_pull_request", { issue_id: ISSUE, pull_request_url: PR_99 })),
	),
	regression(
		"release-issue",
		["issues"],
		`I'm done looking at error issue ${ISSUE} and didn't get anywhere. Let someone else take it.`,
		calls(call("release_error_issue", { issue_id: ISSUE })),
	),

	// Outcome: the answer has to come from what the tool returned, not just the right call.
	withRoom(
		regression(
			"failed-span-in-trace",
			["traces", "outcome"],
			`Inspect trace ${FIXTURES.traceId}. Which span failed, and with what error?`,
			calls(call("inspect_trace", { trace_id: FIXTURES.traceId })),
			answerMentions("connection reset"),
		),
	),

	// Negative cases: the right answer calls nothing, or must not call a particular thing.
	capability(
		"concept-question",
		["negative", "no-tool"],
		"In OpenTelemetry terms, what's the difference between a trace and a span? Just explain it.",
		noTools,
	),
	capability(
		"out-of-scope-request",
		["negative", "no-tool"],
		"Book me a flight to Berlin next Tuesday.",
		noTools,
	),
	capability(
		"read-does-not-mutate",
		["negative", "issues"],
		`Is error issue ${ISSUE} still happening?`,
		calls(
			call("error_detail", { issue_id: ISSUE }),
			call("list_error_issue_events", { issue_id: ISSUE }),
			call("list_error_issues"),
		),
		never(...ISSUE_MUTATIONS),
	),
	capability(
		"ambiguous-delete",
		["negative", "alerts"],
		"Delete the alert rule.",
		// Which one? Listing to ask is right; deleting a guessed rule is not.
		never("delete_alert_rule"),
	),

	// Near misses and fuzzy phrasing: no tool or parameter is named.
	capability(
		"requests-per-minute",
		["analytics", "fuzzy"],
		`How many requests did ${SVC.api} handle per minute over the last hour?`,
		calls(
			call("query_data", {
				source: "traces",
				kind: "timeseries",
				service: SVC.api,
				metric: { orDefault: "count" },
			}),
		),
	),
	capability(
		"noisiest-error-logger",
		["logs", "analytics", "fuzzy"],
		"Which service is writing the most ERROR logs?",
		calls(
			call("query_data", {
				source: "logs",
				kind: "breakdown",
				severity: "ERROR",
				group_by: { orDefault: "service" },
			}),
		),
	),
	capability(
		"worse-than-yesterday",
		["services", "fuzzy"],
		"checkout feels sluggish today. Is it actually worse than yesterday?",
		calls(
			call("compare_periods", { service: "checkout" }),
			call("query_data", { source: "traces", service: "checkout" }),
			call("diagnose_service", { service: "checkout" }),
		),
	),
	capability(
		"host-cpu",
		["metrics", "fuzzy"],
		"What's CPU usage looking like on my hosts?",
		calls(call("list_metrics"), call("query_data", { source: "metrics" })),
	),
	capability(
		"is-it-down",
		["services", "fuzzy"],
		`Is ${SVC.api} down?`,
		calls(
			call("diagnose_service", { service: SVC.api }),
			call("list_services"),
			call("query_data", { service: SVC.api }),
			call("find_errors", { service: SVC.api }),
		),
	),
	// Infrastructure, in the world of `infra-world.ts`; see src/evals/playground/README.md.
	withRoom(
		capability(
			"infra-running-hot",
			["infra", "fuzzy"],
			"Is anything in our infrastructure running hot right now?",
			calls(call("list_infra")),
			answerMentions(INFRA_WORLD.oomPod, INFRA_WORLD.hotContainer),
		),
	),
	capability(
		"infra-no-limits",
		["infra"],
		"Which of our pods have no resource limits set?",
		calls(
			call("list_infra", { kind: "pods" }),
			call("list_infra", { kind: "workloads" }),
			call("list_infra"),
		),
	),
	capability(
		"infra-node-contents",
		["infra"],
		`What runs on node ${INFRA_WORLD.hotNode}, and is it overloaded?`,
		calls(
			call("inspect_infra", { kind: "node", name: INFRA_WORLD.hotNode }),
			call("list_infra", { kind: "pods", node: INFRA_WORLD.hotNode }),
		),
	),
	withRoom(
		capability(
			"infra-service-resources",
			["infra", "services", "fuzzy"],
			"Our checkout service has been flaky for the last few hours. Could it be a resource problem?",
			calls(
				call("diagnose_service", { service: "checkout" }),
				call("inspect_infra", { kind: "workload", name: "checkout" }),
				call("inspect_infra", { kind: "pod", name: INFRA_WORLD.oomPod }),
				call("list_infra", { kind: "pods" }),
			),
			answerMentions(INFRA_WORLD.oomPod, "98"),
		),
	),
	capability(
		"infra-ci-host",
		["infra", "fuzzy"],
		`Our CI builds got slow. Can you check ${INFRA_WORLD.hotHost}?`,
		calls(
			call("inspect_infra", { kind: "host", name: INFRA_WORLD.hotHost }),
			call("list_infra", { kind: "hosts" }),
			call("list_infra"),
		),
	),
	capability(
		"infra-not-for-errors",
		["infra", "negative"],
		`How many server errors did the ${SVC.api} service return in the last hour?`,
		never("list_infra", "inspect_infra"),
	),
	capability(
		"user-reported-failure",
		["traces", "fuzzy"],
		`A user says checkout broke for them around 14:05 today. Find what happened in their traces; their user id is u_8812.`,
		calls(
			call("search_sessions"),
			call("search_traces", { attribute_value: "u_8812" }),
			call("search_logs", { search: { includes: "u_8812" } }),
		),
	),
]
