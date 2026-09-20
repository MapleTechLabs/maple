import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant } from "@maple/domain/http"
import type { V2ChatConnector, V2ChatWorkspace } from "@maple/domain/http/v2"
import {
	MapleApiV2,
	isoTimestamp,
	V2CallbackHostUnavailable,
	V2InsufficientPermissions,
} from "@maple/domain/http/v2"
import { Array as Arr, Effect } from "effect"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { requireAdmin } from "@maple/backend/services/auth/auth"
import { Env } from "@maple/backend/platform/Env"
import type {
	ChatConnectorStatus,
	ChatWorkspaceSummary,
} from "@maple/backend/services/integrations/ChatWorkspaceService"
import {
	chatCallbackPath,
	ChatWorkspaceService,
} from "@maple/backend/services/integrations/ChatWorkspaceService"
import { isTrustedCallbackOrigin, resolveRequestOrigin } from "./integrations.http"

const toWorkspace = (workspace: ChatWorkspaceSummary): V2ChatWorkspace => ({
	id: workspace.id,
	object: "chat_workspace",
	connector: workspace.connector,
	external_workspace_id: workspace.externalWorkspaceId,
	name: workspace.name,
	settings: workspace.settings,
	created_at: isoTimestamp(workspace.createdAt),
})

const toConnector = (status: ChatConnectorStatus): V2ChatConnector => ({
	id: status.connector.id,
	object: "chat_connector",
	name: status.connector.manifest.name,
	available: status.available,
	workspaces: Arr.map(status.workspaces, toWorkspace),
})

export const HttpV2ChatIntegrationsLive = HttpApiBuilder.group(MapleApiV2, "chatIntegration", (handlers) =>
	Effect.gen(function* () {
		const chat = yield* ChatWorkspaceService
		const env = yield* Env

		return (
			handlers
				// No admin gate: the card renders link state for every org member, the
				// same as the other integrations' status reads. Settings are connector
				// configuration, not credentials.
				.handle("connectors", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const statuses = yield* chat.list(tenant.orgId)
						return {
							object: "chat_connector_list" as const,
							data: Arr.map(statuses, toConnector),
						}
					}),
				)
				.handle("install", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireAdmin(tenant.roles, () =>
							V2InsufficientPermissions.make("Only org admins can link a chat workspace"),
						)
						const req = yield* HttpServerRequest.HttpServerRequest
						const origin = resolveRequestOrigin(req)
						// The callback URL is persisted as `oauth_auth_states.redirectUri` and
						// replayed in the token exchange, and the origin is read from a header
						// a client can set — so an untrusted one would mint an authorize URL
						// pointing at a host the caller controls.
						if (!isTrustedCallbackOrigin(origin, env.MAPLE_APP_BASE_URL)) {
							yield* Effect.logError("Rejected chat install: untrusted callback origin", {
								origin,
							})
							return yield* Effect.fail(
								V2CallbackHostUnavailable.make(
									"Chat installs are not available from this host",
								),
							)
						}
						const result = yield* chat.beginInstall(
							tenant.orgId,
							tenant.userId,
							params.connector,
							`${origin}${chatCallbackPath(params.connector)}`,
						)
						yield* recordHttpAudit("chat_integration.install_started", {
							metadata: { connector: params.connector },
						})
						return { object: "chat_connector.install" as const, url: result.url }
					}),
				)
				.handle("updateWorkspace", ({ params, payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireAdmin(tenant.roles, () =>
							V2InsufficientPermissions.make(
								"Only org admins can change chat workspace settings",
							),
						)
						const workspace = yield* chat.updateSettings(
							tenant.orgId,
							params.id,
							payload.settings,
						)
						yield* recordHttpAudit("chat_integration.settings_updated", {
							resourceId: workspace.id,
							metadata: { connector: workspace.connector },
						})
						return toWorkspace(workspace)
					}),
				)
				.handle("deleteWorkspace", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireAdmin(tenant.roles, () =>
							V2InsufficientPermissions.make("Only org admins can unlink a chat workspace"),
						)
						yield* chat.uninstall(tenant.orgId, params.id)
						yield* recordHttpAudit("chat_integration.uninstalled", { resourceId: params.id })
						return { id: params.id, object: "chat_workspace" as const, deleted: true as const }
					}),
				)
		)
	}),
)
