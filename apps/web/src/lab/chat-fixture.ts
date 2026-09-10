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
/**
 * Eight minutes of the paywall worker's error count, for the fixture's chart turn.
 *
 * Anchored to the real clock rather than to the fixture's fixed one, because the
 * charts draw any bucket whose end is still ahead of `now` as an in-flight dashed
 * tail — a fixed 2026 timestamp renders the whole series as one dashed guess.
 */
const ERRORS_PER_MINUTE = [4, 6, 5, 31, 88, 140, 132, 96].map((value, index, all) => ({
	bucket: new Date(Math.floor(Date.now() / 60_000 - (all.length - index)) * 60_000).toISOString(),
	series: { "web-paywall-worker": value },
}))

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
			id: "m3b",
			role: "assistant",
			createdAt: at(),
			parts: [
				{
					type: "text",
					state: "done",
					text: "The paywall worker looks worst — pulling its slowest traces before I say anything about the other two.",
				},
				{
					type: "dynamic-tool",
					toolCallId: "c3b",
					toolName: "inspect_trace",
					state: "output-available",
					input: { traceId: "9f2c7ae41b6d5c08f31a" },
					output: { text: "37 spans" },
				},
				{
					type: "text",
					state: "done",
					text: "That trace spends 6.1s of its 8.4s inside the entitlement lookup.",
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
						'<<maple:service:{"name":"web-paywall-worker","throughputRpm":9000,"errorRate":39.5,"p99Ms":8400}>>',
						'<<maple:service:{"name":"kafka-consumers-consumption-request","throughputRpm":48200,"errorRate":1.24,"p99Ms":6400}>>',
						'<<maple:service:{"name":"subscriptions-api","throughputRpm":2900000,"errorRate":0.89,"p99Ms":420}>>',
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
						"Everything downstream of them is holding:",
						"",
						"| Service | Errors | P95 | Change vs last hour |",
						"| --- | --- | --- | --- |",
						"| subs-writer | 0.00% | 180ms | flat |",
						"| entitlement-cache | 0.31% | 240ms | +0.1pp |",
						"| mmp-api | 0.12% | 95ms | flat |",
					].join("\n"),
				},
			],
		},
		// A chart turn: the streaming plot a ```chart fence becomes, over the same
		// incident the cards above describe.
		{
			id: "m4b",
			role: "assistant",
			createdAt: at(),
			parts: [
				{
					type: "text",
					state: "done",
					text: [
						"The failures start at 14:03 and hold — this is not a spike that recovered.",
						"",
						"```chart",
						JSON.stringify({
							type: "area",
							title: "web-paywall-worker errors per minute",
							unit: "number",
							data: ERRORS_PER_MINUTE,
						}),
						"```",
					].join("\n"),
				},
			],
		},
		{
			id: "m4c",
			role: "assistant",
			createdAt: at(),
			parts: [
				{
					type: "text",
					state: "done",
					text: [
						"They are concentrated in four operations:",
						"",
						"```chart",
						JSON.stringify({
							type: "ranked",
							title: "Failures by operation",
							unit: "number",
							data: [
								{ name: "GET /api/paywall/check", value: 14208 },
								{ name: "GET /api/paywall/bundle", value: 2611 },
								{ name: "POST /api/paywall/refresh", value: 1102 },
								{ name: "GET /api/paywall/trial", value: 501 },
							],
						}),
						"```",
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
				// Two delegations side by side, the pair that used to collapse into a `2 tools`
				// header: one still running (loader, activity verb, clock) and one answered.
				{
					type: "task",
					toolCallId: "t0",
					agent: "explore",
					prompt: 'Deep-dive the service "subscriptions-api": which operation regressed after the 14:20 deploy, and by how much?',
					status: "running",
					messages: [],
				},
				{
					type: "task",
					toolCallId: "t1",
					agent: "trace-analyst",
					prompt: "Find every trace where the entitlement lookup returned an empty body",
					status: "completed",
					answer:
						"212 traces hit the empty-body path, all of them on `web-paywall-worker`.\n\n" +
						"Every one carries `entitlement.cache_hit=false`, so the lookup is reaching the " +
						"upstream and getting a 204 back rather than falling back to the cached grant.",
					budgetExhausted: true,
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
		// A burst mid-flight: the group header is the turn's live line, so this is where the
		// running label, the done/total counter and the elapsed clock are eyeballed.
		{
			id: "m10",
			role: "assistant",
			createdAt: at(),
			parts: [
				{
					type: "dynamic-tool",
					toolCallId: "c6",
					toolName: "list_error_issues",
					state: "output-available",
					input: { service: "web-paywall-worker" },
					output: { text: "6 issues" },
				},
				{
					type: "dynamic-tool",
					toolCallId: "c7",
					toolName: "error_detail",
					state: "output-available",
					input: { issueId: "iss_41ba" },
					output: { text: "18422 events" },
				},
				{
					type: "dynamic-tool",
					toolCallId: "c8",
					toolName: "search_traces",
					state: "input-available",
					input: { service: "subscriptions-api", query: "entitlements" },
				},
			],
		},
	]
}
