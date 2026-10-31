import { Effect, Option } from "effect"
import { fromString } from "foldkit/url"
import { describe, expect, test, vi } from "vitest"

// The shell's favorites listener targets `window` at import; nothing here touches it.
vi.hoisted(() => Object.assign(globalThis, { window: new EventTarget() }))
import { AppRoute, urlToAppRoute } from "../route"
import { pageCode, pageCodeIdOf, startRoutePageCode } from "./code"
import { loadPageCode, pages, unloadedPageOf } from "./registry"

const routeOf = (href: string): AppRoute =>
	urlToAppRoute(Option.getOrThrow(fromString(`http://maple.test${href}`)))

const pathOf = (href: string) => href.split("?")[0] ?? href

/** One URL per page route, with the route tag the app's parser gives it. */
const samples: ReadonlyArray<readonly [string, AppRoute["_tag"]]> = [
	["/", "Home"],
	["/account", "Account"],
	["/integrations", "Integrations"],
	["/mcp", "Mcp"],
	["/service-map", "ServiceMap"],
	["/settings", "Settings"],
	["/sources", "Sources"],
	["/sources/new", "SourcesNew"],
	["/sources/x-1", "Source"],
	["/agent-sessions/x-1", "AgentSession"],
	["/alerts/0b1e6a1c-8a5a-4c3e-9a51-1d2e3f4a5b6c", "AlertRule"],
	["/alerts/create", "AlertsCreate"],
	["/alerts/uptime/new", "AlertsUptimeNew"],
	["/alerts/uptime/x-1", "AlertsUptimeMonitor"],
	["/settings/ingestion/rules/new", "IngestRuleNew"],
	["/settings/ingestion/rules/rule-1", "IngestRule"],
	["/anomalies/0b1e6a1c-8a5a-4c3e-9a51-1d2e3f4a5b6c", "Anomaly"],
	["/code-review/ci", "CodeReviewCi"],
	["/code-review/issues", "CodeReviewIssues"],
	["/code-review/pull-requests", "CodeReviewPullRequests"],
	["/code-review/settings", "CodeReviewSettings"],
	["/security", "Security"],
	["/security/findings", "SecurityFindings"],
	["/security/runs", "SecurityRuns"],
	["/security/runs/run-1", "SecurityRun"],
	["/security/findings/0b1e6a1c-8a5a-4c3e-9a51-1d2e3f4a5b6c/x-1", "SecurityFinding"],
	["/dashboards/0b1e6a1c-8a5a-4c3e-9a51-1d2e3f4a5b6c", "Dashboard"],
	["/dashboards/templates", "DashboardsTemplates"],
	["/investigations/x-1", "Investigation"],
	["/logs/x-1", "Log"],
	["/metrics/x-1", "Metric"],
	["/recommendations/x-1", "Recommendation"],
	["/releases/x-1", "Release"],
	["/replays/x-1", "Replay"],
	["/services/x-1", "Service"],
	["/share/x-1", "Share"],
	["/traces/x-1", "Trace"],
	["/agent-sessions", "AgentSessions"],
	["/alerts", "Alerts"],
	["/analytics", "Analytics"],
	["/anomalies", "Anomalies"],
	["/code-review", "CodeReview"],
	["/dashboards", "Dashboards"],
	["/errors", "Errors"],
	["/infra", "Infra"],
	["/investigations", "Investigations"],
	["/logs", "Logs"],
	["/metrics", "Metrics"],
	["/releases", "Releases"],
	["/replays", "Replays"],
	["/services", "Services"],
	["/traces", "Traces"],
	["/agent-sessions/tools/x-1", "AgentSessionTool"],
	["/alerts/incidents/inc-1", "AlertIncident"],
	["/errors/issues/0b1e6a1c-8a5a-4c3e-9a51-1d2e3f4a5b6c", "ErrorIssue"],
	["/infra/cloudflare/x-1", "InfraCloudflareZone"],
	["/infra/containers/x-1", "InfraContainer"],
	["/infra/hosts/x-1", "InfraHost"],
	["/infra/planetscale/x-1", "InfraPlanetscaleDatabase"],
	["/infra/railway/x-1?environmentId=%22env-1%22", "InfraRailwayService"],
	["/infra/supabase/x-1", "InfraSupabaseProject"],
	["/agent-sessions/tools", "AgentSessionTools"],
	["/infra/cloudflare", "InfraCloudflare"],
	["/infra/containers", "InfraContainers"],
	["/infra/aws", "InfraAws"],
	["/infra/gcp", "InfraGcp"],
	["/infra/hosts", "InfraHosts"],
	["/infra/planetscale", "InfraPlanetscale"],
	["/infra/railway", "InfraRailway"],
	["/infra/supabase", "InfraSupabase"],
	["/dashboards/0b1e6a1c-8a5a-4c3e-9a51-1d2e3f4a5b6c/widgets/x-1", "DashboardWidget"],
	["/infra/cloudflare/workers/x-1", "InfraCloudflareWorker"],
	["/infra/aws/deployment/x-1/y-2", "InfraAwsResource"],
	["/infra/gcp/x-1/x-1", "InfraGcpResource"],
	["/infra/kubernetes/nodes/x-1", "InfraKubernetesNode"],
	["/infra/kubernetes/pods/x-1", "InfraKubernetesPod"],
	["/infra/kubernetes/services/x-1", "InfraKubernetesService"],
	["/infra/kubernetes/nodes", "InfraKubernetesNodes"],
	["/infra/kubernetes/pods", "InfraKubernetesPods"],
	["/infra/kubernetes/services", "InfraKubernetesServices"],
	["/infra/kubernetes/workloads", "InfraKubernetesWorkloads"],
	["/infra/kubernetes/workloads/deployment/x-1", "InfraKubernetesWorkload"],
]

describe("boot page code", () => {
	test("each page route's path names the page the registry renders it with", () => {
		samples.forEach(([href, tag]) => {
			const route = routeOf(href)
			expect(route._tag, href).toBe(tag)
			expect(pageCodeIdOf(pathOf(href)), href).toBe(Option.getOrUndefined(unloadedPageOf(route)))
		})
	})

	test("every page has a boot path", () => {
		const covered = new Set<string | undefined>(samples.map(([href]) => pageCodeIdOf(pathOf(href))))
		expect(Object.keys(pageCode).filter((id) => !covered.has(id))).toEqual([])
	})

	test("paths without a page start nothing", () => {
		expect(pageCodeIdOf("/sign-in")).toBeUndefined()
		expect(pageCodeIdOf("/lab/buttons")).toBeUndefined()
		expect(pageCodeIdOf("/traces/a/b")).toBeUndefined()
	})

	test("every registry page loads through its shared import", () => {
		pages.forEach((page) => expect(page.loadModule, page.id).toBe(pageCode[page.id]))
	})

	test("the registry's load reuses the import boot.ts started", async () => {
		const started = pageCode.TracesList()
		startRoutePageCode("/traces")
		expect(pageCode.TracesList()).toBe(started)
		expect(unloadedPageOf(routeOf("/traces"))).toEqual(Option.some("TracesList"))
		await Effect.runPromise(loadPageCode("TracesList"))
		expect(unloadedPageOf(routeOf("/traces"))).toEqual(Option.none())
		expect(pageCode.TracesList()).toBe(started)
	})
})
