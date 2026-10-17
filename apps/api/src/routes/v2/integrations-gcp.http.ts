import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant } from "@maple/domain/http"
import type { V2GcpConnector, V2GcpManualSetup } from "@maple/domain/http/v2"
import {
	MapleApiV2,
	isoTimestamp,
	isoTimestampOrNull,
	V2InsufficientPermissions,
} from "@maple/domain/http/v2"
import { Effect } from "effect"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { requireAdmin } from "@maple/backend/services/auth/auth"
import {
	GcpConnectorService,
	type GcpConnector,
} from "@maple/backend/services/integrations/GcpConnectorService"
import type { GcpSetupPlan } from "@maple/backend/services/integrations/gcp/setup-plan"

// Reading the status is open to every member. Everything else is admin-only: a connector decides
// what may write logs into the org and what Maple reads, and its setup script carries the push
// secret.
const adminOnly = () => V2InsufficientPermissions.make("Only org admins can manage Google Cloud connectors")

const toV2Connector = (connector: GcpConnector): V2GcpConnector => ({
	id: connector.id,
	object: "gcp_connector",
	scope_type: connector.scopeType,
	scope_id: connector.scopeId,
	project_id: connector.projectId,
	logs_enabled: connector.logsEnabled,
	metrics_enabled: connector.metricsEnabled,
	created_at: isoTimestamp(connector.createdAt),
	last_log_received_at: isoTimestampOrNull(connector.lastLogReceivedAt),
	last_log_error: connector.lastLogError,
	applied_logs_enabled: connector.appliedLogsEnabled,
	applied_metrics_enabled: connector.appliedMetricsEnabled,
	setup_reported_at: isoTimestampOrNull(connector.setupReportedAt),
	last_metrics_received_at: isoTimestampOrNull(connector.lastMetricsReceivedAt),
	last_metrics_error: connector.lastMetricsError,
	discovered_project_count: connector.discoveredProjectCount,
	last_resources_error: connector.lastResourcesError,
})

const toV2ManualSetup = ({ logs, reader, ...plan }: GcpSetupPlan): V2GcpManualSetup => ({
	scope_type: plan.scopeType,
	scope_id: plan.scopeId,
	project_id: plan.projectId,
	apis: plan.apis,
	logs:
		logs === null
			? null
			: {
					topic: logs.topic,
					subscription: logs.subscription,
					sink: logs.sink,
					sink_destination: logs.sinkDestination,
					log_filter: logs.logFilter,
					include_children: logs.includeChildren,
					push_endpoint: logs.pushEndpoint,
					push_service_account_id: logs.pushServiceAccountId,
					push_service_account_email: logs.pushServiceAccountEmail,
					ack_deadline_seconds: logs.ackDeadlineSeconds,
					message_retention_seconds: logs.messageRetentionSeconds,
					min_retry_delay_seconds: logs.minRetryDelaySeconds,
					max_retry_delay_seconds: logs.maxRetryDelaySeconds,
				},
	reader:
		reader === null
			? null
			: {
					service_account_id: reader.serviceAccountId,
					service_account_email: reader.serviceAccountEmail,
					maple_service_account_email: reader.mapleServiceAccountEmail,
					scope_roles: reader.scopeRoles,
					project_roles: reader.projectRoles,
				},
})

const auditMetadata = (connector: GcpConnector) => ({
	scope_type: connector.scopeType,
	scope_id: connector.scopeId,
	project_id: connector.projectId,
	logs_enabled: connector.logsEnabled,
	metrics_enabled: connector.metricsEnabled,
})

export const HttpV2GcpIntegrationsLive = HttpApiBuilder.group(MapleApiV2, "gcpIntegration", (handlers) =>
	Effect.gen(function* () {
		const gcp = yield* GcpConnectorService

		return handlers
			.handle("status", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const status = yield* gcp.status(tenant.orgId)
					return {
						object: "gcp_integration" as const,
						metrics_available: status.metricsAvailable,
						connectors: status.connectors.map(toV2Connector),
					}
				}),
			)
			.handle("createConnector", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, adminOnly)
					const connector = yield* gcp.create(tenant.orgId, tenant.userId, {
						scopeType: payload.scope_type,
						scopeId: payload.scope_id,
						// A project hosts its own resources; the contract rejects any other value.
						projectId: payload.scope_type === "project" ? payload.scope_id : payload.project_id,
						logsEnabled: payload.logs_enabled ?? true,
						metricsEnabled: payload.metrics_enabled ?? false,
					})
					yield* recordHttpAudit("gcp_connector.created", {
						resourceId: connector.id,
						metadata: auditMetadata(connector),
					})
					return toV2Connector(connector)
				}),
			)
			.handle("updateConnector", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, adminOnly)
					const connector = yield* gcp.update(tenant.orgId, params.id, {
						logsEnabled: payload.logs_enabled,
						metricsEnabled: payload.metrics_enabled,
					})
					yield* recordHttpAudit("gcp_connector.updated", {
						resourceId: connector.id,
						metadata: auditMetadata(connector),
					})
					return toV2Connector(connector)
				}),
			)
			.handle("setupScripts", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, adminOnly)
					const scripts = yield* gcp.scripts(tenant.orgId, params.id, {
						applicationLogs: payload.application_logs ?? null,
					})
					return {
						object: "gcp_connector.setup_scripts" as const,
						setup_script: scripts.setupScript,
						cleanup_script: scripts.cleanupScript,
						manual: toV2ManualSetup(scripts.plan),
						terraform: scripts.terraform,
						alchemy: scripts.alchemy,
					}
				}),
			)
			.handle("checkAccess", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, adminOnly)
					const checked = yield* gcp.checkAccess(tenant.orgId, params.id)
					return {
						object: "gcp_connector.access_check" as const,
						ok: checked.ok,
						message: checked.message,
						failed_step: checked.failedStep,
					}
				}),
			)
			.handle("deleteConnector", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, adminOnly)
					const deleted = yield* gcp.delete(tenant.orgId, params.id)
					yield* recordHttpAudit("gcp_connector.deleted", {
						resourceId: params.id,
						metadata: auditMetadata(deleted.connector),
					})
					return {
						id: params.id,
						object: "gcp_connector" as const,
						deleted: true as const,
						cleanup_script: deleted.cleanupScript,
					}
				}),
			)
	}),
)
