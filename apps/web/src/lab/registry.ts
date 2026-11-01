/**
 * The catalogue of dev-only lab surfaces under `/lab`.
 *
 * Two families live here: **labs** are visual galleries that render a component
 * family over fixture data (widgets, provenance nodes, trace views), **benches**
 * are synthetic perf harnesses. Each has a lazy module in `entries/`, so none of
 * them reaches the startup bundle.
 *
 * `registry.test.ts` asserts this list and `entries/` agree, so adding an entry
 * module without a line here fails the test rather than silently missing from
 * the `/lab` index page.
 */
export const LAB_ROOT = "/lab"

export type LabPath = `${typeof LAB_ROOT}/${string}`

export interface LabEntry {
	path: LabPath
	title: string
	description: string
	/** Gallery of a component family (`lab`) or a perf harness (`bench`). */
	kind: "lab" | "bench"
	/**
	 * `none`: renders from fixtures with no API and no session, so the auth gate
	 * lets it through. `required`: reads real org data and goes through sign-in.
	 */
	session: "none" | "required"
}

export const LAB_ENTRIES: ReadonlyArray<LabEntry> = [
	{
		path: "/lab/infra",
		title: "Infrastructure",
		description:
			"The infra overview, hosts list and Railway list over fixture rows, no warehouse needed.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/cloudflare",
		title: "Cloudflare",
		description:
			"The Cloudflare zone and Worker lists and the zone page, whole, over a copy of production data.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/uptime",
		title: "Uptime monitor",
		description:
			"An HTTP monitor's response time, phase breakdown and every-check charts over a fixture shaped like production checks.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/billing-orgs",
		title: "Billing orgs",
		description:
			"The Billing tab for a member org, a billing org with members, and a standalone org linking to another (`?state=`).",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/gcp",
		title: "Google Cloud log filter",
		description:
			"The Google Cloud configuration's Log filter for a new connection and an existing sink, with what each choice asks the setup script for.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/gcp-connect",
		title: "Google Cloud connect",
		description:
			"Every step and run state of the Google Cloud connect dialog over fixture connectors, no API needed.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/gcp-connections",
		title: "Google Cloud connections",
		description:
			"A Google Cloud connection in each state, healthy to failing, over fixture connectors, no API needed.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/gcp-infra",
		title: "Google Cloud infrastructure",
		description:
			"The Google Cloud list (services, Pub/Sub, Cloud SQL) over fixtures that reproduce the Paper artboards: three projects, problems first.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/gcp-workload",
		title: "Google Cloud workload",
		description:
			"The Google Cloud workload page, whole, over fixture series: a Cloud Run 5xx burst at peak instances and a Cloud SQL instance.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/onboarding",
		title: "Onboarding",
		description:
			"Click through onboarding with simulated plan selection and a restart button. No account changes.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/onboarding-checklist",
		title: "Onboarding checklist",
		description:
			"The top bar's credits pill and its checklist panel in progress, claimable and claimed, over fixtures.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/loaders",
		title: "Chat loaders",
		description:
			"Every dot-matrix loader in the chat's pool, inline at both sizes it is used at, against real text.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/crash",
		title: "Crash page",
		description:
			"A button that crashes a real Foldkit program, so the crash page renders the way it does when the app dies.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/gcp-dashboard",
		title: "Google Cloud dashboard",
		description:
			"The Google Cloud template as a board: tabs, Project / Region / Workload filters over fixture series, and the variables dialog.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/widgets",
		title: "Widgets",
		description:
			"Every dashboard widget renderer over its bundled sample data: the fastest way to eyeball a chart change without a backend.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/nodes",
		title: "Provenance nodes",
		description: "Every provenance-canvas node and edge state, in the production renderer, at 1:1.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/timeline",
		title: "Trace timeline",
		description:
			"The trace view tabs over a synthetic trace with a wide dynamic range: a 2s root down to sub-millisecond spans that only resolve at deep zoom, with span event markers and the events panel.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/agent-session",
		title: "Agent session detail",
		description:
			"The session detail page's Overview, Trace and Flow views over a fourteen-turn fixture that ends in a context-window failure.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/verdict",
		title: "Investigation verdict",
		description:
			"The verdict card and the run-progress feed in every state: diagnosed, headline-less, running, stalled, pre-first-step, inconclusive, failed.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/flow",
		title: "Trace flow",
		description:
			"One synthetic trace exercising every Flow view card variant: server, edge, HTTP client, db, cache hit/miss, messaging, orphan.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/service-map-3d",
		title: "Service map 3D",
		description:
			"Two 3D perspectives over one sample topology: Atlas groups infrastructure by namespace; Cascade follows dependency depth.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/agent-sessions",
		title: "Agent sessions list",
		description:
			"The `/agent-sessions` list over rows that break its lanes: a nameless session, an unidentified vendor, ms next to hours, a total with no buckets, no usage at all, both kinds of failure.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/replays",
		title: "Session replays list",
		description:
			"The `/replays` list over a day of mostly bots, bounces and idle tabs, with an errored bot and a live bounce that must not fold into a low-signal run.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/agent-tools",
		title: "Agent tools",
		description:
			"The `/agent-sessions/tools` page over a synthetic week: a dominant tool that never fails, one that fails half the time, a p95 thirty times its p50, and a tool that regresses through the back half of the window.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/mcp",
		title: "MCP hub",
		description:
			"The MCP hub over maple-ai's spec spans from Nov 1, 2026: the server list, a server's overview, the run_sql tool page, the service page's MCP tab, and the empty, loading, error and quiet states (?view=list|server|tool|service|empty|loading|error|quiet).",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/logs",
		title: "Logs stream",
		description:
			"The `/logs` stream over a production-like fixture: access lines, slow queries, a payment outage with stack traces, JSON bodies. Toggles for wrap, density, search and pinned columns.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/code-review-repos",
		title: "Code review repositories",
		description: "The code review repository picker over 246 fixture repositories.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/code-review-team",
		title: "Code review team",
		description:
			"The Code Review Team tab over a month of a seven-person fixture team: KPIs, highlights, the scorecard against the team median and the Ranked view.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/service-api",
		title: "Service API tab",
		description:
			"The service page's API tab over 12 hours of the ingest service: KPI strip, responses by status, the non-2xx breakdown, the endpoint table and its drawer (?endpoint=POST%20/v1/traces).",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/service-runtimes",
		title: "Service runtimes",
		description:
			"The service page for fleet-api, a Google Cloud Run service with no Kubernetes workloads, over one hour; ?tab=operations or ?tab=dependencies opens that tab.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/service-map-runtimes",
		title: "Service map runtimes",
		description:
			"The service map over a small fleet topology with fleet-api (Cloud Run) selected; ?tab=infrastructure opens the panel's Infrastructure tab.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/aws",
		title: "AWS infrastructure",
		description:
			"The AWS list over one account: four ECS services (two idle), two EC2 instances and two load balancers, none traced. Pick a tab with ?tab=ec2 or ?tab=loadBalancers.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/security",
		title: "Security Center",
		description:
			"Every Security Center page over fixtures: overview, empty, not enabled, Add target and its errors, findings, runs, a live, incomplete, failed and cancelled run, a finding and its triage, the admins-only states, and the telemetry tabs (exposure, exposure-empty, runtimes). Pick one with ?state=.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/errors",
		title: "Errors list",
		description:
			"The `/errors` list over a fixture holding every row state at once: surging critical with an open incident, live and diagnosed investigations, a truncating message, a fingerprint gone quiet, an unset severity.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/alerts",
		title: "Alerts",
		description:
			"The `/alerts` Inbox, Rules and Routing tabs and the incident page over one fixture org: two firing, one held, four blind spots, a delivery retry and a diagnosed investigation.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/worst-case",
		title: "Worst case",
		description:
			"Existing components over worst-case fixture data (long names, extreme numbers, unbroken URLs, 8KB messages) behind a Demo data / Worst case toggle, for before and after screenshots.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/time-range",
		title: "Time range picker",
		description:
			"The header time range picker over local state, with the timezone selector and a strip of timestamps that re-render in the chosen zone.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/kit/buttons",
		title: "Kit: buttons",
		description:
			"Every @maple/ui button variant and size, icon buttons, toggles, toggle groups, copy and refresh buttons, filter chips, badges, status dots, kbd and inline code.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/kit/forms",
		title: "Kit: forms",
		description:
			"Inputs in every size and state, textarea, input group, field with description and error, checkbox, radio, switch, native select, closed pickers and the OTP field.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/kit/overlays",
		title: "Kit: overlays",
		description:
			"One @maple/ui overlay rendered open per ?item= (dialog, sheet, menus, popovers, pickers, command palette, each toast type).",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/kit/display",
		title: "Kit: display",
		description:
			"Cards, panels, alerts, empty states, items, list rows, key values, meters, stat figures, skeletons, tables, tabs and separators.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/kit/content",
		title: "Kit: content",
		description:
			"Page header, eyebrow, breadcrumb, avatar, spinner, marker, message, bubble, trace, truncation, setting rows, scroll area and calendar.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/kit/navigation",
		title: "Kit: navigation",
		description:
			"The sidebar expanded and collapsed with groups, badges and sub menus, resizable panels and the navigation menu.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/query-builder",
		title: "Query builder",
		description: "MVP query builder against real warehouse data for the signed-in org.",
		kind: "lab",
		session: "required",
	},
	{
		path: "/lab/bench/service-map",
		title: "Service map",
		description:
			"Synthetic topology at configurable size (?services=&edges=&rps=&seed=&groups=) with a window.__smBench FPS harness.",
		kind: "bench",
		session: "none",
	},
	{
		path: "/lab/bench/service-detail",
		title: "Service detail charts",
		description:
			"The service-detail MetricsGrid with synthetic rows; ?mode=recharts|cursor picks the sync strategy.",
		kind: "bench",
		session: "none",
	},
	{
		path: "/lab/bench/infra",
		title: "Infra charts",
		description: "Host and k8s detail ChartViews on one page with synthetic rows; ?mode=recharts|cursor.",
		kind: "bench",
		session: "none",
	},
	{
		path: "/lab/bench/agent-transcript",
		title: "Agent transcript",
		description:
			"The session Transcript view over a synthetic session of `?turns=` turns (default 40) whose tool results run to hundreds of kilobytes: row mount cost and scroll perf, via window.__transcriptBench.",
		kind: "bench",
		session: "none",
	},
	{
		path: "/lab/bench/logs",
		title: "Logs table",
		description: "The real LogsTableView over 2,000 synthetic rows × 12 chips: hover and scroll perf.",
		kind: "bench",
		session: "none",
	},
	{
		path: "/lab/bench/overview",
		title: "Overview charts",
		description:
			"Service-detail chart bench pinned to cursor sync: the cross-browser gate's overview scenario.",
		kind: "bench",
		session: "none",
	},
	{
		path: "/lab/bench/dashboard-grid",
		title: "Dashboard grid",
		description:
			"A `?n=`-widget dashboard (default 50) in edit mode for drag, resize and mount timing via window.__dashboardGridBench.",
		kind: "bench",
		session: "none",
	},
	{
		path: "/lab/charts",
		title: "TanStack charts",
		description:
			"Production charts beside their TanStack counterparts over identical rows; ?renderer=tanstack-svg|tanstack-canvas.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/bench/tanstack",
		title: "TanStack Charts pilot",
		description:
			"The three overview charts off identical rows; ?renderer=recharts|tanstack-svg|tanstack-canvas.",
		kind: "bench",
		session: "none",
	},
]

/** Anything under the `/lab` tree, index included. */
export function isLabPath(pathname: string): boolean {
	return pathname === LAB_ROOT || pathname.startsWith(`${LAB_ROOT}/`)
}

/**
 * Lab surfaces that render without a session: the index plus every entry
 * marked `session: "none"`. Used by the auth and plan gates.
 */
export function isSessionlessLabPath(pathname: string): boolean {
	if (pathname === LAB_ROOT || pathname === `${LAB_ROOT}/`) return true
	return LAB_ENTRIES.some((entry) => entry.session === "none" && entry.path === pathname)
}
