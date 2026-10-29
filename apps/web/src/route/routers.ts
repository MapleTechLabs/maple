import { AlertRuleId, AnomalyIncidentId, DashboardId, ErrorIssueId } from "@maple/domain/http"
import { SecurityAuditRunId, SecurityAuditTargetId } from "@maple/domain/security-audit"
import { pipe, Schema } from "effect"
import { Route } from "foldkit"
import { query, schemaSegment, slash } from "foldkit/route"
import { AppRoute } from "./app-route"
import * as Search from "./search"
import { boundedSegment, path, restSegments, segment } from "./segment"
import { tanstackSearch } from "./tanstack-search"

const search = <A, I>(schema: Schema.Codec<A, I>) => query(tanstackSearch(schema))

const WorkloadKind = Search.InfraKubernetesWorkloadParams.fields.kind

/** One biparser per route tag: parses URLs and prints them back (`hrefOf`). */
const routers = {
	Home: pipe(Route.root, search(Search.HomeSearch), Route.mapTo(AppRoute.Home)),
	Account: pipe(path("account"), search(Search.AccountSearch), Route.mapTo(AppRoute.Account)),
	CliLogin: pipe(path("cli-login"), search(Search.CliLoginSearch), Route.mapTo(AppRoute.CliLogin)),
	Connectors: pipe(path("connectors"), search(Search.ConnectorsSearch), Route.mapTo(AppRoute.Connectors)),
	Developer: pipe(path("developer"), search(Search.DeveloperSearch), Route.mapTo(AppRoute.Developer)),
	Integrations: pipe(
		path("integrations"),
		search(Search.IntegrationsSearch),
		Route.mapTo(AppRoute.Integrations),
	),
	Mcp: pipe(path("mcp"), Route.mapTo(AppRoute.Mcp)),
	McpAuthorize: pipe(
		path("mcp-authorize"),
		search(Search.McpAuthorizeSearch),
		Route.mapTo(AppRoute.McpAuthorize),
	),
	OrgRequired: pipe(
		path("org-required"),
		search(Search.OrgRequiredSearch),
		Route.mapTo(AppRoute.OrgRequired),
	),
	QuickStart: pipe(path("quick-start"), search(Search.QuickStartSearch), Route.mapTo(AppRoute.QuickStart)),
	SelectPlan: pipe(path("select-plan"), search(Search.SelectPlanSearch), Route.mapTo(AppRoute.SelectPlan)),
	ServiceMap: pipe(path("service-map"), search(Search.ServiceMapSearch), Route.mapTo(AppRoute.ServiceMap)),
	Settings: pipe(path("settings"), search(Search.SettingsSearch), Route.mapTo(AppRoute.Settings)),
	Sources: pipe(path("sources"), Route.mapTo(AppRoute.Sources)),
	SourcesNew: pipe(
		path("sources", "new"),
		search(Search.SourcesNewSearch),
		Route.mapTo(AppRoute.SourcesNew),
	),
	Source: pipe(
		path("sources"),
		slash(segment("sourceId")),
		search(Search.SourceSearch),
		Route.mapTo(AppRoute.Source),
	),
	SignIn: pipe(path("sign-in"), search(Search.SignInSearch), Route.mapTo(AppRoute.SignIn)),
	SignUp: pipe(path("sign-up"), search(Search.SignUpSearch), Route.mapTo(AppRoute.SignUp)),
	Unsubscribe: pipe(
		path("unsubscribe"),
		search(Search.UnsubscribeSearch),
		Route.mapTo(AppRoute.Unsubscribe),
	),
	AgentSession: pipe(
		path("agent-sessions"),
		slash(segment("sessionId")),
		search(Search.AgentSessionSearch),
		Route.mapTo(AppRoute.AgentSession),
	),
	AlertRule: pipe(
		path("alerts"),
		slash(schemaSegment("ruleId", AlertRuleId)),
		search(Search.AlertRuleSearch),
		Route.mapTo(AppRoute.AlertRule),
	),
	AlertsCreate: pipe(
		path("alerts", "create"),
		search(Search.AlertsCreateSearch),
		Route.mapTo(AppRoute.AlertsCreate),
	),
	AlertsUptimeNew: pipe(
		path("alerts", "uptime", "new"),
		search(Search.AlertsUptimeNewSearch),
		Route.mapTo(AppRoute.AlertsUptimeNew),
	),
	AlertsUptimeMonitor: pipe(
		path("alerts", "uptime"),
		slash(segment("monitorId")),
		search(Search.AlertsUptimeMonitorSearch),
		Route.mapTo(AppRoute.AlertsUptimeMonitor),
	),
	Anomaly: pipe(
		path("anomalies"),
		slash(schemaSegment("incidentId", AnomalyIncidentId)),
		Route.mapTo(AppRoute.Anomaly),
	),
	CodeReviewCi: pipe(
		path("code-review", "ci"),
		search(Search.CodeReviewCiSearch),
		Route.mapTo(AppRoute.CodeReviewCi),
	),
	CodeReviewIssues: pipe(
		path("code-review", "issues"),
		search(Search.CodeReviewIssuesSearch),
		Route.mapTo(AppRoute.CodeReviewIssues),
	),
	CodeReviewPullRequests: pipe(
		path("code-review", "pull-requests"),
		search(Search.CodeReviewPullRequestsSearch),
		Route.mapTo(AppRoute.CodeReviewPullRequests),
	),
	CodeReviewSettings: pipe(path("code-review", "settings"), Route.mapTo(AppRoute.CodeReviewSettings)),
	Security: pipe(path("security"), Route.mapTo(AppRoute.Security)),
	SecurityFindings: pipe(
		path("security", "findings"),
		search(Search.SecurityFindingsSearch),
		Route.mapTo(AppRoute.SecurityFindings),
	),
	SecurityRuns: pipe(
		path("security", "runs"),
		search(Search.SecurityRunsSearch),
		Route.mapTo(AppRoute.SecurityRuns),
	),
	SecurityRun: pipe(
		path("security", "runs"),
		slash(schemaSegment("runId", SecurityAuditRunId)),
		Route.mapTo(AppRoute.SecurityRun),
	),
	SecurityFinding: pipe(
		path("security", "findings"),
		slash(schemaSegment("targetId", SecurityAuditTargetId)),
		slash(boundedSegment("fingerprint", 1024)),
		Route.mapTo(AppRoute.SecurityFinding),
	),
	Dashboard: pipe(
		path("dashboards"),
		slash(schemaSegment("dashboardId", DashboardId)),
		search(Search.DashboardSearch),
		Route.mapTo(AppRoute.Dashboard),
	),
	DashboardsTemplates: pipe(
		path("dashboards", "templates"),
		search(Search.DashboardsTemplatesSearch),
		Route.mapTo(AppRoute.DashboardsTemplates),
	),
	InfraLegacyHost: pipe(path("infra"), slash(segment("hostName")), Route.mapTo(AppRoute.InfraLegacyHost)),
	InfraDiscover: pipe(path("infra", "discover"), Route.mapTo(AppRoute.InfraDiscover)),
	Investigation: pipe(
		path("investigations"),
		slash(segment("id")),
		search(Search.InvestigationSearch),
		Route.mapTo(AppRoute.Investigation),
	),
	Log: pipe(path("logs"), slash(segment("logId")), Route.mapTo(AppRoute.Log)),
	Metric: pipe(
		path("metrics"),
		slash(segment("metricName")),
		search(Search.MetricSearch),
		Route.mapTo(AppRoute.Metric),
	),
	Recommendation: pipe(
		path("recommendations"),
		slash(segment("recommendationKey")),
		Route.mapTo(AppRoute.Recommendation),
	),
	Release: pipe(
		path("releases"),
		slash(segment("commitSha")),
		search(Search.ReleaseSearch),
		Route.mapTo(AppRoute.Release),
	),
	Replay: pipe(
		path("replays"),
		slash(segment("sessionId")),
		search(Search.ReplaySearch),
		Route.mapTo(AppRoute.Replay),
	),
	Service: pipe(
		path("services"),
		slash(segment("serviceName")),
		search(Search.ServiceSearch),
		Route.mapTo(AppRoute.Service),
	),
	Share: pipe(
		path("share"),
		slash(segment("token")),
		search(Search.ShareSearch),
		Route.mapTo(AppRoute.Share),
	),
	Trace: pipe(
		path("traces"),
		slash(segment("traceId")),
		search(Search.TraceSearch),
		Route.mapTo(AppRoute.Trace),
	),
	AgentSessions: pipe(
		path("agent-sessions"),
		search(Search.AgentSessionsSearch),
		Route.mapTo(AppRoute.AgentSessions),
	),
	Alerts: pipe(path("alerts"), search(Search.AlertsSearch), Route.mapTo(AppRoute.Alerts)),
	Analytics: pipe(path("analytics"), search(Search.AnalyticsSearch), Route.mapTo(AppRoute.Analytics)),
	Anomalies: pipe(path("anomalies"), search(Search.AnomaliesSearch), Route.mapTo(AppRoute.Anomalies)),
	CodeReview: pipe(path("code-review"), search(Search.CodeReviewSearch), Route.mapTo(AppRoute.CodeReview)),
	Dashboards: pipe(path("dashboards"), search(Search.DashboardsSearch), Route.mapTo(AppRoute.Dashboards)),
	Errors: pipe(path("errors"), search(Search.ErrorsSearch), Route.mapTo(AppRoute.Errors)),
	Infra: pipe(path("infra"), search(Search.InfraSearch), Route.mapTo(AppRoute.Infra)),
	Investigations: pipe(
		path("investigations"),
		search(Search.InvestigationsSearch),
		Route.mapTo(AppRoute.Investigations),
	),
	Logs: pipe(path("logs"), search(Search.LogsSearch), Route.mapTo(AppRoute.Logs)),
	Metrics: pipe(path("metrics"), search(Search.MetricsSearch), Route.mapTo(AppRoute.Metrics)),
	Releases: pipe(path("releases"), search(Search.ReleasesSearch), Route.mapTo(AppRoute.Releases)),
	Replays: pipe(path("replays"), search(Search.ReplaysSearch), Route.mapTo(AppRoute.Replays)),
	Services: pipe(path("services"), search(Search.ServicesSearch), Route.mapTo(AppRoute.Services)),
	Traces: pipe(path("traces"), search(Search.TracesSearch), Route.mapTo(AppRoute.Traces)),
	AgentSessionTool: pipe(
		path("agent-sessions", "tools"),
		slash(segment("toolName")),
		search(Search.AgentSessionToolSearch),
		Route.mapTo(AppRoute.AgentSessionTool),
	),
	AlertIncident: pipe(
		path("alerts", "incidents"),
		slash(segment("incidentId")),
		search(Search.AlertIncidentSearch),
		Route.mapTo(AppRoute.AlertIncident),
	),
	ErrorIssue: pipe(
		path("errors", "issues"),
		slash(schemaSegment("issueId", ErrorIssueId)),
		search(Search.ErrorIssueSearch),
		Route.mapTo(AppRoute.ErrorIssue),
	),
	InfraCloudflareZone: pipe(
		path("infra", "cloudflare"),
		slash(segment("zoneName")),
		search(Search.InfraCloudflareZoneSearch),
		Route.mapTo(AppRoute.InfraCloudflareZone),
	),
	InfraContainer: pipe(
		path("infra", "containers"),
		slash(segment("containerName")),
		search(Search.InfraContainerSearch),
		Route.mapTo(AppRoute.InfraContainer),
	),
	InfraHost: pipe(
		path("infra", "hosts"),
		slash(segment("hostName")),
		search(Search.InfraHostSearch),
		Route.mapTo(AppRoute.InfraHost),
	),
	InfraPlanetscaleDatabase: pipe(
		path("infra", "planetscale"),
		slash(segment("dbName")),
		search(Search.InfraPlanetscaleDatabaseSearch),
		Route.mapTo(AppRoute.InfraPlanetscaleDatabase),
	),
	InfraRailwayService: pipe(
		path("infra", "railway"),
		slash(segment("serviceId")),
		search(Search.InfraRailwayServiceSearch),
		Route.mapTo(AppRoute.InfraRailwayService),
	),
	InfraSupabaseProject: pipe(
		path("infra", "supabase"),
		slash(segment("projectRef")),
		search(Search.InfraSupabaseProjectSearch),
		Route.mapTo(AppRoute.InfraSupabaseProject),
	),
	AgentSessionTools: pipe(
		path("agent-sessions", "tools"),
		search(Search.AgentSessionToolsSearch),
		Route.mapTo(AppRoute.AgentSessionTools),
	),
	ErrorIssues: pipe(
		path("errors", "issues"),
		search(Search.ErrorIssuesSearch),
		Route.mapTo(AppRoute.ErrorIssues),
	),
	InfraCloudflare: pipe(
		path("infra", "cloudflare"),
		search(Search.InfraCloudflareSearch),
		Route.mapTo(AppRoute.InfraCloudflare),
	),
	InfraContainers: pipe(
		path("infra", "containers"),
		search(Search.InfraContainersSearch),
		Route.mapTo(AppRoute.InfraContainers),
	),
	InfraAws: pipe(path("infra", "aws"), search(Search.InfraAwsSearch), Route.mapTo(AppRoute.InfraAws)),
	InfraGcp: pipe(path("infra", "gcp"), search(Search.InfraGcpSearch), Route.mapTo(AppRoute.InfraGcp)),
	InfraHosts: pipe(
		path("infra", "hosts"),
		search(Search.InfraHostsSearch),
		Route.mapTo(AppRoute.InfraHosts),
	),
	InfraKubernetes: pipe(
		path("infra", "kubernetes"),
		search(Search.InfraKubernetesSearch),
		Route.mapTo(AppRoute.InfraKubernetes),
	),
	InfraPlanetscale: pipe(
		path("infra", "planetscale"),
		search(Search.InfraPlanetscaleSearch),
		Route.mapTo(AppRoute.InfraPlanetscale),
	),
	InfraRailway: pipe(
		path("infra", "railway"),
		search(Search.InfraRailwaySearch),
		Route.mapTo(AppRoute.InfraRailway),
	),
	InfraSupabase: pipe(
		path("infra", "supabase"),
		search(Search.InfraSupabaseSearch),
		Route.mapTo(AppRoute.InfraSupabase),
	),
	DashboardWidget: pipe(
		path("dashboards"),
		slash(schemaSegment("dashboardId", DashboardId)),
		slash(path("widgets")),
		slash(segment("widgetId")),
		search(Search.DashboardWidgetSearch),
		Route.mapTo(AppRoute.DashboardWidget),
	),
	InfraCloudflareWorker: pipe(
		path("infra", "cloudflare", "workers"),
		slash(segment("scriptName")),
		search(Search.InfraCloudflareWorkerSearch),
		Route.mapTo(AppRoute.InfraCloudflareWorker),
	),
	InfraAwsResource: pipe(
		path("infra", "aws"),
		slash(segment("kind")),
		slash(restSegments("name")),
		search(Search.InfraAwsResourceSearch),
		Route.mapTo(AppRoute.InfraAwsResource),
	),
	InfraGcpResource: pipe(
		path("infra", "gcp"),
		slash(segment("service")),
		slash(segment("name")),
		search(Search.InfraGcpResourceSearch),
		Route.mapTo(AppRoute.InfraGcpResource),
	),
	InfraKubernetesNode: pipe(
		path("infra", "kubernetes", "nodes"),
		slash(segment("nodeName")),
		search(Search.InfraKubernetesNodeSearch),
		Route.mapTo(AppRoute.InfraKubernetesNode),
	),
	InfraKubernetesPod: pipe(
		path("infra", "kubernetes", "pods"),
		slash(segment("podName")),
		search(Search.InfraKubernetesPodSearch),
		Route.mapTo(AppRoute.InfraKubernetesPod),
	),
	InfraKubernetesService: pipe(
		path("infra", "kubernetes", "services"),
		slash(segment("serviceName")),
		search(Search.InfraKubernetesServiceSearch),
		Route.mapTo(AppRoute.InfraKubernetesService),
	),
	InfraKubernetesNodes: pipe(
		path("infra", "kubernetes", "nodes"),
		search(Search.InfraKubernetesNodesSearch),
		Route.mapTo(AppRoute.InfraKubernetesNodes),
	),
	InfraKubernetesPods: pipe(
		path("infra", "kubernetes", "pods"),
		search(Search.InfraKubernetesPodsSearch),
		Route.mapTo(AppRoute.InfraKubernetesPods),
	),
	InfraKubernetesServices: pipe(
		path("infra", "kubernetes", "services"),
		search(Search.InfraKubernetesServicesSearch),
		Route.mapTo(AppRoute.InfraKubernetesServices),
	),
	InfraKubernetesWorkloads: pipe(
		path("infra", "kubernetes", "workloads"),
		search(Search.InfraKubernetesWorkloadsSearch),
		Route.mapTo(AppRoute.InfraKubernetesWorkloads),
	),
	InfraKubernetesWorkload: pipe(
		path("infra", "kubernetes", "workloads"),
		slash(schemaSegment("kind", WorkloadKind)),
		slash(segment("workloadName")),
		search(Search.InfraKubernetesWorkloadSearch),
		Route.mapTo(AppRoute.InfraKubernetesWorkload),
	),
	// Index paths with no page of their own; `routeRedirect` sends them to the closest live page.
	AlertIncidentsIndex: pipe(path("alerts", "incidents"), Route.mapTo(AppRoute.AlertIncidentsIndex)),
	RecommendationsIndex: pipe(path("recommendations"), Route.mapTo(AppRoute.RecommendationsIndex)),
} as const

// Literal routes come before the param routes that would also match them (`/infra/hosts`).
export const urlToAppRoute = Route.parseUrlWithFallback(
	Route.oneOf(
		routers.AlertsCreate,
		routers.AlertsUptimeNew,
		routers.AlertsUptimeMonitor,
		routers.DashboardsTemplates,
		routers.SourcesNew,
		routers.InfraDiscover,
		routers.InfraCloudflare,
		routers.InfraContainers,
		routers.InfraAws,
		routers.InfraGcp,
		routers.InfraHosts,
		routers.InfraKubernetes,
		routers.InfraPlanetscale,
		routers.InfraRailway,
		routers.InfraSupabase,
		routers.AgentSessionTools,
		routers.ErrorIssues,
		...Object.values(routers),
	),
	AppRoute.NotFound,
)

/** The URL a route prints to; `urlToAppRoute` of it gives the route back. */
export const hrefOf = (route: AppRoute): string =>
	AppRoute.match<string>(route, {
		...routers,
		NotFound: ({ path }) => path,
	})
