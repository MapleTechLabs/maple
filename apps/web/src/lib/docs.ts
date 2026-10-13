/**
 * Every docs page the app links to from an empty state, as a path under maple.dev. One table so
 * `docs.test.ts` can resolve each path against the landing content collection: a renamed doc then
 * fails in the PR that renames it instead of rotting into a 404.
 */
export const DOCS = {
	instrumentation: "/docs/instrumentation",
	quickstart: "/docs/getting-started/quickstart",
	otelConventions: "/docs/concepts/otel-conventions",
	retention: "/docs/reference/retention",
	traces: "/docs/explore/traces",
	logs: "/docs/explore/logs",
	metrics: "/docs/explore/metrics",
	services: "/docs/explore/services",
	serviceMap: "/docs/explore/service-map",
	errors: "/docs/errors/overview",
	sessionReplay: "/docs/session-replay/replays",
	browserSdk: "/docs/session-replay/browser-sdk",
	productEventsApi: "/docs/product-events/api",
	webAnalytics: "/docs/product-events/web-analytics",
	agentSessions: "/docs/agent-sessions/overview",
	aiAgents: "/docs/getting-started/ai-agents",
	mcp: "/docs/reference/mcp",
	alertRules: "/docs/alerting/alert-rules",
	incidents: "/docs/alerting/incidents",
	destinations: "/docs/alerting/notification-destinations",
	dashboards: "/docs/dashboards/build-dashboards",
	embedCharts: "/docs/dashboards/embed-charts",
	apiReference: "/docs/reference/api",
	authentication: "/docs/reference/authentication",
	hosts: "/docs/infrastructure/hosts",
	docker: "/docs/infrastructure/docker",
	kubernetes: "/docs/infrastructure/kubernetes",
	cloudflare: "/docs/integrations/cloudflare",
	planetscale: "/docs/integrations/planetscale",
	prometheus: "/docs/integrations/prometheus",
	warpstream: "/docs/integrations/warpstream",
	github: "/docs/integrations/github",
	slack: "/docs/integrations/slack",
} as const

export type DocsPage = keyof typeof DOCS

const DOCS_ORIGIN = "https://maple.dev"

export function docsUrl(page: DocsPage): string {
	return `${DOCS_ORIGIN}${DOCS[page]}`
}
