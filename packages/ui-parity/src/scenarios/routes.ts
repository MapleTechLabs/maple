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
		route("sign-in", "Sign in (signed out)", "/sign-in", SIGNED_OUT_DATASET),
		// The one lab page that reads org data, so it lives here and not in the backend-free lab area.
		route("query-builder", "Lab: Query builder", "/lab/query-builder"),
	],
}
