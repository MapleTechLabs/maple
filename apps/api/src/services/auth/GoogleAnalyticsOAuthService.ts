/**
 * Google OAuth for the GA4 integration.
 *
 * Simpler than {@link CloudflareOAuthService} in one way and stricter in another. Simpler: a
 * Google grant covers one identity, not a fan-out of accounts, so the connection row needs no
 * `grantedAccountsJson`. Stricter: Google only issues a refresh token when the authorize request
 * asks for `access_type=offline`, and only RE-issues one on a repeat consent when
 * `prompt=consent` is also sent. Without both, a reconnect silently yields an access-token-only
 * grant that dies within the hour — the same failure mode as the Cloudflare `offline_access`
 * outage, which is why the refusal below is copied from it verbatim.
 *
 * All token storage, encryption, single-flight refresh and the `invalid_grant`-only revocation
 * rule come from the shared `makeOAuthConnectionHelpers`; nothing about that is re-implemented.
 */
import { randomBytes } from "node:crypto"
import {
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsRevokedError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	OrgId,
	type UserId,
} from "@maple/domain/http"
import { oauthAuthStates } from "@maple/db"
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { listProperties } from "@/services/integrations/GoogleAnalyticsApi"
import { Database } from "@/platform/DatabaseLive"
import { Env, type EnvConfig } from "@/platform/Env"
import { dateToMs, msToDate } from "@/platform/time"
import { makeOAuthConnectionHelpers, OAUTH_STATE_TTL_MS } from "./oauth/connection-helpers"

const GOOGLE_ANALYTICS_PROVIDER = "google_analytics"

/**
 * Must match a redirect URI registered on the Google OAuth client exactly, path included —
 * Google rejects the exchange otherwise.
 */
export const GOOGLE_ANALYTICS_CALLBACK_PATH = "/api/integrations/google-analytics/callback"

const decodeOrgId = Schema.decodeUnknownSync(OrgId)

const UserInfo = Schema.Struct({
	sub: Schema.optionalKey(Schema.String),
	email: Schema.optionalKey(Schema.String),
})
const decodeUserInfo = Schema.decodeUnknownEffect(UserInfo)

interface ResolvedGoogleOAuthConfig {
	readonly clientId: string
	readonly clientSecret: Redacted.Redacted<string> | null
	readonly authorizeUrl: string
	readonly tokenUrl: string
	readonly revokeUrl: string
	readonly userInfoUrl: string
	readonly scopes: string
}

const resolveConfig = Effect.fn("GoogleAnalyticsOAuthService.resolveConfig")(function* (env: EnvConfig) {
	const clientId = yield* Option.match(env.GOOGLE_OAUTH_CLIENT_ID, {
		onNone: () =>
			Effect.fail(
				new IntegrationsValidationError({
					message: "GOOGLE_OAUTH_CLIENT_ID is required to use the Google Analytics integration",
				}),
			),
		onSome: (value) => Effect.succeed(value),
	})
	// Unlike Cloudflare's public-client flow, Google web-application clients are confidential:
	// the token exchange is rejected without the secret, so a missing one is a misconfiguration
	// worth failing loudly at connect time rather than at the first refresh.
	const clientSecret = yield* Option.match(env.GOOGLE_OAUTH_CLIENT_SECRET, {
		onNone: () =>
			Effect.fail(
				new IntegrationsValidationError({
					message: "GOOGLE_OAUTH_CLIENT_SECRET is required to use the Google Analytics integration",
				}),
			),
		onSome: (value) => Effect.succeed(value),
	})

	return {
		clientId,
		clientSecret,
		authorizeUrl: env.GOOGLE_OAUTH_AUTHORIZE_URL,
		tokenUrl: env.GOOGLE_OAUTH_TOKEN_URL,
		revokeUrl: env.GOOGLE_OAUTH_REVOKE_URL,
		userInfoUrl: env.GOOGLE_OAUTH_USERINFO_URL,
		scopes: env.GOOGLE_OAUTH_SCOPES,
	} satisfies ResolvedGoogleOAuthConfig
})

export interface GoogleAnalyticsConnectionStatus {
	readonly connected: boolean
	readonly connectedAt: number | null
	readonly externalUserEmail: string | null
	readonly connectedByUserId: string | null
	readonly scope: string
	readonly revoked: boolean
}

interface GoogleAnalyticsOAuthServiceApi {
	readonly startConnect: (
		orgId: OrgId,
		userId: UserId,
		options: { readonly callbackUrl: string; readonly returnTo?: string },
	) => Effect.Effect<
		{ readonly redirectUrl: string; readonly state: string },
		IntegrationsValidationError | IntegrationsPersistenceError
	>
	readonly completeConnect: (
		code: string,
		state: string,
	) => Effect.Effect<
		{ readonly orgId: OrgId; readonly returnTo: string | null },
		| IntegrationsValidationError
		| IntegrationsUpstreamError
		| IntegrationsRevokedError
		| IntegrationsPersistenceError
	>
	readonly getStatus: (
		orgId: OrgId,
	) => Effect.Effect<GoogleAnalyticsConnectionStatus, IntegrationsPersistenceError>
	readonly getValidAccessToken: (
		orgId: OrgId,
	) => Effect.Effect<
		{ readonly accessToken: string; readonly scope: string },
		| IntegrationsNotConnectedError
		| IntegrationsRevokedError
		| IntegrationsUpstreamError
		| IntegrationsPersistenceError
		| IntegrationsValidationError
	>
	readonly disconnect: (
		orgId: OrgId,
	) => Effect.Effect<{ readonly disconnected: boolean }, IntegrationsPersistenceError>
	/** Stamp the grant revoked so pollers stop retrying it; cleared on reconnect. Best-effort. */
	readonly markConnectionRevoked: (orgId: OrgId) => Effect.Effect<void>
}

export class GoogleAnalyticsOAuthService extends Context.Service<
	GoogleAnalyticsOAuthService,
	GoogleAnalyticsOAuthServiceApi
>()("@maple/api/services/GoogleAnalyticsOAuthService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const httpClient = yield* HttpClient.HttpClient
		const oauth = yield* makeOAuthConnectionHelpers({
			provider: GOOGLE_ANALYTICS_PROVIDER,
			providerLabel: "Google Analytics",
			database,
			env,
		})

		/** Best-effort token revocation on disconnect — failures are logged, never surfaced. */
		const revokeToken = (config: ResolvedGoogleOAuthConfig, token: string) =>
			oauth.postForm(config.revokeUrl, { token }).pipe(Effect.ignore)

		/** The connecting Google identity, for the card's "connected as" line. Never fatal. */
		const fetchUserInfo = (config: ResolvedGoogleOAuthConfig, accessToken: string) =>
			httpClient
				.execute(
					HttpClientRequest.get(config.userInfoUrl).pipe(
						HttpClientRequest.setHeaders({
							authorization: `Bearer ${accessToken}`,
							accept: "application/json",
						}),
					),
				)
				.pipe(
					Effect.flatMap((response) => response.json),
					Effect.flatMap(decodeUserInfo),
					Effect.option,
				)

		const startConnect = Effect.fn("GoogleAnalyticsOAuthService.startConnect")(function* (
			orgId: OrgId,
			userId: UserId,
			options: { readonly callbackUrl: string; readonly returnTo?: string },
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const config = yield* resolveConfig(env)
			const state = randomBytes(24).toString("base64url")
			const currentTime = yield* Clock.currentTimeMillis

			yield* oauth.purgeExpiredStates(currentTime)
			yield* oauth.dbExecute((db) =>
				db.insert(oauthAuthStates).values({
					state,
					orgId,
					provider: GOOGLE_ANALYTICS_PROVIDER,
					initiatedByUserId: userId,
					redirectUri: options.callbackUrl,
					returnTo: options.returnTo ?? null,
					// Google web-application clients are confidential and authenticate the exchange
					// with the client secret; PKCE is accepted but adds nothing here.
					codeVerifier: null,
					createdAt: msToDate(currentTime),
					expiresAt: msToDate(currentTime + OAUTH_STATE_TTL_MS),
				}),
			)

			// `access_type=offline` asks for a refresh token; `prompt=consent` forces Google to
			// RE-issue one on a repeat authorization. Without the second, a user reconnecting an
			// already-authorized app gets an access token only, and the poller dies within the hour.
			// `include_granted_scopes` keeps any scopes the user previously granted this client.
			const params = new URLSearchParams({
				client_id: config.clientId,
				redirect_uri: options.callbackUrl,
				response_type: "code",
				scope: config.scopes,
				state,
				access_type: "offline",
				prompt: "consent",
				include_granted_scopes: "true",
			})
			return { redirectUrl: `${config.authorizeUrl}?${params.toString()}`, state }
		})

		const completeConnect = Effect.fn("GoogleAnalyticsOAuthService.completeConnect")(function* (
			code: string,
			state: string,
		) {
			const config = yield* resolveConfig(env)
			const stateRow = yield* oauth.requireStateRow(state)
			yield* oauth.deleteAuthState(state)

			const tokenResponse = yield* oauth.exchangeAuthorizationCode(config, code, stateRow.redirectUri)
			const orgId = decodeOrgId(stateRow.orgId)
			yield* Effect.annotateCurrentSpan({ orgId })

			// A background poller must renew indefinitely. A grant with no refresh token silently
			// stops working at the access token's ~1h expiry; refuse it loudly instead of storing a
			// doomed connection. Best-effort revoke first — the token is never persisted, so this is
			// the only moment we can invalidate it upstream.
			if (!tokenResponse.refresh_token) {
				yield* Effect.logWarning(
					"Google OAuth token exchange returned no refresh token — refusing connection",
					{ orgId },
				)
				yield* revokeToken(config, tokenResponse.access_token)
				return yield* Effect.fail(
					new IntegrationsValidationError({
						message:
							"Google returned no refresh token, so this connection would stop working within the hour. Remove Maple from your Google account's third-party access and connect again.",
					}),
				)
			}

			// A grant that reaches no GA4 property is useless, and finding out at the first poll
			// means an integration card that looks connected and never fills in. Same refusal shape
			// as Cloudflare's zero-accounts guard.
			const properties = yield* listProperties({
				accessToken: tokenResponse.access_token,
				adminBaseUrl: env.MAPLE_GOOGLE_ANALYTICS_ADMIN_API_BASE_URL,
			})
			if (properties.length === 0) {
				yield* revokeToken(config, tokenResponse.access_token)
				return yield* Effect.fail(
					new IntegrationsValidationError({
						message:
							"That Google account can't see any Google Analytics 4 properties. Connect an account with at least Viewer access to a GA4 property.",
					}),
				)
			}

			// Userinfo is a nicety, not a requirement: it names the connected account in the UI.
			// An empty identity still yields a valid connection row (see the fallbacks below).
			const identity = Option.getOrElse(
				yield* fetchUserInfo(config, tokenResponse.access_token),
				(): typeof UserInfo.Type => ({}),
			)

			const accessEnc = yield* oauth.encryptValue(tokenResponse.access_token)
			const refreshEnc = yield* oauth.encryptValue(tokenResponse.refresh_token)
			const currentTime = yield* Clock.currentTimeMillis
			const expiresAt =
				tokenResponse.expires_in != null ? currentTime + tokenResponse.expires_in * 1000 : null

			yield* oauth.upsertConnection(orgId, currentTime, {
				// `sub` is Google's stable per-client user id. Falling back to the email keeps the
				// NOT NULL column honest when userinfo is unavailable; it is a label, not a key.
				externalUserId: identity.sub ?? identity.email ?? "google-analytics",
				externalUserEmail: identity.email ?? null,
				externalAccountName: properties[0]?.accountName ?? null,
				grantedAccountsJson: null,
				connectedByUserId: stateRow.initiatedByUserId,
				scope: tokenResponse.scope ?? config.scopes,
				accessTokenCiphertext: accessEnc.ciphertext,
				accessTokenIv: accessEnc.iv,
				accessTokenTag: accessEnc.tag,
				refreshTokenCiphertext: refreshEnc.ciphertext,
				refreshTokenIv: refreshEnc.iv,
				refreshTokenTag: refreshEnc.tag,
				expiresAt: msToDate(expiresAt),
			})

			return { orgId, returnTo: stateRow.returnTo ?? null }
		})

		const getValidAccessToken = Effect.fn("GoogleAnalyticsOAuthService.getValidAccessToken")(
			function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const config = yield* resolveConfig(env)
				const { accessToken, row } = yield* oauth.getValidConnectionToken(config, orgId)
				return { accessToken, scope: row.scope }
			},
		)

		const getStatus = Effect.fn("GoogleAnalyticsOAuthService.getStatus")(function* (orgId: OrgId) {
			const row = yield* oauth.loadConnection(orgId)
			if (!row) {
				return {
					connected: false,
					connectedAt: null,
					externalUserEmail: null,
					connectedByUserId: null,
					scope: "",
					revoked: false,
				} satisfies GoogleAnalyticsConnectionStatus
			}
			return {
				connected: true,
				connectedAt: dateToMs(row.createdAt),
				externalUserEmail: row.externalUserEmail,
				connectedByUserId: row.connectedByUserId,
				scope: row.scope,
				revoked: row.revokedAt != null,
			} satisfies GoogleAnalyticsConnectionStatus
		})

		const disconnect = Effect.fn("GoogleAnalyticsOAuthService.disconnect")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			// Best-effort upstream revocation before the row goes; a failure here must never block
			// the disconnect, because the deleted row is the real backstop.
			const row = yield* oauth.loadConnection(orgId)
			if (row) {
				const config = yield* resolveConfig(env).pipe(Effect.option)
				// Revoking the REFRESH token invalidates the whole grant at Google, access token
				// included — revoking the access token alone would leave the refresh grant live.
				const refreshToken =
					row.refreshTokenCiphertext && row.refreshTokenIv && row.refreshTokenTag
						? yield* oauth
								.decryptValue({
									ciphertext: row.refreshTokenCiphertext,
									iv: row.refreshTokenIv,
									tag: row.refreshTokenTag,
								})
								.pipe(Effect.option)
						: Option.none<string>()
				if (Option.isSome(config) && Option.isSome(refreshToken)) {
					yield* revokeToken(config.value, refreshToken.value)
				}
			}
			return yield* oauth.deleteConnection(orgId)
		})

		const markConnectionRevoked = Effect.fn("GoogleAnalyticsOAuthService.markConnectionRevoked")(
			function* (orgId: OrgId) {
				yield* oauth.markConnectionRevoked(orgId)
			},
		)

		return {
			startConnect,
			completeConnect,
			getStatus,
			getValidAccessToken,
			disconnect,
			markConnectionRevoked,
		} satisfies GoogleAnalyticsOAuthServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
