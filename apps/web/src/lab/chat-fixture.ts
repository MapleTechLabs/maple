import type { UIMessage } from "@/components/ai-elements/types"

/**
 * A thread that holds every chat surface at once: a tool burst that merges into a
 * group, a standalone call, prose carrying all four inline cards, and the one- and
 * two-word turns that make the transcript's vertical rhythm obvious.
 *
 * The inline cards are written the way the model emits them — `<<maple:type:{…}>>`
 * on its own line — so the lab exercises the real parser, not a hand-built segment
 * list.
 */
export function buildChatLabMessages(): UIMessage[] {
	// A fixed clock walked forward a minute per turn, so the footer's timestamp is
	// exercised without the lab re-rendering differently on every reload.
	let clock = Date.UTC(2026, 8, 11, 14, 3)
	const at = () => (clock += 60_000)
	return [
		{
			id: "m1",
			role: "user",
			createdAt: at(),
			parts: [{ type: "text", text: "Which services are unhealthy right now?", state: "done" }],
		},
		{
			id: "m2",
			role: "assistant",
			createdAt: at(),
			parts: [
				{
					type: "dynamic-tool",
					toolCallId: "c1",
					toolName: "list_services",
					state: "output-available",
					input: { limit: 50 },
					output: { text: "18 services" },
				},
			],
		},
		{
			id: "m3",
			role: "assistant",
			createdAt: at(),
			parts: [
				{
					type: "dynamic-tool",
					toolCallId: "c2",
					toolName: "find_errors",
					state: "output-available",
					input: { service: "web-paywall-worker" },
					output: { text: "4 fingerprints" },
				},
				{
					type: "dynamic-tool",
					toolCallId: "c3",
					toolName: "find_slow_traces",
					state: "output-available",
					input: { service: "subscriptions-api", limit: 5 },
					output: { text: "5 traces" },
				},
			],
		},
		{
			id: "m4",
			role: "assistant",
			createdAt: at(),
			parts: [
				{
					type: "text",
					state: "done",
					text: [
						"**Three services are in trouble.** The paywall worker is failing outright; the other two are degraded.",
						"",
						'<<maple:service:{"name":"web-paywall-worker","throughput":1240,"errorRate":39.5,"p99Ms":8400}>>',
						'<<maple:service:{"name":"kafka-consumers-consumption-request","throughput":48200,"errorRate":1.24,"p99Ms":6400}>>',
						'<<maple:service:{"name":"subscriptions-api","throughput":2900000,"errorRate":0.89,"p99Ms":420}>>',
						"",
						"Nearly all of the paywall failures share one fingerprint:",
						"",
						'<<maple:error:{"errorType":"TypeError: Cannot read properties of undefined (reading \'entitlements\')","count":18422,"affectedServices":["web-paywall-worker","subscriptions-api","enrichment-api","mmp-api"]}>>',
						"",
						"A representative trace and the log that precedes every failure:",
						"",
						'<<maple:trace:{"id":"9f2c7ae41b6d5c08f31a","name":"GET /api/paywall/check","durationMs":8412,"hasError":true,"spanCount":37,"services":["web-paywall-worker","subscriptions-api","enrichment-api","mmp-api"]}>>',
						'<<maple:log:{"severity":"ERROR","body":"entitlement lookup returned no body; falling through to undefined","serviceName":"web-paywall-worker","traceId":"9f2c7ae41b6d5c08f31a"}>>',
						"",
						"The other 12 services are all under 0.4% errors.",
						"",
						"| Service | Errors | P95 | Change vs last hour |",
						"| --- | --- | --- | --- |",
						"| web-paywall-worker | 39.5% | 8.40s | +38.9pp |",
						"| kafka-consumers-consumption-request | 1.24% | 6.40s | +0.9pp |",
						"| subscriptions-api | 0.89% | 420ms | -0.1pp |",
						"| subs-writer | 0.00% | 180ms | flat |",
					].join("\n"),
				},
			],
		},
		{
			id: "m5",
			role: "user",
			createdAt: at(),
			parts: [{ type: "text", text: ":D", state: "done" }],
		},
		{
			id: "m6",
			role: "assistant",
			createdAt: at(),
			parts: [
				{
					type: "text",
					state: "done",
					text: "Glad someone's in a good mood — the paywall worker isn't. Let me know if you want to dig into any of those failing services.",
				},
			],
		},
		{
			id: "m7",
			role: "user",
			createdAt: at(),
			parts: [{ type: "text", text: "yeah, mute it for an hour", state: "done" }],
		},
		{
			id: "m8",
			role: "assistant",
			createdAt: at(),
			parts: [
				{
					type: "dynamic-tool",
					toolCallId: "c4",
					toolName: "update_alert_rule",
					state: "proposed",
					input: { ruleId: "rule_9182", muteUntil: "2026-09-11T18:00:00Z" },
				},
			],
		},
		{
			id: "m9",
			role: "assistant",
			parts: [
				{
					type: "task",
					toolCallId: "t1",
					agent: "trace-analyst",
					description: "Find every trace where the entitlement lookup returned an empty body",
					status: "completed",
					messages: [
						{
							id: "t1-1",
							role: "assistant",
							parts: [
								{
									type: "dynamic-tool",
									toolCallId: "t1-c1",
									toolName: "search_traces",
									state: "output-available",
									input: { service: "web-paywall-worker" },
									output: { text: "212 traces" },
								},
							],
						},
					],
				},
				{
					type: "dynamic-tool",
					toolCallId: "c5",
					toolName: "run_sql",
					state: "output-error",
					input: { sql: "SELECT count() FROM spans WHERE ServiceName = 'web-paywall-worker'" },
					errorText: "Raw SQL is not enabled for this organization.",
				},
			],
		},
	]
}
