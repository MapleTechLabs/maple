// In boot.ts's static graph, ahead of the app bundle: keep it free of imports.

/** A page's chunk import, started at most once; a failed one can be started again. */
const shared = <A>(load: () => Promise<A>): (() => Promise<A>) => {
	const started = new Map<typeof load, Promise<A>>()
	return () => {
		const loading =
			started.get(load) ??
			load().catch((cause: unknown) => {
				started.delete(load)
				return Promise.reject(cause)
			})
		started.set(load, loading)
		return loading
	}
}

/**
 * Every page's code, by page id. Each `index.ts` registers its own entry here, so boot.ts's early
 * start and the registry's `loadPageCode` share one import.
 */
export const pageCode = {
	Account: shared(() => import("./settings/account/implementation")),
	AgentSession: shared(() => import("./agent-sessions/session/implementation")),
	AgentSessionTool: shared(() => import("./agent-sessions/tool/implementation")),
	AgentSessionTools: shared(() => import("./agent-sessions/tools/implementation")),
	AgentSessionsList: shared(() => import("./agent-sessions/list/implementation")),
	AlertEditor: shared(() => import("./alerts/editor/implementation")),
	AlertIncident: shared(() => import("./alerts/incident/implementation")),
	AlertRule: shared(() => import("./alerts/rule/implementation")),
	AlertsHub: shared(() => import("./alerts/hub/implementation")),
	AlertsUptimeMonitor: shared(() => import("./alerts/uptime-monitor/implementation")),
	AlertsUptimeNew: shared(() => import("./alerts/uptime-form/implementation")),
	Analytics: shared(() => import("./analytics/implementation")),
	AnomaliesList: shared(() => import("./anomalies/list/implementation")),
	Anomaly: shared(() => import("./anomalies/detail/implementation")),
	CodeReview: shared(() => import("./code-review/implementation")),
	DashboardTemplates: shared(() => import("./dashboards/templates/implementation")),
	DashboardView: shared(() => import("./dashboards/view/implementation")),
	DashboardWidget: shared(() => import("./dashboards/widget/implementation")),
	DashboardsList: shared(() => import("./dashboards/list/implementation")),
	ErrorIssue: shared(() => import("./errors/issue/implementation")),
	ErrorsHub: shared(() => import("./errors/hub/implementation")),
	InfraAws: shared(() => import("./infra-integrations/aws/list/implementation")),
	InfraAwsResource: shared(() => import("./infra-integrations/aws/resource/implementation")),
	InfraCloudflare: shared(() => import("./infra-integrations/cloudflare/list/implementation")),
	InfraCloudflareWorker: shared(() => import("./infra-integrations/cloudflare/worker/implementation")),
	InfraCloudflareZone: shared(() => import("./infra-integrations/cloudflare/zone/implementation")),
	InfraContainer: shared(() => import("./infra/containers/detail/implementation")),
	InfraContainers: shared(() => import("./infra/containers/list/implementation")),
	InfraGcp: shared(() => import("./infra-integrations/gcp/list/implementation")),
	InfraGcpResource: shared(() => import("./infra-integrations/gcp/workload/implementation")),
	InfraHost: shared(() => import("./infra/hosts/detail/implementation")),
	InfraHosts: shared(() => import("./infra/hosts/list/implementation")),
	InfraKubernetesNode: shared(() => import("./infra/kubernetes/node/implementation")),
	InfraKubernetesNodes: shared(() => import("./infra/kubernetes/nodes/implementation")),
	InfraKubernetesPod: shared(() => import("./infra/kubernetes/pod/implementation")),
	InfraKubernetesPods: shared(() => import("./infra/kubernetes/pods/implementation")),
	InfraKubernetesServiceLens: shared(() => import("./infra/kubernetes/service/implementation")),
	InfraKubernetesWorkload: shared(() => import("./infra/kubernetes/workload/implementation")),
	InfraKubernetesWorkloads: shared(() => import("./infra/kubernetes/workloads/implementation")),
	InfraOverview: shared(() => import("./infra/overview/implementation")),
	InfraPlanetscale: shared(() => import("./infra-integrations/planetscale/list/implementation")),
	InfraPlanetscaleDatabase: shared(() => import("./infra-integrations/planetscale/db/implementation")),
	InfraRailway: shared(() => import("./infra-integrations/railway/list/implementation")),
	InfraRailwayService: shared(() => import("./infra-integrations/railway/service/implementation")),
	InfraSupabase: shared(() => import("./infra-integrations/supabase/list/implementation")),
	InfraSupabaseProject: shared(() => import("./infra-integrations/supabase/project/implementation")),
	IngestRuleEditor: shared(() => import("./settings/ingest-rule/implementation")),
	Integrations: shared(() => import("./integrations/implementation")),
	Investigation: shared(() => import("./investigations/detail/implementation")),
	InvestigationsList: shared(() => import("./investigations/list/implementation")),
	Log: shared(() => import("./logs/log/implementation")),
	LogsList: shared(() => import("./logs/list/implementation")),
	McpPage: shared(() => import("./settings/mcp-page/implementation")),
	MetricDetail: shared(() => import("./metrics/detail/implementation")),
	MetricsBrowse: shared(() => import("./metrics/browse/implementation")),
	Overview: shared(() => import("./overview/implementation")),
	Recommendation: shared(() => import("./recommendations/implementation")),
	Release: shared(() => import("./releases/detail/implementation")),
	ReleasesList: shared(() => import("./releases/list/implementation")),
	ReplayDetail: shared(() => import("./replays/detail/implementation")),
	ReplaysList: shared(() => import("./replays/list/implementation")),
	Security: shared(() => import("./security/tabs/implementation")),
	SecurityFinding: shared(() => import("./security/finding/implementation")),
	SecurityRun: shared(() => import("./security/run/implementation")),
	SecurityTelemetry: shared(() => import("./security/telemetry/implementation")),
	ServiceDetail: shared(() => import("./services/detail/implementation")),
	ServiceMap: shared(() => import("./service-map/implementation")),
	ServicesList: shared(() => import("./services/list/implementation")),
	Settings: shared(() => import("./settings/implementation")),
	Share: shared(() => import("./share/implementation")),
	SourceDetail: shared(() => import("./sources/detail/implementation")),
	SourcesList: shared(() => import("./sources/list/implementation")),
	SourcesNew: shared(() => import("./sources/new/implementation")),
	StatusPage: shared(() => import("./status-pages/editor/implementation")),
	StatusPageNew: shared(() => import("./status-pages/builder/implementation")),
	StatusPages: shared(() => import("./status-pages/list/implementation")),
	TraceDetail: shared(() => import("./traces/detail/implementation")),
	TracesList: shared(() => import("./traces/list/implementation")),
}

export type PageCodeId = keyof typeof pageCode

/**
 * Each routed path as `/segment/:/*` (`:` one segment, `*` the rest) and the page that renders it.
 * Mirrors `route/routers.ts`; `code.test.ts` checks every page route against the real parser.
 */
const routePaths: ReadonlyArray<readonly [string, PageCodeId]> = [
	["/", "Overview"],
	["/account", "Account"],
	["/integrations", "Integrations"],
	["/mcp", "McpPage"],
	["/service-map", "ServiceMap"],
	["/settings", "Settings"],
	["/sources", "SourcesList"],
	["/sources/new", "SourcesNew"],
	["/sources/:", "SourceDetail"],
	["/status-pages", "StatusPages"],
	["/status-pages/new", "StatusPageNew"],
	["/status-pages/:", "StatusPage"],
	["/agent-sessions/:", "AgentSession"],
	["/alerts/:", "AlertRule"],
	["/alerts/create", "AlertEditor"],
	["/alerts/uptime/new", "AlertsUptimeNew"],
	["/alerts/uptime/:", "AlertsUptimeMonitor"],
	["/settings/ingestion/rules/new", "IngestRuleEditor"],
	["/settings/ingestion/rules/:", "IngestRuleEditor"],
	["/anomalies/:", "Anomaly"],
	["/code-review/ci", "CodeReview"],
	["/code-review/issues", "CodeReview"],
	["/code-review/pull-requests", "CodeReview"],
	["/code-review/settings", "CodeReview"],
	["/code-review/team", "CodeReview"],
	["/security", "Security"],
	["/security/findings", "Security"],
	["/security/exposure", "SecurityTelemetry"],
	["/security/runtimes", "SecurityTelemetry"],
	["/security/runs", "Security"],
	["/security/runs/:", "SecurityRun"],
	["/security/findings/:/:", "SecurityFinding"],
	["/dashboards/:", "DashboardView"],
	["/dashboards/templates", "DashboardTemplates"],
	["/investigations/:", "Investigation"],
	["/logs/:", "Log"],
	["/metrics/:", "MetricDetail"],
	["/recommendations/:", "Recommendation"],
	["/releases/:", "Release"],
	["/replays/:", "ReplayDetail"],
	["/services/:", "ServiceDetail"],
	["/share/:", "Share"],
	["/traces/:", "TraceDetail"],
	["/agent-sessions", "AgentSessionsList"],
	["/alerts", "AlertsHub"],
	["/analytics", "Analytics"],
	["/anomalies", "AnomaliesList"],
	["/code-review", "CodeReview"],
	["/dashboards", "DashboardsList"],
	["/errors", "ErrorsHub"],
	["/infra", "InfraOverview"],
	["/investigations", "InvestigationsList"],
	["/logs", "LogsList"],
	["/metrics", "MetricsBrowse"],
	["/releases", "ReleasesList"],
	["/replays", "ReplaysList"],
	["/services", "ServicesList"],
	["/traces", "TracesList"],
	["/agent-sessions/tools/:", "AgentSessionTool"],
	["/alerts/incidents/:", "AlertIncident"],
	["/errors/issues/:", "ErrorIssue"],
	["/infra/cloudflare/:", "InfraCloudflareZone"],
	["/infra/containers/:", "InfraContainer"],
	["/infra/hosts/:", "InfraHost"],
	["/infra/planetscale/:", "InfraPlanetscaleDatabase"],
	["/infra/railway/:", "InfraRailwayService"],
	["/infra/supabase/:", "InfraSupabaseProject"],
	["/agent-sessions/tools", "AgentSessionTools"],
	["/infra/cloudflare", "InfraCloudflare"],
	["/infra/containers", "InfraContainers"],
	["/infra/aws", "InfraAws"],
	["/infra/gcp", "InfraGcp"],
	["/infra/hosts", "InfraHosts"],
	["/infra/planetscale", "InfraPlanetscale"],
	["/infra/railway", "InfraRailway"],
	["/infra/supabase", "InfraSupabase"],
	["/dashboards/:/widgets/:", "DashboardWidget"],
	["/infra/cloudflare/workers/:", "InfraCloudflareWorker"],
	["/infra/aws/:/*", "InfraAwsResource"],
	["/infra/gcp/:/:", "InfraGcpResource"],
	["/infra/kubernetes/nodes/:", "InfraKubernetesNode"],
	["/infra/kubernetes/pods/:", "InfraKubernetesPod"],
	["/infra/kubernetes/services/:", "InfraKubernetesServiceLens"],
	["/infra/kubernetes/nodes", "InfraKubernetesNodes"],
	["/infra/kubernetes/pods", "InfraKubernetesPods"],
	["/infra/kubernetes/services", "InfraKubernetesServiceLens"],
	["/infra/kubernetes/workloads", "InfraKubernetesWorkloads"],
	["/infra/kubernetes/workloads/:/:", "InfraKubernetesWorkload"],
]

const segmentsOf = (path: string) => path.split("/").filter((segment) => segment !== "")

const literalCount = (pattern: ReadonlyArray<string>) =>
	pattern.filter((segment) => segment !== ":" && segment !== "*").length

const matches = (pattern: ReadonlyArray<string>, segments: ReadonlyArray<string>) =>
	pattern.at(-1) === "*"
		? segments.length >= pattern.length &&
			pattern.slice(0, -1).every((segment, index) => segment === ":" || segment === segments[index])
		: segments.length === pattern.length &&
			pattern.every((segment, index) => segment === ":" || segment === segments[index])

const patterns = routePaths.map(([path, id]) => ({ pattern: segmentsOf(path), id }))

/** The page that renders `pathname`, preferring literal segments over params (`/alerts/create`). */
export const pageCodeIdOf = (pathname: string): PageCodeId | undefined => {
	const segments = segmentsOf(pathname)
	return patterns
		.filter(({ pattern }) => matches(pattern, segments))
		.reduce<{ readonly pattern: ReadonlyArray<string>; readonly id: PageCodeId } | undefined>(
			(best, candidate) =>
				best === undefined || literalCount(candidate.pattern) > literalCount(best.pattern)
					? candidate
					: best,
			undefined,
		)?.id
}

/**
 * Called by boot.ts: the route's page code downloads beside the app bundle instead of after
 * `init`. The registry's load of the same page picks up this import.
 */
export const startRoutePageCode = (pathname: string): void => {
	const id = pageCodeIdOf(pathname)
	if (id !== undefined) void pageCode[id]().catch(() => undefined)
}
