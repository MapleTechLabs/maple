import { TextPart, ToolPart, type UIMessage } from "../page/chat/kit/ui-message"

// The chat lab fixture as Schema-typed messages: a merged tool run, a standalone call,
// prose with all four inline cards, a table, two charts, an approval, two sub-agents and a burst
// mid-flight. Inline cards are written the way the model emits them, so the real parser runs.

const text = (value: string) => TextPart.make({ text: value, state: "done" })

const tool = (
	toolCallId: string,
	toolName: string,
	state: ToolPart["state"],
	input: unknown,
	rest: { readonly output?: unknown; readonly errorText?: string } = {},
): ToolPart => ToolPart.make({ toolCallId, toolName, state, input, ...rest })

/** Eight minutes of the paywall worker's error count, ending at `nowMs` (the in-flight tail). */
const errorsPerMinute = (nowMs: number) =>
	[4, 6, 5, 31, 88, 140, 132, 96].map((value, index, all) => ({
		bucket: new Date(Math.floor(nowMs / 60_000 - (all.length - index)) * 60_000).toISOString(),
		series: { "web-paywall-worker": value },
	}))

const INCIDENT_TEXT = [
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
].join("\n")

const chartFence = (spec: unknown) => ["```chart", JSON.stringify(spec), "```"].join("\n")

export const buildChatLabMessages = (nowMs: number): ReadonlyArray<UIMessage> => {
	// A fixed clock walked forward a minute per turn, so the footer's timestamp is exercised.
	const at = (turn: number) => Date.UTC(2026, 8, 11, 14, 3) + turn * 60_000
	return [
		{
			id: "m1",
			role: "user",
			createdAt: at(1),
			parts: [text("Which services are unhealthy right now?")],
		},
		{
			id: "m2",
			role: "assistant",
			createdAt: at(2),
			parts: [
				tool(
					"c1",
					"list_services",
					"output-available",
					{ limit: 50 },
					{ output: { text: "18 services" } },
				),
			],
		},
		{
			id: "m3",
			role: "assistant",
			createdAt: at(3),
			parts: [
				tool(
					"c2",
					"find_errors",
					"output-available",
					{ service: "web-paywall-worker" },
					{ output: { text: "4 fingerprints" } },
				),
				tool(
					"c3",
					"find_slow_traces",
					"output-available",
					{ service: "subscriptions-api", limit: 5 },
					{ output: { text: "5 traces" } },
				),
			],
		},
		{
			id: "m3b",
			role: "assistant",
			createdAt: at(4),
			parts: [
				text(
					"The paywall worker looks worst — pulling its slowest traces before I say anything about the other two.",
				),
				tool(
					"c3b",
					"inspect_trace",
					"output-available",
					{ traceId: "9f2c7ae41b6d5c08f31a" },
					{ output: { text: "37 spans" } },
				),
				text("That trace spends 6.1s of its 8.4s inside the entitlement lookup."),
			],
		},
		{ id: "m4", role: "assistant", createdAt: at(5), parts: [text(INCIDENT_TEXT)] },
		{
			id: "m4b",
			role: "assistant",
			createdAt: at(6),
			parts: [
				text(
					[
						"The failures start at 14:03 and hold — this is not a spike that recovered.",
						"",
						chartFence({
							type: "area",
							title: "web-paywall-worker errors per minute",
							unit: "number",
							data: errorsPerMinute(nowMs),
						}),
					].join("\n"),
				),
			],
		},
		{
			id: "m4c",
			role: "assistant",
			createdAt: at(7),
			parts: [
				text(
					[
						"They are concentrated in four operations:",
						"",
						chartFence({
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
					].join("\n"),
				),
			],
		},
		{ id: "m5", role: "user", createdAt: at(8), parts: [text(":D")] },
		{
			id: "m6",
			role: "assistant",
			createdAt: at(9),
			parts: [
				text(
					"Glad someone's in a good mood — the paywall worker isn't. Let me know if you want to dig into any of those failing services.",
				),
			],
		},
		{ id: "m7", role: "user", createdAt: at(10), parts: [text("yeah, mute it for an hour")] },
		{
			id: "m8",
			role: "assistant",
			createdAt: at(11),
			parts: [
				tool("c4", "update_alert_rule", "proposed", {
					ruleId: "rule_9182",
					muteUntil: "2026-09-11T18:00:00Z",
				}),
			],
		},
		{
			id: "m9",
			role: "assistant",
			parts: [
				{
					_tag: "task",
					toolCallId: "t0",
					agent: "explore",
					prompt: 'Deep-dive the service "subscriptions-api": which operation regressed after the 14:20 deploy, and by how much?',
					status: "running",
					messages: [],
				},
				{
					_tag: "task",
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
								tool(
									"t1-c1",
									"search_traces",
									"output-available",
									{ service: "web-paywall-worker" },
									{ output: { text: "212 traces" } },
								),
							],
						},
					],
				},
				tool(
					"c5",
					"run_sql",
					"output-error",
					{ sql: "SELECT count() FROM spans WHERE ServiceName = 'web-paywall-worker'" },
					{ errorText: "Raw SQL is not enabled for this organization." },
				),
			],
		},
		{
			id: "m10",
			role: "assistant",
			createdAt: at(12),
			parts: [
				tool(
					"c6",
					"list_error_issues",
					"output-available",
					{ service: "web-paywall-worker" },
					{ output: { text: "6 issues" } },
				),
				tool(
					"c7",
					"error_detail",
					"output-available",
					{ issueId: "iss_41ba" },
					{ output: { text: "18422 events" } },
				),
				tool("c8", "search_traces", "input-available", {
					service: "subscriptions-api",
					query: "entitlements",
				}),
			],
		},
	]
}
