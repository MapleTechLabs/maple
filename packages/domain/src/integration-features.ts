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
} as const satisfies Record<string, ReadonlyArray<IntegrationFeatureSpec>>

export type IntegrationWithFeatures = keyof typeof INTEGRATION_FEATURES
export type IntegrationFeatureId<I extends IntegrationWithFeatures> =
	(typeof INTEGRATION_FEATURES)[I][number]["id"]
