import { HttpApiBuilder } from "effect/http-api"
import {
	CliDeviceActionResponse,
	CliDeviceConflictError,
	CliDevicePersistenceError,
	CurrentTenant,
	MapleApi,
	UnauthorizedError,
} from "@maple/domain/http"
import { Effect, Option, String as Str } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/http"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { CliDeviceAuthService } from "@maple/backend/services/auth/CliDeviceAuthService"
import { McpOAuthService } from "@maple/backend/services/auth/McpOAuthService"
import { PreviewSignInService } from "@maple/backend/services/auth/PreviewSignInService"
import { SelfHostedLoginRateLimiter } from "@maple/backend/services/auth/SelfHostedLoginRateLimiter"

const bearerToken = (header: string | undefined) => {
	if (!header) return undefined
	const [scheme, token] = Str.split(" ")(header)
	return Str.toLowerCase(scheme) === "bearer" ? token : undefined
}

/** The client address the edge reports; the first `x-forwarded-for` hop when there is no edge header. */
const clientKey = (headers: Readonly<Record<string, string | undefined>>) =>
	headers["cf-connecting-ip"] ?? Str.trim(Str.split(",")(headers["x-forwarded-for"] ?? "")[0] ?? "") ?? ""

const withRetryAfter = (seconds: number) =>
	HttpEffect.appendPreResponseHandler((_request, response) =>
		Effect.succeed(HttpServerResponse.setHeader(response, "Retry-After", String(seconds))),
	)

export const HttpAuthPublicLive = HttpApiBuilder.group(MapleApi, "authPublic", (handlers) =>
	Effect.gen(function* () {
		const authService = yield* AuthService
		const cliAuth = yield* CliDeviceAuthService
		const previewSignIn = yield* PreviewSignInService
		const loginLimiter = yield* SelfHostedLoginRateLimiter
		return handlers
			.handle("login", ({ payload }) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest
					const key = clientKey(request.headers)
					yield* loginLimiter
						.check(key === "" ? "unknown" : key)
						.pipe(Effect.tapError((error) => withRetryAfter(error.retryAfterSeconds)))
					return yield* authService.loginSelfHosted(payload.password)
				}),
			)
			.handle("cliDeviceStart", ({ payload }) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest
					const requesterKey =
						request.headers["cf-connecting-ip"] ?? request.headers["x-forwarded-for"] ?? "unknown"
					return yield* cliAuth.start(payload.deviceName, requesterKey)
				}),
			)
			.handle("cliDevicePoll", ({ payload }) => cliAuth.poll(payload.deviceCode))
			.handle("previewSignInStatus", () => previewSignIn.status)
			.handle("previewSignIn", ({ payload }) => previewSignIn.signIn(payload.key))
	}),
)

export const HttpAuthLive = HttpApiBuilder.group(MapleApi, "auth", (handlers) =>
	Effect.gen(function* () {
		const auth = yield* AuthService
		const apiKeys = yield* ApiKeysService
		return handlers
			.handle("session", () => CurrentTenant.Context)
			.handle("sessionRefresh", () =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest
					const token = bearerToken(request.headers.authorization)
					// The middleware only guarantees SOME accepted credential; renewal
					// specifically trades one self-hosted bearer for another, so an
					// absent one is unauthorized rather than a 500 on `undefined`.
					if (!token) {
						return yield* new UnauthorizedError({
							message: "Self-hosted session renewal requires a bearer token",
						})
					}
					return yield* auth.refreshSelfHostedSession(token)
				}),
			)
			.handle("cliSessionRevoke", () =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest
					const resolved = yield* apiKeys
						.resolveByBearer(bearerToken(request.headers.authorization))
						.pipe(
							Effect.mapError(
								(error) => new CliDevicePersistenceError({ message: error.message }),
							),
						)
					if (Option.isNone(resolved) || !resolved.value.cliManaged) {
						return yield* new CliDeviceConflictError({
							message: "The active credential is not a browser-issued Maple CLI credential",
						})
					}
					yield* apiKeys
						.revoke(resolved.value.orgId, resolved.value.keyId)
						.pipe(
							Effect.mapError(
								(error) => new CliDevicePersistenceError({ message: error.message }),
							),
						)
					return new CliDeviceActionResponse({ status: "revoked" })
				}),
			)
	}),
)

export const HttpAuthSessionLive = HttpApiBuilder.group(MapleApi, "authSession", (handlers) =>
	Effect.gen(function* () {
		const cliAuth = yield* CliDeviceAuthService
		const auth = yield* AuthService
		const mcpOAuth = yield* McpOAuthService
		return handlers
			.handle("cliDeviceInspect", ({ params }) => cliAuth.inspect(params.userCode))
			.handle("cliDeviceApprove", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const userEmail = yield* auth.getUserEmail(tenant.userId)
					const pending = yield* cliAuth.inspect(params.userCode)
					const approved = yield* cliAuth.approve(params.userCode, {
						orgId: tenant.orgId,
						userId: tenant.userId,
						roles: tenant.roles,
						permissions: tenant.permissions,
						userEmail,
					})
					yield* recordHttpAudit("cli_session.approved", {
						metadata: { deviceName: pending.deviceName, roles: [...tenant.roles] },
					})
					return approved
				}),
			)
			.handle("cliDeviceDeny", ({ params }) => cliAuth.deny(params.userCode))
			.handle("mcpOAuthAuthorizationInspect", ({ params }) => mcpOAuth.inspect(params.requestId))
			.handle("mcpOAuthAuthorizationApprove", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const userEmail = yield* auth.getUserEmail(tenant.userId)
					const pending = yield* mcpOAuth.inspect(params.requestId)
					const approved = yield* mcpOAuth.approve(params.requestId, {
						orgId: tenant.orgId,
						userId: tenant.userId,
						roles: tenant.roles,
						permissions: tenant.permissions,
						userEmail,
					})
					// The redirect's host only: its query can carry the client's state.
					const redirectHost = Option.liftThrowable(() => new URL(pending.redirectUri).host)()
					yield* recordHttpAudit("mcp_connection.granted", {
						metadata: {
							clientName: pending.clientName,
							resource: pending.resource,
							scopes: pending.scopes,
							roles: [...tenant.roles],
							...(Option.isSome(redirectHost)
								? { redirectHost: redirectHost.value }
								: undefined),
						},
					})
					return approved
				}),
			)
			.handle("mcpOAuthAuthorizationDeny", ({ params }) => mcpOAuth.deny(params.requestId))
	}),
)
