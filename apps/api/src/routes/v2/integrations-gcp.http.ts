import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant } from "@maple/domain/http"
import type { V2GcpConnector } from "@maple/domain/http/v2"
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

// Reading the status is open to every member. Everything else is admin-only: a connector decides
// which project may write logs into the org, and its setup script carries the push secret.
const adminOnly = () => V2InsufficientPermissions.make("Only org admins can manage Google Cloud connectors")

const toV2Connector = (connector: GcpConnector): V2GcpConnector => ({
	id: connector.id,
	object: "gcp_connector",
	project_id: connector.projectId,
	created_at: isoTimestamp(connector.createdAt),
	last_log_received_at: isoTimestampOrNull(connector.lastLogReceivedAt),
	last_log_error: connector.lastLogError,
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
					const connector = yield* gcp.create(tenant.orgId, tenant.userId, payload.project_id)
					yield* recordHttpAudit("gcp_connector.created", {
						resourceId: connector.id,
						metadata: { project_id: connector.projectId },
					})
					return toV2Connector(connector)
				}),
			)
			.handle("setupScripts", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, adminOnly)
					const scripts = yield* gcp.scripts(tenant.orgId, params.id, {
						excludeGkeContainerLogs: payload.exclude_gke_container_logs === true,
					})
					return {
						object: "gcp_connector.setup_scripts" as const,
						setup_script: scripts.setupScript,
						cleanup_script: scripts.cleanupScript,
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
						metadata: { project_id: deleted.projectId },
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
