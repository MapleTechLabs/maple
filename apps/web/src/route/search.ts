// The search schema of every route. Shapes match the URLs already in use, so existing links decode.
import { Schema, SchemaGetter } from "effect"
import { MCP_CLIENT_KINDS } from "@maple/domain/mcp-clients"
import { DATA_SOURCE_KINDS } from "@maple/domain/data-sources"
import {
	AiSessionSortDir,
	AiSessionSortKey,
	CiBranchName,
	CiPipelineName,
	CiRunResult,
	CodeReviewSortDir,
	CodeReviewSortKey,
	IssueKind,
	PrReviewCategory,
	PrReviewFindingStatus,
	PrReviewId,
	PrReviewSeverity,
	VcsRepositoryId,
} from "@maple/domain/http"
import { PushSourcePlatform } from "@maple/domain/primitives"
import { QUERY_BUILDER_METRIC_TYPES } from "@maple/query-model"
import { TOOL_METRICS, TOOL_PERCENTILES } from "@maple/web-data/lib/tool-analytics"
import { VARIABLE_PARAM_PREFIX } from "../lib/dashboard-controls/search-params"
import { HUB_SORTS, HUB_VIEWS, LEGACY_HUB_VIEWS, SEVERITY_FILTERS } from "../page/errors/hub/hub-params"

/**
 * A string as a link wrote it. The search format reads an unquoted `404`, `true` or `null` as
 * JSON, so a hand-written `?userId=12345` arrives as a number: it prints back to its text.
 */
const LenientString = Schema.Union([
	Schema.String,
	Schema.Union([Schema.Number, Schema.Boolean, Schema.Null]).pipe(
		Schema.decodeTo(Schema.String, {
			decode: SchemaGetter.transform((value: number | boolean | null) => String(value)),
			// Never reached: the plain string member encodes every string first.
			encode: SchemaGetter.forbidden(() => "A string param is written as a string"),
		}),
	),
])

const StringParam = Schema.optional(LenientString)

const StringArray = Schema.Array(LenientString)
const StringArrayFromJsonString = Schema.fromJsonString(Schema.Array(Schema.String))

export const BooleanFromStringParam = Schema.fromJsonString(Schema.Boolean)

export const NumberFromStringParam = Schema.fromJsonString(Schema.Number)

export const OptionalStringArrayParam = Schema.optional(
	Schema.Union([StringArray, StringArrayFromJsonString]),
)

const BooleanParam = Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam]))
const NumberParam = Schema.optional(Schema.Union([Schema.Number, NumberFromStringParam]))

export const TimeRangeSearchFields = {
	startTime: StringParam,
	endTime: StringParam,
	timePreset: StringParam,
}

export const variableSearchRest = Schema.Record(
	Schema.TemplateLiteral([VARIABLE_PARAM_PREFIX, Schema.String]),
	Schema.Unknown,
)

export const dashboardViewParamsSchema = {
	filter: StringParam,
	collapsed: StringParam,
	expanded: StringParam,
	tab: StringParam,
	widget: StringParam,
	refresh: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
	/** This viewer's time range; read leniently by `timeRangeFromSearch`, so a bad value is ignored. */
	range: Schema.optional(Schema.Unknown),
	from: Schema.optional(Schema.Unknown),
	to: Schema.optional(Schema.Unknown),
}

const ToolAnalyticsSearchFields = {
	metric: Schema.optional(Schema.Literals(TOOL_METRICS)),
	percentile: Schema.optional(Schema.Literals(TOOL_PERCENTILES)),
	tool: StringParam,
	model: StringParam,
	q: StringParam,
	service: StringParam,
	env: StringParam,
	failing: BooleanParam,
	error: StringParam,
	session: StringParam,
	variant: StringParam,
}

const analyticsFilterSearchFields = {
	host: StringParam,
	pagePath: StringParam,
	referrerHost: StringParam,
	country: StringParam,
	deviceType: StringParam,
	browserName: StringParam,
	osName: StringParam,
	language: StringParam,
	utmSource: StringParam,
	utmMedium: StringParam,
	utmCampaign: StringParam,
	visitorType: Schema.optional(Schema.Literals(["new", "returning"])),
	traffic: Schema.optional(Schema.Literals(["all", "humans", "bots"])),
	eventName: StringParam,
}

const CodeReviewSearchFields = {
	repo: Schema.optional(VcsRepositoryId),
	author: StringParam,
	...TimeRangeSearchFields,
}

const CodeReviewIssuesSearchFields = {
	...CodeReviewSearchFields,
	severity: Schema.optional(PrReviewSeverity),
	category: Schema.optional(PrReviewCategory),
	state: Schema.optional(PrReviewFindingStatus),
	q: StringParam,
	review: Schema.optional(PrReviewId),
}

const CodeReviewListSearchFields = {
	...CodeReviewSearchFields,
	status: Schema.optional(Schema.Literals(["completed", "failed", "skipped", "running", "queued"])),
	q: StringParam,
	sortBy: Schema.optional(CodeReviewSortKey),
	sortDir: Schema.optional(CodeReviewSortDir),
	review: Schema.optional(PrReviewId),
}

/** The Team scorecard's sort column; `person` is by login. */
export const CodeReviewTeamSort = Schema.Literals([
	"person",
	"score",
	"merged",
	"mergeTime",
	"fixRate",
	"criticalPerPr",
	"firstTryGreen",
	"rerunRate",
	"shippedClean",
	"ciTime",
])
export type CodeReviewTeamSort = typeof CodeReviewTeamSort.Type

const CodeReviewTeamSearchFields = {
	repo: Schema.optional(VcsRepositoryId),
	...TimeRangeSearchFields,
	sort: Schema.optional(CodeReviewTeamSort),
	/** Ranked: people with enough pull requests, numbered by the sort column. */
	ranked: BooleanParam,
}

const CodeReviewCiSearchFields = {
	...CodeReviewSearchFields,
	pipeline: Schema.optional(CiPipelineName),
	branch: Schema.optional(CiBranchName),
	result: Schema.optional(CiRunResult),
}

// The Cloudflare pages' search: `page/infra-integrations/cloudflare/filters.ts` reads the filters.
const cloudflareFilterSearchFields = {
	hosts: OptionalStringArrayParam,
	cacheStatuses: OptionalStringArrayParam,
	statusClasses: OptionalStringArrayParam,
	paths: OptionalStringArrayParam,
	pathContains: StringParam,
	countries: OptionalStringArrayParam,
	methods: OptionalStringArrayParam,
	protocols: OptionalStringArrayParam,
	deviceTypes: OptionalStringArrayParam,
}

export const CLOUDFLARE_VIEWS = ["zones", "workers", "queues"] as const
export const ZONE_SCOPES = ["serving5xx", "mostly4xx", "lowVolume"] as const
export const WORKER_SCOPES = ["erroring", "slow", "cpuHeavy"] as const
export const ZONE_TABS = ["traffic", "dns", "security"] as const

const planetscaleFilterSearchFields = {
	branches: OptionalStringArrayParam,
	branchStates: OptionalStringArrayParam,
	branchRoles: OptionalStringArrayParam,
	branchContains: StringParam,
}

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
	"data-sources",
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

export const ISSUE_TABS = ["overview", "occurrences", "activity"] as const
export const INVESTIGATION_TABS = ["overview", "evidence", "chat", "transcript"] as const

const SortDirParam = Schema.optional(Schema.Literals(["asc", "desc"]))
const ContainsMatchMode = Schema.optional(Schema.Literals(["contains"]))
const WorkloadKindLiteral = Schema.Literals(["deployment", "statefulset", "daemonset", "job"])

// Not validated: the redirect reads the raw values.
export const ErrorIssuesSearch = Schema.Struct({
	workflowState: Schema.optional(Schema.Unknown),
	severity: Schema.optional(Schema.Unknown),
})

export const HomeSearch = Schema.Struct({
	environment: StringParam,
	...TimeRangeSearchFields,
})

export const AccountSearch = Schema.Struct({
	tab: Schema.optional(Schema.Literals(accountTabValues)),
})

export const CliLoginSearch = Schema.Struct({
	user_code: StringParam,
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
	integration: StringParam,
	chat: StringParam,
	chat_reason: StringParam,
	chat_workspace: StringParam,
	chat_identity: StringParam,
	chat_identity_name: StringParam,
})

export const McpAuthorizeSearch = Schema.Struct({
	request_id: StringParam,
})

export const OrgRequiredSearch = Schema.Struct({
	redirect_url: StringParam,
})

export const QuickStartSearch = Schema.Struct({
	redirect_url: StringParam,
	checkout: Schema.optional(Schema.Literal("complete")),
})

export const SelectPlanSearch = Schema.Struct({
	redirect_url: StringParam,
	checkout: Schema.optional(Schema.Literal("complete")),
})

export const ServiceMapSearch = Schema.Struct({
	view: Schema.optional(Schema.Literals(["2d", "3d"])),
	environment: StringParam,
	focusService: StringParam,
	focusHops: Schema.optional(Schema.Literals([1, 2])),
	focusMode: Schema.optional(Schema.Literals(["dim", "hide"])),
	...TimeRangeSearchFields,
})

export const SettingsSearch = Schema.Struct({
	tab: Schema.optional(Schema.Literals([...settingsTabValues, ...legacySettingsTabValues])),
	checkout: Schema.optional(Schema.Literal("complete")),
	range: StringParam,
	since: StringParam,
	until: StringParam,
	actor: StringParam,
	actor_type: StringParam,
	outcome: StringParam,
	kind: StringParam,
	resource_type: StringParam,
	action: StringParam,
	resource: StringParam,
	affected: StringParam,
	request: StringParam,
	entry: StringParam,
	// Data sources deep links from `/integrations`: one source, or the connect form of a kind.
	source: StringParam,
	connect: Schema.optional(Schema.Literals(DATA_SOURCE_KINDS)),
})

export const SignInSearch = Schema.Struct({
	redirect_url: StringParam,
})

export const SignUpSearch = Schema.Struct({
	redirect_url: StringParam,
})

export const UnsubscribeSearch = Schema.Struct({
	token: StringParam,
})

export const AgentSessionSearch = Schema.Struct({
	t: StringParam,
	end: StringParam,
	view: StringParam,
	span: Schema.optional(LenientString.check(Schema.isMinLength(1), Schema.isTrimmed())),
	tool: Schema.optional(LenientString.check(Schema.isMinLength(1), Schema.isTrimmed())),
})

export const AlertRuleSearch = Schema.Struct({
	tab: StringParam,
	...TimeRangeSearchFields,
})

export const AlertsCreateSearch = Schema.Struct({
	serviceName: StringParam,
	ruleId: StringParam,
	template: StringParam,
	dashboardId: StringParam,
	widgetId: StringParam,
	chart: StringParam,
})

/** `/alerts/uptime/new`: `monitorId` edits that monitor; `serviceName` and `kind` prefill a new one. */
export const AlertsUptimeNewSearch = Schema.Struct({
	monitorId: StringParam,
	serviceName: StringParam,
	kind: StringParam,
})

export const AlertsUptimeMonitorSearch = Schema.Struct({})

/** `/alerts/slos/new`: `sloId` edits that SLO; `serviceName` prefills a new one. */
export const AlertsSloNewSearch = Schema.Struct({
	sloId: StringParam,
	serviceName: StringParam,
})

export const AlertsSloSearch = Schema.Struct({})

/** `/alerts/schedules/new`: `scheduleId` edits that on-call schedule. */
export const AlertsScheduleNewSearch = Schema.Struct({
	scheduleId: StringParam,
})

export const AlertsScheduleSearch = Schema.Struct({})

/** `/settings/ingestion/rules/new`: `template` prefills the editor from an empty-state template. */
export const IngestRuleNewSearch = Schema.Struct({
	template: StringParam,
})

/** The retired `/alerts/status-pages/$pageId`: `tab` picks the view its redirect opens. */
export const AlertsStatusPageSearch = Schema.Struct({
	tab: StringParam,
})

/** `/status-pages/$pageId`: `view` is `appearance`, `settings`, `json` or `live`; none is the page itself. */
export const StatusPageSearch = Schema.Struct({
	view: StringParam,
})

export const CodeReviewCiSearch = Schema.Struct(CodeReviewCiSearchFields)

export const CodeReviewTeamSearch = Schema.Struct(CodeReviewTeamSearchFields)

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
	integration: StringParam,
})

/** Push sources show Setup, integration sources show Connection; a link to the other one falls back. */
export const SOURCE_TABS = ["overview", "setup", "connection", "settings"] as const
export type SourceTab = (typeof SOURCE_TABS)[number]

export const SourceSearch = Schema.Struct({
	tab: Schema.optional(Schema.Literals(SOURCE_TABS)),
})

export const DashboardsTemplatesSearch = Schema.Struct({
	template: StringParam,
})

export const InvestigationSearch = Schema.Struct({
	tab: Schema.optional(Schema.Literals(INVESTIGATION_TABS)),
	action: Schema.optional(Schema.Unknown),
})

export const MetricSearch = Schema.Struct({
	type: Schema.optional(Schema.Literals(QUERY_BUILDER_METRIC_TYPES)),
	agg: Schema.optional(
		Schema.Literals(["avg", "sum", "min", "max", "count", "latest", "rate", "increase"]),
	),
	where: StringParam,
	groupBy: StringParam,
	step: StringParam,
	bd: StringParam,
	...TimeRangeSearchFields,
})

export const ReleaseSearch = Schema.Struct({
	service: StringParam,
	environments: OptionalStringArrayParam,
	...TimeRangeSearchFields,
})

export const ReplaySearch = Schema.Struct({
	t: StringParam,
})

export const ServiceSearch = Schema.Struct({
	tab: StringParam,
	/** The API tab's open endpoint drawer, by normalized span name ("GET /users/{id}"). */
	endpoint: StringParam,
	environments: OptionalStringArrayParam,
	...TimeRangeSearchFields,
})

export const ShareSearch = Schema.StructWithRest(
	Schema.Struct({
		embed: Schema.optional(Schema.Boolean),
		theme: StringParam,
		from: StringParam,
		to: StringParam,
		range: StringParam,
		/** The link creator's IANA zone; a calendar range ("today", "7d") resolves in it. */
		tz: StringParam,
		refresh: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
	}),
	[variableSearchRest],
)

export const TraceSearch = Schema.Struct({
	spanId: StringParam,
	t: StringParam,
	view: Schema.optional(Schema.Literals(["waterfall", "timeline", "flow"])),
})

export const AgentSessionsSearch = Schema.Struct({
	vendors: OptionalStringArrayParam,
	services: OptionalStringArrayParam,
	environments: OptionalStringArrayParam,
	models: OptionalStringArrayParam,
	agents: OptionalStringArrayParam,
	tools: OptionalStringArrayParam,
	q: StringParam,
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

/** The Alerts hub's sections past the Inbox, each at `/alerts/<section>`. */
export const AlertsSection = Schema.Literals([
	"rules",
	"uptime",
	"slos",
	"silences",
	"maintenance",
	"on-call",
	"routing",
])
export type AlertsSection = typeof AlertsSection.Type

/** A hub section: the Inbox at `/alerts`, the rest at `/alerts/<section>`. */
export const AlertsTab = Schema.Union([Schema.Literal("inbox"), AlertsSection])
export type AlertsTab = typeof AlertsTab.Type

const alertsHubSearchFields = {
	serviceName: StringParam,
	status: StringParam,
	/** The Inbox narrowed to one kind of incident: "anomaly" lists anomalies alone. */
	signal: StringParam,
	/** The Anomalies view's incidents: open (the default), "resolved" or "all". */
	anomalyStatus: StringParam,
	/** The Silences tab narrowed to one maintenance window's occurrences (`mw_…`). */
	window: StringParam,
	/** The open side panel (`SHEET_PARAM`): "silence" is the new-silence form. */
	sheet: StringParam,
}

/** `/alerts` and `/alerts/<section>`: the filters every section shares. */
export const AlertsHubSearch = Schema.Struct(alertsHubSearchFields)

/** `/alerts`: a legacy `tab` redirects to its section's own path. */
export const AlertsSearch = Schema.Struct({ tab: StringParam, ...alertsHubSearchFields })

export const AnalyticsSearch = Schema.Struct({
	...analyticsFilterSearchFields,
	...TimeRangeSearchFields,
	tab: StringParam,
	/** The Search tab's Search Console property, when more than one is enabled. */
	site: StringParam,
})

/**
 * `/anomalies`, retired: it only redirects to the Alerts Inbox's Anomalies view. Old links spelled
 * the filters several ways (`services=["a"]`, `services=a`, `service=a`), so every value is read
 * as given and the redirect keeps what it can understand; a malformed one is dropped, never a 404.
 */
export const AnomaliesSearch = Schema.Struct({
	status: Schema.optional(Schema.Unknown),
	services: Schema.optional(Schema.Unknown),
	service: Schema.optional(Schema.Unknown),
})

export const CodeReviewSearch = Schema.Struct(CodeReviewSearchFields)

export const DashboardsSearch = Schema.Struct({
	q: StringParam,
	scope: Schema.optional(Schema.Literals(["all", "favorites"])),
	tags: Schema.optional(StringArray),
	sort: Schema.optional(Schema.Literals(["updated", "created", "name-asc", "name-desc", "widgets"])),
})

export const ErrorsSearch = Schema.Struct({
	service: StringParam,
	env: StringParam,
	kind: Schema.optional(IssueKind),
	regressed: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	view: Schema.optional(Schema.Literals([...HUB_VIEWS, ...LEGACY_HUB_VIEWS])),
	q: StringParam,
	sort: Schema.optional(Schema.Literals(HUB_SORTS)),
	severity: Schema.optional(Schema.Literals(SEVERITY_FILTERS)),
})

export const InfraSearch = Schema.Struct({
	...TimeRangeSearchFields,
})

export const InvestigationsSearch = Schema.Struct({
	view: Schema.optional(Schema.Literals(["active", "history"])),
	kind: Schema.optional(Schema.Literals(["alert", "error", "anomaly", "question", "verification"])),
	sort: Schema.optional(Schema.Literals(["updated", "severity", "confidence"])),
	dir: Schema.optional(Schema.Literals(["asc", "desc"])),
	q: StringParam,
})

/** A where-clause attribute predicate (`/traces` and `/logs` advanced filters). */
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
	/** The advanced filter's clause; the facet params it sets are synced into their own params. */
	whereClause: StringParam,
	attributeFilters: Schema.optional(Schema.Array(AttributeFilterParam)),
	resourceAttributeFilters: Schema.optional(Schema.Array(AttributeFilterParam)),
	columns: OptionalStringArrayParam,
	search: StringParam,
	traceId: StringParam,
	refresh: dashboardViewParamsSchema.refresh,
	...TimeRangeSearchFields,
})

export const MetricsSearch = Schema.Struct({
	q: StringParam,
	type: Schema.optional(Schema.Literals(QUERY_BUILDER_METRIC_TYPES)),
	view: Schema.optional(Schema.Literals(["grid", "table"])),
	...TimeRangeSearchFields,
})

export const ReleasesSearch = Schema.Struct({
	environments: OptionalStringArrayParam,
	excludedEnvironments: OptionalStringArrayParam,
	services: OptionalStringArrayParam,
	impact: Schema.optional(Schema.Literals(["regressed", "watch", "rolling", "healthy"])),
	...TimeRangeSearchFields,
})

export const ReplaysSearch = Schema.Struct({
	service: StringParam,
	browser: StringParam,
	country: StringParam,
	deviceType: StringParam,
	userId: StringParam,
	user: StringParam,
	group: StringParam,
	groupId: StringParam,
	visitorId: StringParam,
	hasErrors: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	durationMin: Schema.optional(Schema.Union([Schema.Number, NumberFromStringParam])),
	durationMax: Schema.optional(Schema.Union([Schema.Number, NumberFromStringParam])),
	activeMin: Schema.optional(Schema.Union([Schema.Number, NumberFromStringParam])),
	activeMax: Schema.optional(Schema.Union([Schema.Number, NumberFromStringParam])),
	q: StringParam,
	page: StringParam,
	tags: OptionalStringArrayParam,
	...TimeRangeSearchFields,
})

/** `/users`: the directory's search, toggles and facet picks (a pinned namespace overrides `namespaces`). */
export const UsersSearch = Schema.Struct({
	q: StringParam,
	hasErrors: BooleanParam,
	hasReplay: BooleanParam,
	namespaces: OptionalStringArrayParam,
	groups: OptionalStringArrayParam,
	/** `group`: one row per `identify()` group instead of per user. */
	groupBy: Schema.optional(Schema.Literal("group")),
	...TimeRangeSearchFields,
})

/** `/users/$userId`'s tabs; absent in the URL is `activity`. */
export const USER_DETAIL_TABS = ["activity", "sessions", "mcp", "errors", "traces", "logs", "events"] as const
export type UserDetailTab = (typeof USER_DETAIL_TABS)[number]

/** `/users/$userId`: the tab and a namespace picked on the page (the org pin overrides it). */
export const UserDetailSearch = Schema.Struct({
	tab: Schema.optional(Schema.Literals(USER_DETAIL_TABS)),
	namespace: StringParam,
	...TimeRangeSearchFields,
})

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
	whereClause: StringParam,
	attributeFilters: Schema.optional(Schema.Array(AttributeFilterParam)),
	resourceAttributeFilters: Schema.optional(Schema.Array(AttributeFilterParam)),
	peek: StringParam,
	peekRow: StringParam,
	peekT: StringParam,
	peekSpan: StringParam,
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

export const AgentSessionToolSearch = Schema.Struct({
	...ToolAnalyticsSearchFields,
	...TimeRangeSearchFields,
})

export const AlertIncidentSearch = Schema.Struct({})

export const ErrorIssueSearch = Schema.Struct({
	tab: Schema.optional(Schema.Literals(ISSUE_TABS)),
	...TimeRangeSearchFields,
})

export const InfraCloudflareZoneSearch = Schema.Struct({
	...cloudflareFilterSearchFields,
	...TimeRangeSearchFields,
	tab: Schema.optional(Schema.Literals(ZONE_TABS)),
})

export const InfraContainerSearch = Schema.Struct({
	host: StringParam,
	...TimeRangeSearchFields,
})

export const InfraHostSearch = Schema.Struct({
	...TimeRangeSearchFields,
})

export const InfraPlanetscaleDatabaseSearch = Schema.Struct({
	branch: StringParam,
	...planetscaleFilterSearchFields,
	...TimeRangeSearchFields,
})

export const InfraRailwayServiceSearch = Schema.Struct({
	...TimeRangeSearchFields,
	environmentId: LenientString,
})

export const InfraSupabaseProjectSearch = Schema.Struct({
	...TimeRangeSearchFields,
})

/** `/mcp-servers`, a server, its tool page and its sessions share one search: the time range and the toolbar. */
export const McpServersSearch = Schema.Struct({
	...TimeRangeSearchFields,
	client: StringParam,
	kind: Schema.optional(Schema.Literals(MCP_CLIENT_KINDS)),
	q: StringParam,
	failing: Schema.optional(Schema.Boolean),
	metric: Schema.optional(Schema.Literals(["calls", "error_rate", "duration", "clients"])),
	percentile: Schema.optional(Schema.Literals(["p50", "p90", "p95"])),
	identity: Schema.optional(Schema.Literals(["ua", "info"])),
	calls: Schema.optional(Schema.Literals(["slowest", "failed", "recent"])),
})

export const AgentSessionToolsSearch = Schema.Struct({
	...ToolAnalyticsSearchFields,
	...TimeRangeSearchFields,
})

export const InfraCloudflareSearch = Schema.Struct({
	...TimeRangeSearchFields,
	view: Schema.optional(Schema.Literals(CLOUDFLARE_VIEWS)),
	q: StringParam,
	scope: Schema.optional(Schema.Literals([...ZONE_SCOPES, ...WORKER_SCOPES])),
	previews: Schema.optional(Schema.Boolean),
	account: StringParam,
})

export const InfraContainersSearch = Schema.Struct({
	q: StringParam,
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

export const InfraAwsSearch = Schema.Struct({
	tab: StringParam,
	scope: StringParam,
	region: StringParam,
	q: StringParam,
	...TimeRangeSearchFields,
})

export const InfraGcpSearch = Schema.Struct({
	view: StringParam,
	tab: StringParam,
	scope: StringParam,
	project: StringParam,
	region: StringParam,
	q: StringParam,
	type: StringParam,
	...TimeRangeSearchFields,
})

export const InfraHostsSearch = Schema.Struct({
	q: StringParam,
	scope: Schema.optional(Schema.Literals(["saturated", "elevated", "stale"])),
	...TimeRangeSearchFields,
})

export const InfraKubernetesSearch = Schema.Struct(TimeRangeSearchFields)

export const InfraPlanetscaleSearch = Schema.Struct({
	...TimeRangeSearchFields,
})

export const InfraRailwaySearch = Schema.Struct({
	q: StringParam,
	...TimeRangeSearchFields,
})

export const InfraSupabaseSearch = Schema.Struct({
	...TimeRangeSearchFields,
})

export const DashboardWidgetSearch = Schema.StructWithRest(Schema.Struct(dashboardViewParamsSchema), [
	variableSearchRest,
])

export const InfraCloudflareWorkerSearch = Schema.Struct({
	...TimeRangeSearchFields,
	account: StringParam,
})

/** The resource's keys after its name, as `AWS_INFRA_KINDS[kind].identity` orders them. */
export const InfraAwsResourceSearch = Schema.Struct({
	cluster: StringParam,
	region: StringParam,
	account: StringParam,
	...TimeRangeSearchFields,
})

export const InfraGcpResourceSearch = Schema.Struct({
	project: StringParam,
	region: StringParam,
	namespace: StringParam,
	cluster: StringParam,
	location: StringParam,
	zone: StringParam,
	backend: StringParam,
	/** A Cloud SQL instance's statement open in the side panel, by its Query Insights hash (digits). */
	peek: StringParam,
	...TimeRangeSearchFields,
})

export const InfraKubernetesNodeSearch = Schema.Struct(TimeRangeSearchFields)

export const InfraKubernetesPodSearch = Schema.Struct({
	namespace: StringParam,
	...TimeRangeSearchFields,
})

export const InfraKubernetesServiceSearch = Schema.Struct(TimeRangeSearchFields)

export const InfraKubernetesNodesSearch = Schema.Struct({
	q: StringParam,
	status: Schema.optional(Schema.Literals(["active", "idle", "ended"])),
	nodeNames: OptionalStringArrayParam,
	clusters: OptionalStringArrayParam,
	environments: OptionalStringArrayParam,
	...TimeRangeSearchFields,
})

export const InfraKubernetesPodsSearch = Schema.Struct({
	q: StringParam,
	scope: Schema.optional(Schema.Literals(["saturated", "elevated", "unbounded", "ended"])),
	sortBy: Schema.optional(
		Schema.Literals(["saturation", "cpuUsage", "cpuLimitPct", "memoryLimitPct", "podName", "lastSeen"]),
	),
	sortDir: SortDirParam,
	peek: StringParam,
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

export const InfraKubernetesServicesSearch = Schema.Struct(TimeRangeSearchFields)

export const InfraKubernetesWorkloadsSearch = Schema.Struct({
	kind: Schema.optional(WorkloadKindLiteral),
	q: StringParam,
	scope: Schema.optional(Schema.Literals(["saturated", "elevated", "stale"])),
	workloadNames: OptionalStringArrayParam,
	namespaces: OptionalStringArrayParam,
	clusters: OptionalStringArrayParam,
	environments: OptionalStringArrayParam,
	computeTypes: OptionalStringArrayParam,
	...TimeRangeSearchFields,
})

export const InfraKubernetesWorkloadSearch = Schema.Struct({
	namespace: StringParam,
	...TimeRangeSearchFields,
})

// Path params of /infra/kubernetes/workloads/$kind/$workloadName.
export const InfraKubernetesWorkloadParams = Schema.Struct({
	kind: WorkloadKindLiteral,
	workloadName: Schema.String,
})

export const SecurityFindingsSearch = Schema.Struct({
	status: Schema.optional(Schema.Literals(["open", "fixed", "dismissed", "accepted_risk", "all"])),
	/** A severity, or the unscored leads: the tiles' one filter. */
	severity: Schema.optional(
		Schema.Literals(["critical", "high", "medium", "low", "informational", "needs_validation"]),
	),
	target: StringParam,
	q: StringParam,
	rejected: Schema.optional(Schema.Boolean),
})

export const SecurityRunsSearch = Schema.Struct({
	target: StringParam,
})
/** One repository's breakdown on the Dependencies tab; absent shows them all. */
export const SecurityDependenciesSearch = Schema.Struct({
	repo: StringParam,
	/** The repositories or advisories table; absent shows the matrix, or a repository's upgrade plan. */
	view: Schema.optional(Schema.Literals(["repositories", "advisories"])),
})

export type SecurityFindingsSearch = typeof SecurityFindingsSearch.Type
export type SecurityRunsSearch = typeof SecurityRunsSearch.Type
export type SecurityDependenciesSearch = typeof SecurityDependenciesSearch.Type
