import type { AreaModule, Scenario } from "./types.ts"

/**
 * Core app routes on the `default` dataset. They need the fixture backend: without it every API
 * call is unmocked and the variant fails, which is expected until `src/backend` lands.
 */
const route = (id: string, title: string, path: string, dataset = "default"): Scenario => ({
	id: `route-${id}`,
	title,
	path,
	dataset,
	viewports: ["desktop"],
	themes: ["light", "dark"],
	area: "routes",
})

/** A dataset whose `identity` is `null`; the fixture backend owns the name. */
export const SIGNED_OUT_DATASET = "signed-out"
/** A signed-in org with no telemetry, dashboards or alerts. */
export const EMPTY_DATASET = "empty"

/**
 * Seeded `default` ids (src/fixtures, kept out of the capture side's imports): the newest
 * payment-svc pool-timeout trace, and the first error issue (`fixtureUuid(4, 1)`).
 */
const ERROR_TRACE_ID = "6843a8853182b32339b2dd5120d423f2"
const TRIAGE_ISSUE_ID = "0199a004-0000-7000-8000-000000000001"

export const routesArea: AreaModule = {
	area: "routes",
	scenarios: [
		route("overview", "Overview", "/"),
		route("services", "Services", "/services"),
		route("traces", "Traces", "/traces"),
		route("logs", "Logs", "/logs"),
		route("errors", "Errors", "/errors"),
		route("alerts", "Alerts", "/alerts"),
		route("dashboards", "Dashboards", "/dashboards"),
		route("settings", "Settings", "/settings"),
		route("service-map", "Service map", "/service-map"),
		route("service-detail", "Service detail: payment-svc", "/services/payment-svc"),
		route("trace-detail", "Trace detail: payment timeout", `/traces/${ERROR_TRACE_ID}`),
		route("metrics", "Metrics", "/metrics"),
		route("infra", "Infrastructure", "/infra"),
		route("error-issue", "Error issue: pool timeout", `/errors/issues/${TRIAGE_ISSUE_ID}`),
		route("overview-empty", "Overview (empty org)", "/", EMPTY_DATASET),
		route("services-empty", "Services (empty org)", "/services", EMPTY_DATASET),
		route("traces-empty", "Traces (empty org)", "/traces", EMPTY_DATASET),
		route("sign-in", "Sign in (signed out)", "/sign-in", SIGNED_OUT_DATASET),
		// The one lab page that reads org data, so it lives here and not in the backend-free lab area.
		route("query-builder", "Lab: Query builder", "/lab/query-builder"),
	],
}
