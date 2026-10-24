import type { ColumnDefs, PgSchemaTable } from "@maple-dev/effect-orm/postgres"
import { AgentFeedback } from "./agent-feedback"
import { AiTriageSettings } from "./ai-triage"
import {
	AlertDestinations,
	AlertRules,
	AlertRuleClaims,
	AlertRuleStates,
	AlertIncidents,
	AlertDeliveryEvents,
} from "./alerts"
import { AnomalyDetectorSettings, AnomalyDetectorStates, AnomalyIncidents } from "./anomalies"
import { ApiKeys } from "./api-keys"
import { CancellationReviews } from "./cancellation-reviews"
import { ChatIdentities } from "./chat-identities"
import { ChatWorkspaces } from "./chat-workspaces"
import { CliDeviceAuthorizations } from "./cli-device-authorizations"
import { CloudflareAnalyticsState } from "./cloudflare-analytics-state"
import { CloudflareHyperdriveConfigs } from "./cloudflare-hyperdrive-configs"
import { CloudflareLogpushConnectors } from "./cloudflare-logpush-connectors"
import { DashboardShares } from "./dashboard-shares"
import { Dashboards, DashboardVersions } from "./dashboards"
import { DeviceCredentials, DeviceProofReplays } from "./device-credentials"
import { DigestSubscriptions } from "./digest"
import {
	Actors,
	ErrorIssues,
	ErrorFingerprintCandidates,
	ErrorIssueEvents,
	ErrorIssueStates,
	ErrorIncidents,
	ErrorNotificationPolicies,
	ErrorTickStates,
	ErrorNotificationDeliveries,
	ErrorIssuePullRequests,
	ErrorIssueVerifications,
} from "./errors"
import { IssueEscalationPolicies, IssueEscalations } from "./escalations"
import { AwsConnections } from "./aws-connections"
import { GcpConnectors } from "./gcp-connectors"
import { GcpResources } from "./gcp-resources"
import { Investigations } from "./investigations"
import { LiveActivities } from "./live-activities"
import { McpOAuthClients, McpOAuthAuthorizations, McpOAuthRefreshTokens } from "./mcp-oauth"
import { MobileDevices } from "./mobile-devices"
import { OAuthConnections, OAuthAuthStates } from "./oauth-connections"
import { OrgOnboardingState } from "./onboarding"
import { OrgClickHouseSchemaApplyRuns } from "./org-clickhouse-schema-apply-runs"
import { OrgClickHouseSettings } from "./org-clickhouse-settings"
import { OrgIngestAttributeMappings } from "./org-ingest-attribute-mappings"
import { OrgIngestKeys } from "./org-ingest-keys"
import { OrgIngestSamplingPolicies } from "./org-ingest-sampling-policies"
import { Sources } from "./sources"
import { OrgRecommendationIssues } from "./org-recommendation-issues"
import { PlanetscaleConnections } from "./planetscale-connections"
import {
	PlanetscalePollState,
	PlanetscaleDatabases,
	PlanetscaleEvents,
	PlanetscaleIssueReceipts,
} from "./planetscale-inventory"
import { OrgOpenRouterKeys } from "./openrouter-keys"
import { RailwayConnections, RailwayEnvironments } from "./railway"
import { ScrapeTargets, ScrapeTargetChecks } from "./scrape-targets"
import {
	SecurityAuditEvents,
	SecurityAuditFindings,
	SecurityAuditOrgReservations,
	SecurityAuditOrgUsage,
	SecurityAuditRunFindings,
	SecurityAuditRuns,
	SecurityAuditTargets,
	SecurityAuditUnits,
} from "./security-audit"
import { SupabaseConnections, SupabaseProjectInsights, SupabaseProjects } from "./supabase"
import { OrgSupportChannels } from "./support-channels"
import {
	VcsInstallations,
	VcsRepositories,
	VcsCommits,
	VcsRepositoryBranches,
	PrReviews,
	PrReviewFindings,
	PrReviewFindingEmbeddings,
	PrReviewMergeSteps,
	PrReviewReplies,
	PrReviewEdits,
	PrReviewSettings,
} from "./vcs"

export * from "./agent-feedback"
export * from "./ai-triage"
export * from "./alerts"
export * from "./anomalies"
export * from "./api-keys"
export * from "./cancellation-reviews"
export * from "./chat-identities"
export * from "./chat-workspaces"
export * from "./cli-device-authorizations"
export * from "./cloudflare-analytics-state"
export * from "./cloudflare-hyperdrive-configs"
export * from "./cloudflare-logpush-connectors"
export * from "./dashboard-shares"
export * from "./dashboards"
export * from "./device-credentials"
export * from "./digest"
export * from "./errors"
export * from "./escalations"
export * from "./aws-connections"
export * from "./gcp-connectors"
export * from "./gcp-resources"
export * from "./investigations"
export * from "./live-activities"
export * from "./mcp-oauth"
export * from "./mobile-devices"
export * from "./oauth-connections"
export * from "./onboarding"
export * from "./org-clickhouse-schema-apply-runs"
export * from "./org-clickhouse-settings"
export * from "./org-ingest-attribute-mappings"
export * from "./org-ingest-keys"
export * from "./org-ingest-sampling-policies"
export * from "./org-recommendation-issues"
export * from "./planetscale-connections"
export * from "./planetscale-inventory"
export * from "./openrouter-keys"
export * from "./railway"
export * from "./scrape-targets"
export * from "./security-audit"
export * from "./sources"
export * from "./supabase"
export * from "./support-channels"
export * from "./vcs"

/** Every table the application database has, for schema checks and DDL. */
export const allTables: ReadonlyArray<PgSchemaTable<string, ColumnDefs, string>> = [
	AgentFeedback,
	AiTriageSettings,
	AlertDestinations,
	AlertRules,
	AlertRuleClaims,
	AlertRuleStates,
	AlertIncidents,
	AlertDeliveryEvents,
	AnomalyDetectorSettings,
	AnomalyDetectorStates,
	AnomalyIncidents,
	ApiKeys,
	CancellationReviews,
	ChatIdentities,
	ChatWorkspaces,
	CliDeviceAuthorizations,
	CloudflareAnalyticsState,
	CloudflareHyperdriveConfigs,
	CloudflareLogpushConnectors,
	DashboardShares,
	Dashboards,
	DashboardVersions,
	DeviceCredentials,
	DeviceProofReplays,
	DigestSubscriptions,
	Actors,
	ErrorIssues,
	ErrorFingerprintCandidates,
	ErrorIssueEvents,
	ErrorIssueStates,
	ErrorIncidents,
	ErrorNotificationPolicies,
	ErrorTickStates,
	ErrorNotificationDeliveries,
	ErrorIssuePullRequests,
	ErrorIssueVerifications,
	IssueEscalationPolicies,
	IssueEscalations,
	GcpConnectors,
	GcpResources,
	AwsConnections,
	Investigations,
	LiveActivities,
	McpOAuthClients,
	McpOAuthAuthorizations,
	McpOAuthRefreshTokens,
	MobileDevices,
	OAuthConnections,
	OAuthAuthStates,
	OrgOnboardingState,
	OrgClickHouseSchemaApplyRuns,
	OrgClickHouseSettings,
	OrgIngestAttributeMappings,
	OrgIngestKeys,
	OrgIngestSamplingPolicies,
	OrgOpenRouterKeys,
	Sources,
	OrgRecommendationIssues,
	PlanetscaleConnections,
	PlanetscalePollState,
	PlanetscaleDatabases,
	PlanetscaleEvents,
	PlanetscaleIssueReceipts,
	RailwayConnections,
	RailwayEnvironments,
	ScrapeTargets,
	ScrapeTargetChecks,
	SecurityAuditTargets,
	SecurityAuditRuns,
	SecurityAuditUnits,
	SecurityAuditRunFindings,
	SecurityAuditFindings,
	SecurityAuditEvents,
	SecurityAuditOrgUsage,
	SecurityAuditOrgReservations,
	SupabaseConnections,
	SupabaseProjects,
	SupabaseProjectInsights,
	OrgSupportChannels,
	VcsInstallations,
	VcsRepositories,
	VcsCommits,
	VcsRepositoryBranches,
	PrReviews,
	PrReviewFindings,
	PrReviewFindingEmbeddings,
	PrReviewMergeSteps,
	PrReviewReplies,
	PrReviewEdits,
	PrReviewSettings,
]
