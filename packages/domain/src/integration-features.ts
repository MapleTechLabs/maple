// What each integration can do, as switches a person turns on or off when connecting and later.
// Copy and defaults live here so the dashboard, CLI and MCP describe a feature the same way.
// Each switch is stored by the integration that owns it (its own columns and endpoints).

/** What a feature brings into Maple. */
export type IntegrationFeatureSignal = "logs" | "traces" | "metrics" | "events" | "actions"

/**
 * How a switch takes effect: `instant` is read by the next poll, `provisions` creates or removes
 * something at the vendor (a drain, a webhook), `setupUpdate` needs the customer's setup redeployed.
 */
export type IntegrationFeatureApply = "instant" | "provisions" | "setupUpdate"

export interface IntegrationFeatureSpec<Id extends string = string> {
	readonly id: Id
	readonly title: string
	readonly summary: string
	readonly signal: IntegrationFeatureSignal
	readonly defaultEnabled: boolean
	/** Data it brings counts toward the org's ingest. */
	readonly countsTowardIngest: boolean
	readonly apply: IntegrationFeatureApply
}

const feature = <const Id extends string>(spec: IntegrationFeatureSpec<Id>) => spec

export const INTEGRATION_FEATURES = {
	supabase: [
		feature({
			id: "metrics",
			title: "Metrics and Postgres health",
			summary:
				"Database, connection and resource metrics from each project's metrics endpoint, read every minute.",
			signal: "metrics",
			defaultEnabled: true,
			countsTowardIngest: true,
			apply: "instant",
		}),
		feature({
			id: "logs",
			title: "Logs, polled",
			summary:
				"Postgres, API, Auth, Storage, Realtime and Edge Function logs, read every minute through your grant.",
			signal: "logs",
			defaultEnabled: false,
			countsTowardIngest: true,
			apply: "instant",
		}),
		feature({
			id: "logDrain",
			title: "Log drain",
			summary:
				"Supabase pushes the same logs to Maple instead of polling. Needs a Pro plan; Supabase bills each drain.",
			signal: "logs",
			defaultEnabled: false,
			countsTowardIngest: true,
			apply: "provisions",
		}),
	],
	gcp: [
		feature({
			id: "logs",
			title: "Log forwarding",
			summary:
				"Request and managed-service logs, through a Log Router sink and Pub/Sub. Admin activity goes to the Security audit log.",
			signal: "logs",
			defaultEnabled: true,
			countsTowardIngest: true,
			apply: "setupUpdate",
		}),
		feature({
			id: "metrics",
			title: "Metrics and resources",
			summary:
				"Cloud Run, GKE, Compute Engine, Cloud SQL, Pub/Sub, Load Balancing and Cloud Functions. Read-only, every 5 minutes.",
			signal: "metrics",
			defaultEnabled: false,
			countsTowardIngest: true,
			apply: "setupUpdate",
		}),
	],
	github: [
		feature({
			id: "ciTraces",
			title: "CI traces and logs",
			summary:
				"Each finished GitHub Actions run becomes a trace under the github-actions service, with a span per job and step, and each job's log lines up to 5 MB.",
			signal: "traces",
			defaultEnabled: true,
			countsTowardIngest: true,
			apply: "instant",
		}),
		feature({
			id: "auditLog",
			title: "Audit log",
			summary:
				"Members, repositories, protections, force pushes and more, as admin-only entries in the Security audit log. Pick the categories under the switch.",
			signal: "events",
			defaultEnabled: true,
			countsTowardIngest: false,
			apply: "instant",
		}),
		feature({
			id: "prReview",
			title: "Pull request reviews",
			summary:
				"Maple reviews pull requests on the repositories you pick, with your rules and model. Set per repository.",
			signal: "actions",
			defaultEnabled: false,
			countsTowardIngest: false,
			apply: "instant",
		}),
	],
	vercel: [
		feature({
			id: "logs",
			title: "Logs",
			summary: "Requests, functions, edge middleware and builds, with status, path and cache result.",
			signal: "logs",
			defaultEnabled: true,
			countsTowardIngest: true,
			apply: "provisions",
		}),
		feature({
			id: "traces",
			title: "Traces",
			summary: "Deployment traces from Vercel and @vercel/otel.",
			signal: "traces",
			defaultEnabled: true,
			countsTowardIngest: true,
			apply: "provisions",
		}),
		feature({
			id: "aiGateway",
			title: "AI Gateway",
			summary:
				"Model usage and cost from Vercel AI Gateway: every request with its model, tokens and cost.",
			signal: "events",
			defaultEnabled: true,
			countsTowardIngest: true,
			apply: "provisions",
		}),
		feature({
			id: "speedInsights",
			title: "Speed Insights",
			summary:
				"Core Web Vitals (LCP, INP, CLS, FCP, TTFB) from real visits. Needs Speed Insights Plus on the project.",
			signal: "metrics",
			defaultEnabled: false,
			countsTowardIngest: true,
			apply: "provisions",
		}),
		feature({
			id: "webAnalytics",
			title: "Web Analytics",
			summary:
				"Page views and custom events. Needs Web Analytics on the project; Vercel bills each event.",
			signal: "events",
			defaultEnabled: false,
			countsTowardIngest: true,
			apply: "provisions",
		}),
		feature({
			id: "auditLog",
			title: "Audit log",
			summary:
				"Who changed what on the team, whatever projects you pick. Shown in the Security audit log to org admins. Enterprise plan only.",
			signal: "events",
			defaultEnabled: false,
			countsTowardIngest: true,
			apply: "provisions",
		}),
	],
	cloudflare: [
		feature({
			id: "httpTraffic",
			title: "HTTP traffic",
			summary:
				"Requests, bandwidth, cache and status codes per zone, with top paths, countries and clients, and edge latency where the plan has it.",
			signal: "metrics",
			defaultEnabled: true,
			countsTowardIngest: true,
			apply: "instant",
		}),
		feature({
			id: "firewall",
			title: "Security events",
			summary: "WAF and firewall actions per zone, by rule, source and host.",
			signal: "metrics",
			defaultEnabled: true,
			countsTowardIngest: true,
			apply: "instant",
		}),
		feature({
			id: "dns",
			title: "DNS queries",
			summary: "DNS query counts per zone, by name and response code. Zones on Cloudflare DNS only.",
			signal: "metrics",
			defaultEnabled: true,
			countsTowardIngest: true,
			apply: "instant",
		}),
		feature({
			id: "workers",
			title: "Workers",
			summary: "Requests, errors, CPU time and duration for each Worker script.",
			signal: "metrics",
			defaultEnabled: true,
			countsTowardIngest: true,
			apply: "instant",
		}),
		feature({
			id: "queues",
			title: "Queues",
			summary: "Backlog depth and consumer concurrency for each queue.",
			signal: "metrics",
			defaultEnabled: true,
			countsTowardIngest: true,
			apply: "instant",
		}),
		feature({
			id: "durableObjects",
			title: "Durable Objects",
			summary: "Requests, errors and wall time for each Durable Object namespace.",
			signal: "metrics",
			defaultEnabled: true,
			countsTowardIngest: true,
			apply: "instant",
		}),
	],
	planetscale: [
		feature({
			id: "metrics",
			title: "Branch metrics",
			summary: "CPU, memory, storage, connections and replica lag for every branch.",
			signal: "metrics",
			defaultEnabled: true,
			countsTowardIngest: true,
			apply: "instant",
		}),
		feature({
			id: "events",
			title: "Events",
			summary:
				"Deploy requests and branch changes on the timeline. Maple adds a webhook to each database for them.",
			signal: "events",
			defaultEnabled: true,
			countsTowardIngest: false,
			apply: "provisions",
		}),
	],
	linear: [
		feature({
			id: "openIssues",
			title: "Open issues",
			summary:
				"When an alert fires and its Linear destination has no open issue for it, Maple opens one in the destination's team.",
			signal: "actions",
			defaultEnabled: true,
			countsTowardIngest: false,
			apply: "instant",
		}),
		feature({
			id: "updateComments",
			title: "Comment on updates",
			summary: "Comments on the open issue when the alert fires again or its severity changes.",
			signal: "actions",
			defaultEnabled: true,
			countsTowardIngest: false,
			apply: "instant",
		}),
		feature({
			id: "reopenIssues",
			title: "Reopen closed issues",
			summary:
				"Moves an issue closed in the last 24 hours back to Triage or Todo when its alert fires again. Off, Maple only comments on it.",
			signal: "actions",
			defaultEnabled: true,
			countsTowardIngest: false,
			apply: "instant",
		}),
		feature({
			id: "resolveComments",
			title: "Comment when resolved",
			summary:
				"Comments on the issue when the alert resolves. The issue stays open for your team to close.",
			signal: "actions",
			defaultEnabled: true,
			countsTowardIngest: false,
			apply: "instant",
		}),
	],
	chat: [
		feature({
			id: "alerts",
			title: "Alert notifications",
			summary: "Alerts post to the channels your alert destinations pick in this workspace.",
			signal: "actions",
			defaultEnabled: true,
			countsTowardIngest: false,
			apply: "instant",
		}),
		feature({
			id: "directMessages",
			title: "Direct-message paging",
			summary:
				"Escalation policies page people by direct message here when their chat account is linked. Off, they still get the email.",
			signal: "actions",
			defaultEnabled: true,
			countsTowardIngest: false,
			apply: "instant",
		}),
		feature({
			id: "assistant",
			title: "Answer questions",
			summary:
				"The Maple bot answers when someone mentions it, and follows up in the threads it started. Off, it stays quiet.",
			signal: "actions",
			defaultEnabled: true,
			countsTowardIngest: false,
			apply: "instant",
		}),
	],
} as const satisfies Record<string, ReadonlyArray<IntegrationFeatureSpec>>

export type IntegrationWithFeatures = keyof typeof INTEGRATION_FEATURES
export type IntegrationFeatureId<I extends IntegrationWithFeatures> =
	(typeof INTEGRATION_FEATURES)[I][number]["id"]
