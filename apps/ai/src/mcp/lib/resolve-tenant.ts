import { Array as Arr, Effect, Option, Redacted, Schema, String as Str } from "effect"
import type { TenantContext as McpTenantContext } from "@maple/backend/services/auth/tenant-context"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { secretsEqual } from "@maple/backend/services/auth/secret-equal"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { ErrorActorsService } from "@maple/backend/services/errors/ErrorActorsService"
import { Env } from "@maple/backend/platform/Env"
import { ActorId, OrgId, RoleName, UserId } from "@maple/domain/http"
import { INVESTIGATION_READ_FAMILIES, missingReadScopes, scopeAllows } from "@maple/domain/http/v2"
import {
	McpAuthInvalidError,
	McpAuthMissingError,
	McpAuthUnavailableError,
	McpInvalidTenantError,
} from "../tools/types"
import { recordExpectedMcpFailure } from "../expected-failures"

/** Exported so the audit layer classifies the same token the same way. */
export const INTERNAL_SERVICE_PREFIX = "maple_svc_"
/** The user every internal service call resolves to: a credential, not a person. */
export const INTERNAL_SERVICE_USER_ID = "internal-service"

/**
 * The tenant plus the rate-limit identity of the credential that produced it,
 * consumed by the MCP authorization middleware. Absent only for internal
 * service auth: that is Maple's own traffic behind one shared token, so a
 * single bucket would throttle every internal caller together.
 */
export interface McpAuthenticatedTenant extends McpTenantContext {
	readonly rateLimitCredentialId?: string
}
const decodeOrgId = Schema.decodeUnknownEffect(OrgId)
const decodeUserId = Schema.decodeUnknownEffect(UserId)
const decodeActorIdOption = Schema.decodeUnknownOption(ActorId)
const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)
const apiKeyDefaultRoles = [decodeRoleNameSync("root")]

const AGENT_ACTOR_HEADER = "x-maple-agent-id"

const decodeAgentActorMetadata = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Struct({ agentActorId: Schema.String })),
)

const extractAgentActorIdFromMetadata = (metadataJson: string | null): string | null => {
	if (!metadataJson) return null
	return Option.match(decodeAgentActorMetadata(metadataJson), {
		onNone: () => null,
		onSome: (metadata) => metadata.agentActorId,
	})
}

/**
 * The agent a request names in `x-maple-agent-id`, honoured only when it is one of the org's agent
 * actors created by the key's user. Anything else is ignored and the request acts as its default.
 */
const resolveHeaderAgentActor = Effect.fn("McpTenant.resolveHeaderAgentActor")(function* (
	orgId: OrgId,
	userId: UserId,
	raw: string,
) {
	const actorId = decodeActorIdOption(raw)
	if (Option.isNone(actorId)) return Option.none<ActorId>()
	const actors = yield* ErrorActorsService
	const agent = yield* actors.findOwnedAgentActor(orgId, actorId.value, userId).pipe(
		Effect.mapError(
			() =>
				new McpAuthUnavailableError({
					message: "Agent identity validation is temporarily unavailable",
				}),
		),
	)
	yield* Effect.annotateCurrentSpan("maple.mcp.agent_header_honoured", Option.isSome(agent))
	return Option.map(agent, (document) => document.id)
})

const toHeaderRecord = (headers: Headers): Record<string, string> => {
	const record: Record<string, string> = {}

	for (const [name, value] of headers.entries()) {
		record[name] = value
	}

	return record
}

const getBearerToken = (headers: Headers): string | undefined => {
	const header = headers.get("authorization")
	if (!header) return undefined
	const [scheme, token] = Str.split(" ")(header)
	if (!scheme || !token || Str.toLowerCase(scheme) !== "bearer") return undefined
	return token
}

/**
 * What a scoped key may do over MCP. The toolset reads across the org (the same families an
 * investigation reads), so a key must read all of them; it may change data only when it can
 * also write all of them. `null` scopes are a legacy full-access key.
 */
export const mcpScopeAccess = (
	scopes: ReadonlyArray<string> | null,
): "full" | "read" | { readonly missing: ReadonlyArray<string> } => {
	const missing = missingReadScopes(scopes, INVESTIGATION_READ_FAMILIES)
	if (missing.length > 0) return { missing }
	return Arr.every(INVESTIGATION_READ_FAMILIES, (family) =>
		scopeAllows(scopes, { family, access: "write" }),
	)
		? "full"
		: "read"
}

const MAPLE_API_KEY_PREFIX = "maple_ak_"
const PLACEHOLDER = /\$\{[^}]*\}|^\$[A-Za-z_][A-Za-z0-9_]*$|^<[^>]+>$/

/**
 * Why a bearer can be neither a Maple key nor a session JWT, so the 401 names the fix instead of
 * a JWT parse error. Undefined when the token may be valid and should be looked up.
 */
export const describeMalformedBearer = (token: string | undefined): string | undefined => {
	if (token === undefined || Str.startsWith(MAPLE_API_KEY_PREFIX)(token)) return undefined
	if (PLACEHOLDER.test(token)) {
		return `The bearer token \`${token}\` is an unexpanded placeholder: your MCP client sent the variable name, not its value. Set the variable or paste the key; Maple API keys start with \`${MAPLE_API_KEY_PREFIX}\`.`
	}
	if (Str.split(".")(token).length === 3) return undefined
	return `The bearer token is not a Maple API key. Maple API keys start with \`${MAPLE_API_KEY_PREFIX}\`; create one in Maple's settings, or connect with OAuth.`
}

/**
 * The MCP resource identifier (RFC 8707) this deployment serves, from its configured API origin.
 * The same value apps/api binds OAuth grants to, never a forwarded host header.
 */
export const mcpResourceUrl = (apiBaseUrl: string) => `${Str.replace(/\/+$/, "")(apiBaseUrl)}/mcp`

/** Maple's own service token: the org comes from `x-org-id`, the user is `internal-service`. */
const resolveInternalServiceTenant = Effect.fn("McpTenant.resolveInternalServiceTenant")(function* (
	request: Request,
	token: string,
) {
	const provided = Str.slice(INTERNAL_SERVICE_PREFIX.length)(token)
	const env = yield* Env
	const expected = Option.match(env.INTERNAL_SERVICE_TOKEN, {
		onNone: () => undefined,
		onSome: (value) => Redacted.value(value),
	})

	if (!expected) {
		return yield* new McpAuthMissingError({
			message: "INTERNAL_SERVICE_TOKEN is not configured on the server",
		})
	}

	if (secretsEqual(provided, expected)) {
		const orgId = Option.match(env.MAPLE_ORG_ID_OVERRIDE, {
			onNone: () => request.headers.get("x-org-id"),
			onSome: (value) => value,
		})
		if (!orgId) {
			return yield* new McpAuthMissingError({
				message: "x-org-id header is required for internal service auth",
			})
		}

		const validOrgId = yield* decodeOrgId(orgId).pipe(
			Effect.mapError(
				(e) =>
					new McpInvalidTenantError({
						message: e.message,
						field: "orgId",
					}),
			),
		)
		const validUserId = yield* decodeUserId(INTERNAL_SERVICE_USER_ID).pipe(
			Effect.mapError(
				(e) =>
					new McpInvalidTenantError({
						message: e.message,
						field: "userId",
					}),
			),
		)
		const tenant: McpAuthenticatedTenant = {
			orgId: validOrgId,
			userId: validUserId,
			roles: [],
			authMode: "self_hosted",
		}
		return tenant
	}

	return yield* new McpAuthInvalidError({
		message: "Internal service token mismatch",
	})
})

/**
 * A signed-in person's session, never an API key or MCP OAuth token: `resolveTenant` accepts
 * session tokens only, unlike `resolveMcpTenant`.
 */
const resolveSessionTenant = Effect.fn("McpTenant.resolveSessionTenant")(function* (request: Request) {
	const auth = yield* AuthService
	const tenant = yield* auth.resolveTenant(toHeaderRecord(request.headers)).pipe(
		Effect.mapError(
			(error) =>
				new McpAuthInvalidError({
					message: error.message || "Authentication failed (no details available)",
					reason: "session_auth_fallback",
				}),
		),
	)
	return {
		orgId: tenant.orgId,
		userId: tenant.userId,
		roles: [...tenant.roles],
		authMode: tenant.authMode,
		rateLimitCredentialId: `user:${tenant.userId}`,
	} satisfies McpAuthenticatedTenant
})

/**
 * The tenant for the in-product chat routes: a signed-in session, or Maple's own service token.
 * Needs no `ApiKeysService`, so a router built on it cannot accept a key by accident.
 */
export const resolveChatSessionTenantContext = Effect.fn("McpTenant.resolveChatSessionTenantContext")(
	function* (request: Request) {
		const token = getBearerToken(request.headers)
		if (token !== undefined && Str.startsWith(INTERNAL_SERVICE_PREFIX)(token)) {
			return yield* resolveInternalServiceTenant(request, token)
		}
		return yield* resolveSessionTenant(request)
	},
	(effect) =>
		Effect.tapError(effect, (error) => recordExpectedMcpFailure(error, "Chat authentication failed")),
)

export const resolveMcpTenantContext = Effect.fn("McpTenant.resolveMcpTenantContext")(
	function* (request: Request) {
		const token = getBearerToken(request.headers)

		// Internal service auth (e.g. chat agent)
		if (token && Str.startsWith(INTERNAL_SERVICE_PREFIX)(token)) {
			return yield* resolveInternalServiceTenant(request, token)
		}

		const malformed = describeMalformedBearer(token)
		if (malformed !== undefined) {
			return yield* new McpAuthInvalidError({ message: malformed, reason: "malformed_token" })
		}

		const apiKeys = yield* ApiKeysService
		const apiKeyResolved = yield* apiKeys.resolveByBearer(token).pipe(
			// One retry absorbs a dropped pooled connection before the client sees a 503.
			Effect.retry({ times: 1 }),
			Effect.catchTag("@maple/http/errors/ApiKeyLookupPersistenceError", () =>
				Effect.fail(
					new McpAuthUnavailableError({
						message: "API key validation is temporarily unavailable",
					}),
				),
			),
		)

		if (Option.isSome(apiKeyResolved)) {
			const resolved = apiKeyResolved.value
			const expectedResource = mcpResourceUrl((yield* Env).MAPLE_API_BASE_URL)
			const isMcpOAuthToken = resolved.mcpOAuthResource !== null
			if (
				isMcpOAuthToken &&
				(resolved.kind !== "mcp" ||
					resolved.mcpOAuthResource !== expectedResource ||
					resolved.scopes?.includes("mcp:tools") !== true)
			) {
				return yield* new McpAuthInvalidError({
					message: "OAuth token is not valid for this MCP resource",
					reason: "invalid_target",
				})
			}
			const scopeAccess = isMcpOAuthToken ? "full" : mcpScopeAccess(resolved.scopes)
			if (typeof scopeAccess !== "string") {
				return yield* new McpAuthInvalidError({
					message: `This API key's scopes are too narrow for the MCP server, whose tools read across the org. Add ${Arr.join(
						Arr.map(scopeAccess.missing, (family) => `"${family}:read"`),
						", ",
					)}, or use a full-access key.`,
					reason: "insufficient_scope",
				})
			}
			const validOrgId = yield* decodeOrgId(resolved.orgId).pipe(
				Effect.mapError(
					(e) =>
						new McpInvalidTenantError({
							message: e.message,
							field: "orgId",
						}),
				),
			)
			const validUserId = yield* decodeUserId(resolved.userId).pipe(
				Effect.mapError(
					(e) =>
						new McpInvalidTenantError({
							message: e.message,
							field: "userId",
						}),
				),
			)

			// Actor resolution: prefer a verified agent header, else the key's pinned agentActorId
			// metadata. Malformed or unverified values are dropped rather than failing the request.
			const headerActorId = request.headers.get(AGENT_ACTOR_HEADER)
			const headerActor =
				headerActorId === null
					? Option.none<ActorId>()
					: yield* resolveHeaderAgentActor(validOrgId, validUserId, headerActorId)
			const keyActorId = extractAgentActorIdFromMetadata(resolved.metadataJson)
			const actorId = Option.getOrUndefined(
				Option.orElse(headerActor, () =>
					keyActorId === null ? Option.none<ActorId>() : decodeActorIdOption(keyActorId),
				),
			)

			return {
				orgId: validOrgId,
				userId: validUserId,
				roles: resolved.roles ?? apiKeyDefaultRoles,
				authMode: "self_hosted",
				rateLimitCredentialId: `key:${resolved.keyId}`,
				...(actorId ? { actorId } : undefined),
				...(scopeAccess === "read" ? { readOnly: true } : undefined),
			} as McpAuthenticatedTenant
		}

		// Fall back to existing Clerk / self-hosted session auth
		const auth = yield* AuthService
		const tenant = yield* auth.resolveMcpTenant(toHeaderRecord(request.headers)).pipe(
			Effect.mapError(
				(error) =>
					new McpAuthInvalidError({
						message: error.message || "Authentication failed (no details available)",
						reason: "session_auth_fallback",
					}),
			),
		)

		return {
			orgId: tenant.orgId,
			userId: tenant.userId,
			roles: [...tenant.roles],
			authMode: tenant.authMode,
			rateLimitCredentialId: `user:${tenant.userId}`,
		}
	},
	// Missing/invalid credentials are an expected 401, not a failure: annotate the
	// span and log at Warn so it exports with an Ok status (the tag is also listed
	// in MCP_ANTICIPATED_ERROR_IDENTIFIERS, which suppresses the exception event).
	// Runs inside the span — `Effect.fn` pipeline transforms wrap the body, and the
	// span wraps them. The typed error itself is untouched.
	(effect) =>
		Effect.tapError(effect, (error) => recordExpectedMcpFailure(error, "MCP authentication failed")),
)
