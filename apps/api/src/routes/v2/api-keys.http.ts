import { HttpApiBuilder } from "effect/http-api"
import type { ApiKeyCreatedResponse, ApiKeyResponse } from "@maple/domain/http"
import { CurrentTenant } from "@maple/domain/http"
import {
	MapleApiV2,
	isoTimestamp,
	isoTimestampOrNull,
	paginateArray,
	V2InsufficientPermissions,
	scopeAllows,
} from "@maple/domain/http/v2"
import type { V2ApiKey, V2ApiKeyMutationResponse, V2ApiKeyWithSecret } from "@maple/domain/http/v2"
import { Clock, Effect, Option, Array as Arr, String as Str } from "effect"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { CurrentAuditActor } from "@maple/backend/services/auth/audit-actor"
import * as Policy from "@maple/domain/policy"

const beyondCallerScopes = () =>
	V2InsufficientPermissions.make("A scoped API key cannot manage a key with broader access than its own")

/**
 * Whether a caller holding `caller` scopes may hand out or take over a key with
 * `granted` scopes. Unscoped callers may; a scoped caller only within its own.
 */
const withinCallerScopes = (
	caller: ReadonlyArray<string> | undefined,
	granted: ReadonlyArray<string> | null | undefined,
): boolean => {
	if (caller === undefined) return true
	if (granted == null || granted.length === 0) return false
	return Arr.every(granted, (scope) => {
		if (scope === "*") return caller.includes("*")
		const [family, access] = Str.split(":")(scope)
		return (
			family !== undefined &&
			(access === "read" || access === "write") &&
			scopeAllows(caller, { family, access })
		)
	})
}

type ApiKeyFields = Pick<
	ApiKeyResponse,
	| "id"
	| "name"
	| "description"
	| "keyPrefix"
	| "kind"
	| "scopes"
	| "revoked"
	| "revokedAt"
	| "lastUsedAt"
	| "expiresAt"
	| "createdAt"
	| "createdBy"
	| "createdByEmail"
>

const toV2ApiKey = (key: ApiKeyFields): V2ApiKey => ({
	id: key.id,
	object: "api_key",
	name: key.name,
	description: key.description,
	key_prefix: key.keyPrefix,
	kind: key.kind,
	scopes: key.scopes,
	revoked: key.revoked,
	revoked_at: isoTimestampOrNull(key.revokedAt),
	last_used_at: isoTimestampOrNull(key.lastUsedAt),
	expires_at: isoTimestampOrNull(key.expiresAt),
	created_at: isoTimestamp(key.createdAt),
	created_by: key.createdBy,
	created_by_email: key.createdByEmail,
})

const toV2ApiKeyWithSecret = (key: ApiKeyCreatedResponse): V2ApiKeyWithSecret => ({
	...toV2ApiKey(key),
	...(key.txid !== undefined ? { txid: key.txid } : undefined),
	secret: key.secret,
})

const toV2ApiKeyMutationResponse = (key: ApiKeyResponse): V2ApiKeyMutationResponse => ({
	...toV2ApiKey(key),
	...(key.txid !== undefined ? { txid: key.txid } : undefined),
})

export const HttpV2ApiKeysLive = HttpApiBuilder.group(MapleApiV2, "apiKeys", (handlers) =>
	Effect.gen(function* () {
		const apiKeysService = yield* ApiKeysService
		const auth = yield* AuthService

		/**
		 * When the request came from a non-admin's API key that expires: that expiry, which no key
		 * it mints or rolls may pass, or signing out of a device would leave its access behind.
		 * Null for sessions, admins (they manage lifetimes as they see fit) and keys with no expiry.
		 */
		const callerExpiry = Effect.fnUntraced(function* (tenant: CurrentTenant.TenantContext) {
			const actor = yield* CurrentAuditActor
			if (Policy.can(tenant.roles, "api_keys:manage")) return null
			if (actor?.type !== "api_key" || actor.apiKeyId === undefined) return null
			// Gone since it authenticated this request: it was revoked, so it mints nothing.
			const caller = yield* apiKeysService
				.get(tenant.orgId, actor.apiKeyId)
				.pipe(
					Effect.catchTag("@maple/http/errors/ApiKeyNotFoundError", () =>
						Effect.fail(
							V2InsufficientPermissions.make("The calling API key is no longer valid."),
						),
					),
				)
			return caller.expiresAt
		})

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const response = yield* apiKeysService.list(tenant.orgId)
					const page = yield* paginateArray(Arr.map(response.keys, toV2ApiKey), query)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const key = yield* apiKeysService.get(tenant.orgId, params.id)
					return toV2ApiKey(key)
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					// MCP keys are per-developer credentials any member may mint for
					// themselves. Admins create standard keys with any access; engineers
					// create restricted ones, limited to the scopes they could use. Both
					// non-admin kinds pin the creator's roles onto the key so it carries no
					// more authority than they have (an unpinned key resolves as `root`).
					const isMcpKey = payload.kind === "mcp"
					const canManageKeys = Policy.can(tenant.roles, "api_keys:manage")
					if (!isMcpKey && !canManageKeys) {
						yield* Policy.check(tenant.roles, "api_keys:create_restricted", (denial) =>
							V2InsufficientPermissions.make(denial.message),
						)
						if (!Policy.canGrantScopes((p) => Policy.can(tenant.roles, p), payload.scopes)) {
							return yield* V2InsufficientPermissions.make(
								"Only org admins can create an API key with full access or with these scopes. Pick the resource families you can use yourself.",
							)
						}
					}
					// MCP keys carry no scopes, so a scoped caller can never mint one.
					if (
						tenant.scopes !== undefined &&
						(isMcpKey || !withinCallerScopes(tenant.scopes, payload.scopes))
					) {
						return yield* beyondCallerScopes()
					}
					const ceiling = yield* callerExpiry(tenant)
					if (ceiling !== null) {
						const now = yield* Clock.currentTimeMillis
						if (
							payload.expires_in_seconds === undefined ||
							now + payload.expires_in_seconds * 1000 > ceiling
						) {
							return yield* V2InsufficientPermissions.make(
								"A key created with an expiring API key cannot outlive it. Set expires_in_seconds within the calling key's remaining lifetime, or create the key from a signed-in session.",
							)
						}
					}
					const pinnedSource = isMcpKey ? "maple_mcp" : canManageKeys ? null : "maple_api_key"
					const createdByEmail = yield* auth.getUserEmail(tenant.userId)
					const created = yield* apiKeysService.create(tenant.orgId, tenant.userId, {
						name: payload.name,
						description: payload.description,
						expiresInSeconds: payload.expires_in_seconds,
						...(ceiling !== null ? { expiresAtCeiling: ceiling } : undefined),
						kind: payload.kind,
						scopes: payload.scopes,
						createdByEmail,
						...(pinnedSource !== null
							? { metadataJson: { source: pinnedSource, roles: [...tenant.roles] } }
							: undefined),
					})
					yield* recordHttpAudit("api_key.created", {
						resourceId: created.id,
						metadata: { name: created.name, kind: created.kind, scopes: created.scopes },
					})
					return toV2ApiKeyWithSecret(created)
				}),
			)
			.handle("roll", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const existing = yield* apiKeysService.get(tenant.orgId, params.id)
					// An engineer may roll a standard key they created, when it carries no more
					// than their role now holds: a key made while they were admin stays an admin's.
					if (!Policy.can(tenant.roles, "api_keys:manage")) {
						const isOwnStandardKey =
							existing.kind === "standard" && existing.createdBy === tenant.userId
						if (!isOwnStandardKey) {
							yield* Policy.check(tenant.roles, "api_keys:manage", (denial) =>
								V2InsufficientPermissions.make(denial.message),
							)
						}
						yield* Policy.check(tenant.roles, "api_keys:create_restricted", (denial) =>
							V2InsufficientPermissions.make(denial.message),
						)
						const pinned = yield* apiKeysService.pinnedRoles(tenant.orgId, params.id)
						const withinRole = Option.match(pinned, {
							onNone: () => false,
							onSome: (roles) =>
								!Policy.outranks(Policy.highestRole(roles), Policy.highestRole(tenant.roles)),
						})
						if (
							!withinRole ||
							!Policy.canGrantScopes((p) => Policy.can(tenant.roles, p), existing.scopes)
						) {
							return yield* V2InsufficientPermissions.make(
								"Only org admins can roll a key with more access than your role has.",
							)
						}
					}
					if (!withinCallerScopes(tenant.scopes, existing.scopes)) {
						return yield* beyondCallerScopes()
					}
					// The successor keeps the rolled key's expiry, and its secret goes to the caller.
					const ceiling = yield* callerExpiry(tenant)
					if (ceiling !== null && (existing.expiresAt === null || existing.expiresAt > ceiling)) {
						return yield* V2InsufficientPermissions.make(
							"An expiring API key cannot roll a key that outlives it. Roll it from a signed-in session.",
						)
					}
					const createdByEmail = yield* auth.getUserEmail(tenant.userId)
					const rolled = yield* apiKeysService.roll(tenant.orgId, tenant.userId, params.id, {
						createdByEmail,
					})
					yield* recordHttpAudit("api_key.rolled", {
						resourceId: rolled.id,
						metadata: { name: rolled.name, scopes: rolled.scopes },
					})
					return toV2ApiKeyWithSecret(rolled)
				}),
			)
			.handle("revoke", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					// Whoever can mint a key must be able to kill it: a member may revoke
					// an MCP key they created or a device key one of their phones minted,
					// an engineer the standard keys they created. Everything else stays
					// admin-only.
					const existing = yield* apiKeysService.get(tenant.orgId, params.id)
					const isOwn = existing.createdBy === tenant.userId
					const isOwnSelfServiceKey =
						isOwn &&
						(existing.kind === "mcp" ||
							existing.kind === "device" ||
							(existing.kind === "standard" &&
								Policy.can(tenant.roles, "api_keys:create_restricted")))
					if (!isOwnSelfServiceKey) {
						yield* Policy.check(tenant.roles, "api_keys:manage", (denial) =>
							V2InsufficientPermissions.make(denial.message),
						)
					}
					if (!withinCallerScopes(tenant.scopes, existing.scopes)) {
						return yield* beyondCallerScopes()
					}
					const revoked = yield* apiKeysService.revoke(tenant.orgId, params.id)
					yield* recordHttpAudit("api_key.revoked", {
						resourceId: revoked.id,
						metadata: { name: revoked.name },
					})
					return toV2ApiKeyMutationResponse(revoked)
				}),
			)
	}),
)
