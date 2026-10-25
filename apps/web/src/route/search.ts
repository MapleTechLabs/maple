// The search schema of every route. Shapes match the URLs already in use, so existing links decode.
import { Schema, SchemaGetter } from "effect"
import {
	AiSessionSortDir,
	AiSessionSortKey,
	CiBranchName,
	CiPipelineName,
	CiRunResult,
	IssueKind,
	PrReviewCategory,
	PrReviewFindingStatus,
	PrReviewId,
	PrReviewSeverity,
	VcsRepositoryId,
} from "@maple/domain/http"
import { PushSourcePlatform } from "@maple/domain/primitives"
import { QUERY_BUILDER_METRIC_TYPES } from "@maple/query-model"

// apps/web/src/lib/search-params.ts
const StringArray = Schema.Array(Schema.String)
const StringArrayFromJsonString = Schema.fromJsonString(Schema.Array(Schema.String))

export const BooleanFromStringParam = Schema.fromJsonString(Schema.Boolean)

export const NumberFromStringParam = Schema.fromJsonString(Schema.Number)

export const OptionalStringArrayParam = Schema.optional(
	Schema.Union([StringArray, StringArrayFromJsonString]),
)

/** A string of digits a URL wrote unquoted, which the search format parses as a number. */
const DigitsParam = Schema.Number.pipe(
	Schema.decodeTo(Schema.String, {
		decode: SchemaGetter.transform((value: number) => String(value)),
		encode: SchemaGetter.transform((value: string) => Number(value)),
	}),
)

const BooleanParam = Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam]))
const NumberParam = Schema.optional(Schema.Union([Schema.Number, NumberFromStringParam]))

// Time range
export const TimeRangeSearchFields = {
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	timePreset: Schema.optional(Schema.String),
}

// apps/web/src/lib/dashboard-controls/search-params.ts
export const VARIABLE_PARAM_PREFIX = "var-"

export const variableSearchRest = Schema.Record(
	Schema.TemplateLiteral([VARIABLE_PARAM_PREFIX, Schema.String]),
	Schema.Unknown,
)

export const dashboardViewParamsSchema = {
	filter: Schema.optional(Schema.String),
	collapsed: Schema.optional(Schema.String),
	expanded: Schema.optional(Schema.String),
	tab: Schema.optional(Schema.String),
	widget: Schema.optional(Schema.String),
	refresh: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
}

// Agent tool analytics and search
const TOOL_METRICS = ["calls", "sessions", "error_rate", "duration"] as const
const TOOL_PERCENTILES = ["p50", "p90", "p95"] as const

const ToolAnalyticsSearchFields = {
	metric: Schema.optional(Schema.Literals(TOOL_METRICS)),
	percentile: Schema.optional(Schema.Literals(TOOL_PERCENTILES)),
	tool: Schema.optional(Schema.String),
	model: Schema.optional(Schema.String),
	q: Schema.optional(Schema.String),
	service: Schema.optional(Schema.String),
	env: Schema.optional(Schema.String),
	failing: BooleanParam,
	error: Schema.optional(Schema.String),
	session: Schema.optional(Schema.String),
	variant: Schema.optional(Schema.String),
}

// apps/web/src/components/analytics/filters.ts
const analyticsFilterSearchFields = {
	host: Schema.optional(Schema.String),
	pagePath: Schema.optional(Schema.String),
	referrerHost: Schema.optional(Schema.String),
	country: Schema.optional(Schema.String),
	deviceType: Schema.optional(Schema.String),
	browserName: Schema.optional(Schema.String),
	osName: Schema.optional(Schema.String),
	language: Schema.optional(Schema.String),
	utmSource: Schema.optional(Schema.String),
	utmMedium: Schema.optional(Schema.String),
	utmCampaign: Schema.optional(Schema.String),
	visitorType: Schema.optional(Schema.Literals(["new", "returning"])),
	traffic: Schema.optional(Schema.Literals(["all", "humans", "bots"])),
	eventName: Schema.optional(Schema.String),
}

// Code review
const CodeReviewSearchFields = {
	repo: Schema.optional(VcsRepositoryId),
	author: Schema.optional(Schema.String),
	...TimeRangeSearchFields,
}

const CodeReviewIssuesSearchFields = {
	...CodeReviewSearchFields,
	severity: Schema.optional(PrReviewSeverity),
	category: Schema.optional(PrReviewCategory),
	state: Schema.optional(PrReviewFindingStatus),
	review: Schema.optional(PrReviewId),
}

const CodeReviewListSearchFields = {
	...CodeReviewSearchFields,
	status: Schema.optional(Schema.Literals(["completed", "failed", "skipped", "running", "queued"])),
	review: Schema.optional(PrReviewId),
}

const CodeReviewCiSearchFields = {
	...CodeReviewSearchFields,
	pipeline: Schema.optional(CiPipelineName),
	branch: Schema.optional(CiBranchName),
	result: Schema.optional(CiRunResult),
}

// apps/web/src/components/infra/cloudflare/filters.ts + list-model.ts
const cloudflareFilterSearchFields = {
	hosts: OptionalStringArrayParam,
	cacheStatuses: OptionalStringArrayParam,
	statusClasses: OptionalStringArrayParam,
	paths: OptionalStringArrayParam,
	pathContains: Schema.optional(Schema.String),
	countries: OptionalStringArrayParam,
	methods: OptionalStringArrayParam,
	protocols: OptionalStringArrayParam,
	deviceTypes: OptionalStringArrayParam,
}

const CLOUDFLARE_VIEWS = ["zones", "workers", "queues"] as const
const ZONE_SCOPES = ["serving5xx", "mostly4xx", "lowVolume"] as const
const WORKER_SCOPES = ["erroring", "slow", "cpuHeavy"] as const
const ZONE_TABS = ["traffic", "dns", "security"] as const

// PlanetScale filters
const planetscaleFilterSearchFields = {
	branches: OptionalStringArrayParam,
	branchStates: OptionalStringArrayParam,
	branchRoles: OptionalStringArrayParam,
	branchContains: Schema.optional(Schema.String),
}

// apps/web/src/lib/errors/hub-params.ts
const HUB_VIEWS = ["open", "closed", "all"] as const
const LEGACY_HUB_VIEWS = ["triage", "active", "resolved"] as const
const HUB_SORTS = ["last_seen", "volume", "severity"] as const
const SEVERITY_FILTERS = ["all", "critical", "high", "medium", "low", "unset"] as const

// Tab sets of the account, settings (plus retired settings tabs), issue and investigation navs
export const accountTabValues = [
	"profile",
	"emails",
	"password",
	"two-factor",
	"passkeys",
	"connections",
	"sessions",
	"email-preferences",
] as const

export const settingsTabValues = [
	"general",
	"members",
	"billing",
	"audit-log",
	"keys",
	"mcp",
	"ai",
	"ingestion",
	"data-platform",
	"setup-health",
	"automation",
] as const
export const legacySettingsTabValues = [
	"organization",
	"api-keys",
	"ai-provider",
	"setup-audit",
	"notifications",
	"connectors",
	"integrations",
	"escalations",
	"developer",
] as const

const ISSUE_TABS = ["overview", "occurrences", "activity"] as const
const INVESTIGATION_TABS = ["overview", "evidence", "chat", "transcript"] as const

const SortDirParam = Schema.optional(Schema.Literals(["asc", "desc"]))
const ContainsMatchMode = Schema.optional(Schema.Literals(["contains"]))
const WorkloadKindLiteral = Schema.Literals(["deployment", "statefulset", "daemonset", "job"])

// Not validated: the redirect reads the raw values.
export const ErrorIssuesSearch = Schema.Struct({
	workflowState: Schema.optional(Schema.Unknown),
	severity: Schema.optional(Schema.Unknown),
})

// Top-level routes

// sessionTimeRangeSearchMiddleware()
export const HomeSearch = Schema.Struct({
	environment: Schema.optional(Schema.String),
	...TimeRangeSearchFields,
})

export const AccountSearch = Schema.Struct({
	tab: Schema.optional(Schema.Literals(accountTabValues)),
})

export const ChatSearch = Schema.Struct({
	tab: Schema.optional(Schema.String),
	mode: Schema.optional(Schema.Literals(["alert", "widget-fix"])),
	alert: Schema.optional(Schema.String),
	widget: Schema.optional(Schema.String),
	shared: Schema.optional(Schema.String),
	title: Schema.optional(Schema.String),
	m: Schema.optional(Schema.String),
})

export const CliLoginSearch = Schema.Struct({
	user_code: Schema.optional(Schema.String),
})

// Keeps `tab` only when it is a string; the route redirects to /integrations.
export const ConnectorsSearch = Schema.Struct({
	tab: Schema.optional(Schema.Unknown),
})

// Keeps `tab` only when it is a string; the route redirects to /settings.
export const DeveloperSearch = Schema.Struct({
	tab: Schema.optional(Schema.Unknown),
})

export const IntegrationsSearch = Schema.Struct({
	integration: Schema.optional(Schema.String),
	chat: Schema.optional(Schema.String),
	chat_reason: Schema.optional(Schema.String),
	chat_workspace: Schema.optional(Schema.String),
	chat_identity: Schema.optional(Schema.String),
	chat_identity_name: Schema.optional(Schema.String),
})

export const McpAuthorizeSearch = Schema.Struct({
	request_id: Schema.optional(Schema.String),
})

export const OrgRequiredSearch = Schema.Struct({
	redirect_url: Schema.optional(Schema.String),
})

export const QuickStartSearch = Schema.Struct({
	redirect_url: Schema.optional(Schema.String),
	checkout: Schema.optional(Schema.Literal("complete")),
})

export const SelectPlanSearch = Schema.Struct({
	redirect_url: Schema.optional(Schema.String),
	checkout: Schema.optional(Schema.Literal("complete")),
})

// sessionTimeRangeSearchMiddleware({ maxRangeSeconds: one year })
export const ServiceMapSearch = Schema.Struct({
	view: Schema.optional(Schema.Literals(["2d", "3d"])),
	environment: Schema.optional(Schema.String),
	focusService: Schema.optional(Schema.String),
	focusHops: Schema.optional(Schema.Literals([1, 2])),
	focusMode: Schema.optional(Schema.Literals(["dim", "hide"])),
	...TimeRangeSearchFields,
})

export const SettingsSearch = Schema.Struct({
	tab: Schema.optional(Schema.Literals([...settingsTabValues, ...legacySettingsTabValues])),
	checkout: Schema.optional(Schema.Literal("complete")),
	// audit-log-filters.ts `AuditLogSearchFields`
	range: Schema.optional(Schema.String),
	since: Schema.optional(Schema.String),
	until: Schema.optional(Schema.String),
	actor: Schema.optional(Schema.String),
	actor_type: Schema.optional(Schema.String),
	outcome: Schema.optional(Schema.String),
})

export const SignInSearch = Schema.Struct({
	redirect_url: Schema.optional(Schema.String),
})

export const SignUpSearch = Schema.Struct({
	redirect_url: Schema.optional(Schema.String),
})

export const UnsubscribeSearch = Schema.Struct({
	token: Schema.optional(Schema.String),
})

// Detail routes

export const AgentSessionSearch = Schema.Struct({
	t: Schema.optional(Schema.String),
	end: Schema.optional(Schema.String),
	view: Schema.optional(Schema.String),
	span: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed())),
	tool: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed())),
})

// sessionTimeRangeSearchMiddleware({ maxRangeSeconds: one year })
export const AlertRuleSearch = Schema.Struct({
	tab: Schema.optional(Schema.String),
	...TimeRangeSearchFields,
})

export const AlertsCreateSearch = Schema.Struct({
	serviceName: Schema.optional(Schema.String),
	ruleId: Schema.optional(Schema.String),
	template: Schema.optional(Schema.String),
	dashboardId: Schema.optional(Schema.String),
	widgetId: Schema.optional(Schema.String),
	chart: Schema.optional(Schema.String),
})

export const CodeReviewCiSearch = Schema.Struct(CodeReviewCiSearchFields)

export const CodeReviewIssuesSearch = Schema.Struct(CodeReviewIssuesSearchFields)

export const CodeReviewPullRequestsSearch = Schema.Struct(CodeReviewListSearchFields)

export const DashboardSearch = Schema.StructWithRest(
	Schema.Struct({
		mode: Schema.optional(Schema.Literal("edit")),
		...dashboardViewParamsSchema,
	}),
	[variableSearchRest],
)

// Sources: new and detail (`SOURCE_TABS`)
export const SourcesNewSearch = Schema.Struct({
	platform: Schema.optional(PushSourcePlatform),
	/** A data integration's connect step. A plain string: OAuth callbacks return here, so an unknown id falls back to the picker. */
	integration: Schema.optional(Schema.String),
})

/** Push sources show Setup, integration sources show Connection; a link to the other one falls back. */
export const SOURCE_TABS = ["overview", "setup", "connection", "settings"] as const
export type SourceTab = (typeof SOURCE_TABS)[number]

export const SourceSearch = Schema.Struct({
	tab: Schema.optional(Schema.Literals(SOURCE_TABS)),
})

export const DashboardsTemplatesSearch = Schema.Struct({
	template: Schema.optional(Schema.String),
})

export const InvestigationSearch = Schema.Struct({
	tab: Schema.optional(Schema.Literals(INVESTIGATION_TABS)),
	action: Schema.optional(Schema.Unknown),
})

// sessionTimeRangeSearchMiddleware()
export const MetricSearch = Schema.Struct({
	type: Schema.optional(Schema.Literals(QUERY_BUILDER_METRIC_TYPES)),
	agg: Schema.optional(Schema.Literals(["avg", "sum", "min", "max", "count", "rate", "increase"])),
	where: Schema.optional(Schema.String),
	groupBy: Schema.optional(Schema.String),
	step: Schema.optional(Schema.String),
	bd: Schema.optional(Schema.String),
	...TimeRangeSearchFields,
})

// sessionTimeRangeSearchMiddleware({ maxRangeSeconds: one year })
export const ReleaseSearch = Schema.Struct({
	service: Schema.optional(Schema.String),
	environments: OptionalStringArrayParam,
	...TimeRangeSearchFields,
})

export const ReplaySearch = Schema.Struct({
	t: Schema.optional(Schema.String),
})

// sessionTimeRangeSearchMiddleware({ maxRangeSeconds: one year })
export const ServiceSearch = Schema.Struct({
	tab: Schema.optional(Schema.String),
	/** The API tab's open endpoint drawer, by normalized span name ("GET /users/{id}"). */
	endpoint: Schema.optional(Schema.String),
	environments: OptionalStringArrayParam,
	...TimeRangeSearchFields,
})

export const ShareSearch = Schema.StructWithRest(
	Schema.Struct({
		embed: Schema.optional(Schema.Boolean),
		theme: Schema.optional(Schema.String),
		from: Schema.optional(Schema.String),
		to: Schema.optional(Schema.String),
		range: Schema.optional(Schema.String),
		refresh: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
	}),
	[variableSearchRest],
)

export const TraceSearch = Schema.Struct({
	spanId: Schema.optional(Schema.String),
	t: Schema.optional(Schema.String),
	view: Schema.optional(Schema.Literals(["waterfall", "timeline", "flow"])),
})

// List routes

export const AgentSessionsSearch = Schema.Struct({
	vendors: OptionalStringArrayParam,
	services: OptionalStringArrayParam,
	environments: OptionalStringArrayParam,
	models: OptionalStringArrayParam,
	agents: OptionalStringArrayParam,
	tools: OptionalStringArrayParam,
	q: Schema.optional(Schema.String),
	hasErrors: BooleanParam,
	grouped: BooleanParam,
	durationMin: NumberParam,
	durationMax: NumberParam,
	costMin: NumberParam,
	costMax: NumberParam,
	tokensMin: NumberParam,
	tokensMax: NumberParam,
	llmCallsMin: NumberParam,
	llmCallsMax: NumberParam,
	toolCallsMin: NumberParam,
	toolCallsMax: NumberParam,
	sortBy: Schema.optional(AiSessionSortKey),
	sortDir: Schema.optional(AiSessionSortDir),
})

export const AlertsSearch = Schema.Struct({
	tab: Schema.optional(Schema.String),
	serviceName: Schema.optional(Schema.String),
	status: Schema.optional(Schema.String),
})

// sessionTimeRangeSearchMiddleware()
export const AnalyticsSearch = Schema.Struct({
	...analyticsFilterSearchFields,
	...TimeRangeSearchFields,
	tab: Schema.optional(Schema.String),
})

const AnomalySeverityLiteral = Schema.Literals(["warning", "critical"])
const AnomalySignalLiteral = Schema.Literals([
	"error_rate",
	"latency_p95",
	"throughput",
	"error_spike",
	"log_volume",
])

export const AnomaliesSearch = Schema.Struct({
	status: Schema.optional(Schema.Literals(["open", "resolved", "all"])),
	severity: Schema.optional(Schema.Array(AnomalySeverityLiteral)),
	signals: Schema.optional(Schema.Array(AnomalySignalLiteral)),
	services: Schema.optional(Schema.Array(Schema.String)),
	envs: Schema.optional(Schema.Array(Schema.String)),
	excludedSeverity: Schema.optional(Schema.Array(AnomalySeverityLiteral)),
	excludedSignals: Schema.optional(Schema.Array(AnomalySignalLiteral)),
	excludedServices: Schema.optional(Schema.Array(Schema.String)),
	excludedEnvs: Schema.optional(Schema.Array(Schema.String)),
	live: Schema.optional(Schema.Boolean),
})

export const CodeReviewSearch = Schema.Struct(CodeReviewSearchFields)

export const DashboardsSearch = Schema.Struct({
	q: Schema.optional(Schema.String),
	scope: Schema.optional(Schema.Literals(["all", "favorites"])),
	tags: Schema.optional(Schema.Array(Schema.String)),
	sort: Schema.optional(Schema.Literals(["updated", "created", "name-asc", "name-desc", "widgets"])),
})

export const ErrorsSearch = Schema.Struct({
	service: Schema.optional(Schema.String),
	env: Schema.optional(Schema.String),
	kind: Schema.optional(IssueKind),
	regressed: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	view: Schema.optional(Schema.Literals([...HUB_VIEWS, ...LEGACY_HUB_VIEWS])),
	q: Schema.optional(Schema.String),
	sort: Schema.optional(Schema.Literals(HUB_SORTS)),
	severity: Schema.optional(Schema.Literals(SEVERITY_FILTERS)),
})

// sessionTimeRangeSearchMiddleware()
export const InfraSearch = Schema.Struct({
	...TimeRangeSearchFields,
})

export const InvestigationsSearch = Schema.Struct({
	view: Schema.optional(Schema.Literals(["active", "history"])),
	kind: Schema.optional(Schema.Literals(["alert", "error", "anomaly", "question", "verification"])),
	sort: Schema.optional(Schema.Literals(["updated", "severity", "confidence"])),
	dir: Schema.optional(Schema.Literals(["asc", "desc"])),
	q: Schema.optional(Schema.String),
})

// sessionTimeRangeSearchMiddleware()
export const LogsSearch = Schema.Struct({
	services: OptionalStringArrayParam,
	severities: OptionalStringArrayParam,
	deploymentEnvs: OptionalStringArrayParam,
	deploymentEnvMatchMode: Schema.optional(Schema.Literals(["contains"])),
	namespaces: OptionalStringArrayParam,
	namespaceMatchMode: Schema.optional(Schema.Literals(["contains"])),
	excludedServices: OptionalStringArrayParam,
	excludedSeverities: OptionalStringArrayParam,
	excludedDeploymentEnvs: OptionalStringArrayParam,
	excludedNamespaces: OptionalStringArrayParam,
	attrs: OptionalStringArrayParam,
	columns: OptionalStringArrayParam,
	search: Schema.optional(Schema.String),
	traceId: Schema.optional(Schema.String),
	refresh: dashboardViewParamsSchema.refresh,
	...TimeRangeSearchFields,
})

// sessionTimeRangeSearchMiddleware()
export const MetricsSearch = Schema.Struct({
	q: Schema.optional(Schema.String),
	type: Schema.optional(Schema.Literals(QUERY_BUILDER_METRIC_TYPES)),
	view: Schema.optional(Schema.Literals(["grid", "table"])),
	...TimeRangeSearchFields,
})

// sessionTimeRangeSearchMiddleware({ maxRangeSeconds: one year })
export const ReleasesSearch = Schema.Struct({
	environments: OptionalStringArrayParam,
	excludedEnvironments: OptionalStringArrayParam,
	services: OptionalStringArrayParam,
	impact: Schema.optional(Schema.Literals(["regressed", "watch", "rolling", "healthy"])),
	...TimeRangeSearchFields,
})

// sessionTimeRangeSearchMiddleware()
export const ReplaysSearch = Schema.Struct({
	service: Schema.optional(Schema.String),
	browser: Schema.optional(Schema.String),
	country: Schema.optional(Schema.String),
	deviceType: Schema.optional(Schema.String),
	userId: Schema.optional(Schema.String),
	user: Schema.optional(Schema.String),
	group: Schema.optional(Schema.String),
	visitorId: Schema.optional(Schema.String),
	hasErrors: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	durationMin: Schema.optional(Schema.Union([Schema.Number, NumberFromStringParam])),
	durationMax: Schema.optional(Schema.Union([Schema.Number, NumberFromStringParam])),
	activeMin: Schema.optional(Schema.Union([Schema.Number, NumberFromStringParam])),
	activeMax: Schema.optional(Schema.Union([Schema.Number, NumberFromStringParam])),
	q: Schema.optional(Schema.String),
	page: Schema.optional(Schema.String),
	tags: OptionalStringArrayParam,
	...TimeRangeSearchFields,
})

// sessionTimeRangeSearchMiddleware({ maxRangeSeconds: one year })
export const ServicesSearch = Schema.Struct({
	environments: OptionalStringArrayParam,
	namespaces: OptionalStringArrayParam,
	commitShas: OptionalStringArrayParam,
	excludedEnvironments: OptionalStringArrayParam,
	excludedNamespaces: OptionalStringArrayParam,
	excludedCommitShas: OptionalStringArrayParam,
	health: Schema.optional(Schema.Literals(["healthy", "degraded", "unhealthy"])),
	groupBy: Schema.optional(Schema.Literals(["namespace", "environment"])),
	...TimeRangeSearchFields,
})

const attributeFilterParamFields = {
	key: Schema.String,
	value: Schema.String,
	matchMode: Schema.optional(Schema.Literals(["contains", "exists", "gt", "gte", "lt", "lte"])),
	negated: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
}

const AttributeFilterParam = Schema.Struct({
	...attributeFilterParamFields,
	or: Schema.optional(Schema.Array(Schema.Struct(attributeFilterParamFields))),
})

// sessionTimeRangeSearchMiddleware()
export const TracesSearch = Schema.Struct({
	services: OptionalStringArrayParam,
	spanNames: OptionalStringArrayParam,
	hasError: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	minDurationMs: Schema.optional(Schema.Union([Schema.Number, Schema.NumberFromString])),
	maxDurationMs: Schema.optional(Schema.Union([Schema.Number, Schema.NumberFromString])),
	httpMethods: OptionalStringArrayParam,
	httpStatusCodes: OptionalStringArrayParam,
	deploymentEnvs: OptionalStringArrayParam,
	namespaces: OptionalStringArrayParam,
	rootOnly: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	hideNoise: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	minSpanCount: Schema.optional(Schema.Union([Schema.Number, Schema.NumberFromString])),
	whereClause: Schema.optional(Schema.String),
	attributeFilters: Schema.optional(Schema.Array(AttributeFilterParam)),
	resourceAttributeFilters: Schema.optional(Schema.Array(AttributeFilterParam)),
	peek: Schema.optional(Schema.String),
	peekRow: Schema.optional(Schema.String),
	peekT: Schema.optional(Schema.String),
	peekSpan: Schema.optional(Schema.String),
	serviceMatchMode: ContainsMatchMode,
	spanNameMatchMode: ContainsMatchMode,
	deploymentEnvMatchMode: ContainsMatchMode,
	namespaceMatchMode: ContainsMatchMode,
	excludedServices: OptionalStringArrayParam,
	excludedSpanNames: OptionalStringArrayParam,
	excludedDeploymentEnvs: OptionalStringArrayParam,
	excludedNamespaces: OptionalStringArrayParam,
	excludedHttpMethods: OptionalStringArrayParam,
	excludedHttpStatusCodes: OptionalStringArrayParam,
	sortBy: Schema.optional(Schema.Literals(["timestamp", "durationMs"])),
	sortDir: SortDirParam,
	...TimeRangeSearchFields,
})

// Nested detail routes

// sessionTimeRangeSearchMiddleware()
export const AgentSessionToolSearch = Schema.Struct({
	...ToolAnalyticsSearchFields,
	...TimeRangeSearchFields,
})

export const AlertIncidentSearch = Schema.Struct({
	alert: Schema.optional(Schema.String),
})

// sessionTimeRangeSearchMiddleware()
export const ErrorIssueSearch = Schema.Struct({
	tab: Schema.optional(Schema.Literals(ISSUE_TABS)),
	...TimeRangeSearchFields,
})

// sessionTimeRangeSearchMiddleware()
export const InfraCloudflareZoneSearch = Schema.Struct({
	...cloudflareFilterSearchFields,
	...TimeRangeSearchFields,
	tab: Schema.optional(Schema.Literals(ZONE_TABS)),
})

// sessionTimeRangeSearchMiddleware()
export const InfraContainerSearch = Schema.Struct({
	host: Schema.optional(Schema.String),
	...TimeRangeSearchFields,
})

// sessionTimeRangeSearchMiddleware()
export const InfraHostSearch = Schema.Struct({
	...TimeRangeSearchFields,
})

// sessionTimeRangeSearchMiddleware()
export const InfraPlanetscaleDatabaseSearch = Schema.Struct({
	branch: Schema.optional(Schema.String),
	...planetscaleFilterSearchFields,
	...TimeRangeSearchFields,
})

// sessionTimeRangeSearchMiddleware()
export const InfraRailwayServiceSearch = Schema.Struct({
	...TimeRangeSearchFields,
	environmentId: Schema.String,
})

// sessionTimeRangeSearchMiddleware()
export const InfraSupabaseProjectSearch = Schema.Struct({
	...TimeRangeSearchFields,
})

// Nested list routes

// sessionTimeRangeSearchMiddleware()
export const AgentSessionToolsSearch = Schema.Struct({
	...ToolAnalyticsSearchFields,
	...TimeRangeSearchFields,
})

// sessionTimeRangeSearchMiddleware()
export const InfraCloudflareSearch = Schema.Struct({
	...TimeRangeSearchFields,
	view: Schema.optional(Schema.Literals(CLOUDFLARE_VIEWS)),
	q: Schema.optional(Schema.String),
	scope: Schema.optional(Schema.Literals([...ZONE_SCOPES, ...WORKER_SCOPES])),
	previews: Schema.optional(Schema.Boolean),
	account: Schema.optional(Schema.String),
})

// sessionTimeRangeSearchMiddleware()
export const InfraContainersSearch = Schema.Struct({
	q: Schema.optional(Schema.String),
	scope: Schema.optional(Schema.Literals(["saturated", "elevated", "stale"])),
	sortBy: Schema.optional(
		Schema.Literals(["saturation", "cpuPct", "memoryPct", "containerName", "lastSeen"]),
	),
	sortDir: SortDirParam,
	containerNames: OptionalStringArrayParam,
	hostNames: OptionalStringArrayParam,
	images: OptionalStringArrayParam,
	composeProjects: OptionalStringArrayParam,
	composeServices: OptionalStringArrayParam,
	environments: OptionalStringArrayParam,
	excludedContainerNames: OptionalStringArrayParam,
	excludedHostNames: OptionalStringArrayParam,
	excludedImages: OptionalStringArrayParam,
	excludedComposeProjects: OptionalStringArrayParam,
	excludedComposeServices: OptionalStringArrayParam,
	excludedEnvironments: OptionalStringArrayParam,
	...TimeRangeSearchFields,
})

// sessionTimeRangeSearchMiddleware()
export const InfraAwsSearch = Schema.Struct({
	tab: Schema.optional(Schema.String),
	scope: Schema.optional(Schema.String),
	region: Schema.optional(Schema.String),
	q: Schema.optional(Schema.String),
	...TimeRangeSearchFields,
})

// sessionTimeRangeSearchMiddleware()
export const InfraGcpSearch = Schema.Struct({
	view: Schema.optional(Schema.String),
	tab: Schema.optional(Schema.String),
	scope: Schema.optional(Schema.String),
	project: Schema.optional(Schema.String),
	region: Schema.optional(Schema.String),
	q: Schema.optional(Schema.String),
	type: Schema.optional(Schema.String),
	...TimeRangeSearchFields,
})

// sessionTimeRangeSearchMiddleware()
export const InfraHostsSearch = Schema.Struct({
	q: Schema.optional(Schema.String),
	scope: Schema.optional(Schema.Literals(["saturated", "elevated", "stale"])),
	...TimeRangeSearchFields,
})

// sessionTimeRangeSearchMiddleware(); beforeLoad redirects to /infra/kubernetes/pods carrying search.
export const InfraKubernetesSearch = Schema.Struct(TimeRangeSearchFields)

// sessionTimeRangeSearchMiddleware()
export const InfraPlanetscaleSearch = Schema.Struct({
	...TimeRangeSearchFields,
})

// sessionTimeRangeSearchMiddleware()
export const InfraRailwaySearch = Schema.Struct({
	q: Schema.optional(Schema.String),
	...TimeRangeSearchFields,
})

// sessionTimeRangeSearchMiddleware()
export const InfraSupabaseSearch = Schema.Struct({
	...TimeRangeSearchFields,
})

// Deeper routes

export const DashboardWidgetSearch = Schema.StructWithRest(Schema.Struct(dashboardViewParamsSchema), [
	variableSearchRest,
])

// sessionTimeRangeSearchMiddleware()
export const InfraCloudflareWorkerSearch = Schema.Struct({
	...TimeRangeSearchFields,
	account: Schema.optional(Schema.String),
})

// sessionTimeRangeSearchMiddleware()
/** The resource's keys after its name, as `AWS_INFRA_KINDS[kind].identity` orders them. */
export const InfraAwsResourceSearch = Schema.Struct({
	cluster: Schema.optional(Schema.String),
	region: Schema.optional(Schema.String),
	account: Schema.optional(Schema.String),
	...TimeRangeSearchFields,
})

// sessionTimeRangeSearchMiddleware()
export const InfraGcpResourceSearch = Schema.Struct({
	project: Schema.optional(Schema.String),
	region: Schema.optional(Schema.String),
	namespace: Schema.optional(Schema.String),
	cluster: Schema.optional(Schema.String),
	location: Schema.optional(Schema.String),
	zone: Schema.optional(Schema.String),
	backend: Schema.optional(Schema.String),
	/**
	 * A Cloud SQL instance's statement open in the side panel, by its Query Insights hash. The hash
	 * is digits, which a hand-written `peek=123` parses as a number.
	 */
	peek: Schema.optional(Schema.Union([Schema.String, DigitsParam])),
	...TimeRangeSearchFields,
})

// sessionTimeRangeSearchMiddleware()
export const InfraKubernetesNodeSearch = Schema.Struct(TimeRangeSearchFields)

// sessionTimeRangeSearchMiddleware()
export const InfraKubernetesPodSearch = Schema.Struct({
	namespace: Schema.optional(Schema.String),
	...TimeRangeSearchFields,
})

// sessionTimeRangeSearchMiddleware()
export const InfraKubernetesServiceSearch = Schema.Struct(TimeRangeSearchFields)

// sessionTimeRangeSearchMiddleware()
export const InfraKubernetesNodesSearch = Schema.Struct({
	q: Schema.optional(Schema.String),
	status: Schema.optional(Schema.Literals(["active", "idle", "ended"])),
	nodeNames: OptionalStringArrayParam,
	clusters: OptionalStringArrayParam,
	environments: OptionalStringArrayParam,
	...TimeRangeSearchFields,
})

// sessionTimeRangeSearchMiddleware()
export const InfraKubernetesPodsSearch = Schema.Struct({
	q: Schema.optional(Schema.String),
	scope: Schema.optional(Schema.Literals(["saturated", "elevated", "unbounded", "ended"])),
	sortBy: Schema.optional(
		Schema.Literals(["saturation", "cpuUsage", "cpuLimitPct", "memoryLimitPct", "podName", "lastSeen"]),
	),
	sortDir: SortDirParam,
	peek: Schema.optional(Schema.String),
	podNames: OptionalStringArrayParam,
	namespaces: OptionalStringArrayParam,
	nodeNames: OptionalStringArrayParam,
	clusters: OptionalStringArrayParam,
	deployments: OptionalStringArrayParam,
	statefulsets: OptionalStringArrayParam,
	daemonsets: OptionalStringArrayParam,
	jobs: OptionalStringArrayParam,
	environments: OptionalStringArrayParam,
	computeTypes: OptionalStringArrayParam,
	excludedPodNames: OptionalStringArrayParam,
	excludedNamespaces: OptionalStringArrayParam,
	excludedNodeNames: OptionalStringArrayParam,
	excludedClusters: OptionalStringArrayParam,
	excludedDeployments: OptionalStringArrayParam,
	excludedStatefulsets: OptionalStringArrayParam,
	excludedDaemonsets: OptionalStringArrayParam,
	excludedJobs: OptionalStringArrayParam,
	excludedEnvironments: OptionalStringArrayParam,
	excludedComputeTypes: OptionalStringArrayParam,
	...TimeRangeSearchFields,
})

// sessionTimeRangeSearchMiddleware()
export const InfraKubernetesServicesSearch = Schema.Struct(TimeRangeSearchFields)

// sessionTimeRangeSearchMiddleware()
export const InfraKubernetesWorkloadsSearch = Schema.Struct({
	kind: Schema.optional(WorkloadKindLiteral),
	q: Schema.optional(Schema.String),
	scope: Schema.optional(Schema.Literals(["saturated", "elevated", "stale"])),
	workloadNames: OptionalStringArrayParam,
	namespaces: OptionalStringArrayParam,
	clusters: OptionalStringArrayParam,
	environments: OptionalStringArrayParam,
	computeTypes: OptionalStringArrayParam,
	...TimeRangeSearchFields,
})

// sessionTimeRangeSearchMiddleware(); params.parse decodes `kind` against the workload-kind literals.
export const InfraKubernetesWorkloadSearch = Schema.Struct({
	namespace: Schema.optional(Schema.String),
	...TimeRangeSearchFields,
})

// Path params of /infra/kubernetes/workloads/$kind/$workloadName.
export const InfraKubernetesWorkloadParams = Schema.Struct({
	kind: WorkloadKindLiteral,
	workloadName: Schema.String,
})

// Security Center
export const SecurityFindingsSearch = Schema.Struct({
	status: Schema.optional(Schema.Literals(["open", "fixed", "dismissed", "accepted_risk", "all"])),
	severity: Schema.optional(Schema.Literals(["critical", "high", "medium", "low", "informational"])),
	verdict: Schema.optional(Schema.Literals(["confirmed", "needs_validation"])),
	target: Schema.optional(Schema.String),
	q: Schema.optional(Schema.String),
	rejected: Schema.optional(Schema.Boolean),
})

export const SecurityRunsSearch = Schema.Struct({
	target: Schema.optional(Schema.String),
})
export type SecurityFindingsSearch = typeof SecurityFindingsSearch.Type
export type SecurityRunsSearch = typeof SecurityRunsSearch.Type
