import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentAuditActor } from "@maple/backend/services/auth/audit-actor"
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
	chatIdentityCallbackPath,
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
	supports_identity: status.supportsIdentity,
	// Spread rather than an explicit `undefined`: the field is an optional key,
	// so "not linked" is an absent key on the wire rather than a null.
	...(status.identity === undefined
		? undefined
		: {
				identity: {
					external_user_id: status.identity.externalUserId,
					...(status.identity.displayName === null
						? undefined
						: { display_name: status.identity.displayName }),
					created_at: isoTimestamp(status.identity.createdAtMs),
				},
			}),
})

/**
 * Linking a chat account is a PERSONAL action, so it takes a personal credential.
 *
 * `tenant.userId` is only "whoever is calling" under a signed-in session. Under an API key it is
 * the human who *created* the key (`ApiKeysService.resolveByKey` reads `created_by`), so without
 * this a key scoped to `integrations:write` could bind an attacker's chat account to that human —
 * and every later approval from it would run with their roles, through the Durable Object where
 * the key's scopes are never consulted. Revoking the key would not undo it either; only leaving
 * the org clears a link.
 *
 * Deny by default: `undefined` means the request skipped the standard auth middlewares, and a
 * credential this route cannot identify is not a person.
 */
export const requirePerson = Effect.flatMap(CurrentAuditActor, (info) =>
	info?.type === "user"
		? Effect.void
		: Effect.fail(
				V2InsufficientPermissions.make(
					"Linking a chat account is a personal action — sign in to Maple to link one.",
				),
			),
)

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
						// "Your own link" only means something for a person. Under an API key
						// `tenant.userId` is the human who CREATED the key, so asking for the link
						// would answer with THEIR chat account — an identity the key's holder has no
						// business reading. A non-person gets the org's installs and nothing personal.
						const person = yield* Effect.as(requirePerson, true).pipe(
							Effect.orElseSucceed(() => false),
						)
						const statuses = yield* chat.list(tenant.orgId, person ? tenant.userId : undefined)
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
				// No ADMIN gate on either identity handler: they link and unlink the caller's own
				// chat account, and a link grants nothing beyond the roles that person already
				// holds. What both DO require is that the caller is a person — see `requirePerson`.
				.handle("startChatIdentityLink", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requirePerson
						const req = yield* HttpServerRequest.HttpServerRequest
						const origin = resolveRequestOrigin(req)
						// Same reasoning as the install: the origin is read from a header a
						// client can set, and it is persisted as the state's redirect URI and
						// replayed in the token exchange.
						if (!isTrustedCallbackOrigin(origin, env.MAPLE_APP_BASE_URL)) {
							yield* Effect.logError("Rejected chat account link: untrusted callback origin", {
								origin,
							})
							return yield* Effect.fail(
								V2CallbackHostUnavailable.make(
									"Chat account links are not available from this host",
								),
							)
						}
						const result = yield* chat.beginLink(
							tenant.orgId,
							tenant.userId,
							params.connector,
							`${origin}${chatIdentityCallbackPath(params.connector)}`,
						)
						yield* recordHttpAudit("chat_integration.identity_link_started", {
							metadata: { connector: params.connector },
						})
						return { object: "chat_connector.identity_link" as const, url: result.url }
					}),
				)
				.handle("deleteChatIdentity", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requirePerson
						const result = yield* chat.unlink(tenant.orgId, tenant.userId, params.connector)
						// Only a real removal is audited — unlinking when nothing was linked
						// is a no-op, and an entry for it would claim authority was revoked.
						if (result.unlinked) {
							yield* recordHttpAudit("chat_integration.identity_unlinked", {
								metadata: { connector: params.connector },
							})
						}
						return {
							object: "chat_connector.identity" as const,
							deleted: result.unlinked,
						}
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
