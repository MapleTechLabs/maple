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
} as const satisfies Record<string, ReadonlyArray<IntegrationFeatureSpec>>

export type IntegrationWithFeatures = keyof typeof INTEGRATION_FEATURES
export type IntegrationFeatureId<I extends IntegrationWithFeatures> =
	(typeof INTEGRATION_FEATURES)[I][number]["id"]
