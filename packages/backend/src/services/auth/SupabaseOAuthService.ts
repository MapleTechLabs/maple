import { randomBytes } from "node:crypto"
import {
	IntegrationsConfigurationError,
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsRevokedError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { OAuthAuthStates } from "@maple/db/tables"
import { Clock, Context, Effect, Layer, Option } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { Env, type EnvConfig } from "@maple/backend/platform/Env"
import {
	isSupabaseTokenRejected,
	listOrganizations,
	revokeGrant,
	type SupabaseApiError,
	type SupabaseOrganization,
} from "@maple/backend/services/integrations/supabase/api"
import {
	deriveCodeChallenge,
	generateCodeVerifier,
	makeOAuthConnectionHelpers,
	OAUTH_STATE_TTL_MS,
	toUpstreamError,
} from "./oauth/connection-helpers"
import type { OAuthFlowInitiator } from "./oauth/oauth-state"

const SUPABASE_PROVIDER = "supabase"

/** Where Supabase redirects after consent; registered on the Supabase OAuth app. */
export const SUPABASE_CALLBACK_PATH = "/api/integrations/supabase/callback"

const apiBaseOf = (env: EnvConfig) => env.MAPLE_SUPABASE_API_BASE_URL.replace(/\/$/, "")

/** Whether the OAuth app credentials are set; without them the integration reads as not configured. */
const isSupabaseConfigured = (env: EnvConfig) =>
	Option.isSome(env.SUPABASE_OAUTH_CLIENT_ID) && Option.isSome(env.SUPABASE_OAUTH_CLIENT_SECRET)

const resolveConfig = Effect.fn("SupabaseOAuthService.resolveConfig")(function* (env: EnvConfig) {
	const missing = (name: string) =>
		new IntegrationsConfigurationError({
			message: `${name} is required to use the Supabase integration`,
		})
	const clientId = yield* Effect.fromOption(env.SUPABASE_OAUTH_CLIENT_ID).pipe(
		Effect.mapError(() => missing("SUPABASE_OAUTH_CLIENT_ID")),
	)
	const clientSecret = yield* Effect.fromOption(env.SUPABASE_OAUTH_CLIENT_SECRET).pipe(
		Effect.mapError(() => missing("SUPABASE_OAUTH_CLIENT_SECRET")),
	)
	const apiBaseUrl = apiBaseOf(env)
	return {
		clientId,
		clientSecret,
		// Live-verified: the token endpoint accepts HTTP Basic client auth alongside PKCE.
		clientAuthentication: "client_secret_basic" as const,
		// Live-verified: a rotated-away or revoked refresh token gets 404 "No such refresh token found".
		deadRefreshTokenStatus: 404,
		apiBaseUrl,
		authorizeUrl: `${apiBaseUrl}/v1/oauth/authorize`,
		tokenUrl: `${apiBaseUrl}/v1/oauth/token`,
	}
})

/** Failures involved in resolving a usable Supabase access token. */
export type SupabaseAccessTokenError =
	| IntegrationsNotConnectedError
	| IntegrationsRevokedError
	| IntegrationsUpstreamError
	| IntegrationsPersistenceError
	| IntegrationsValidationError
	| IntegrationsConfigurationError

export interface SupabaseOAuthServiceApi {
	readonly isConfigured: boolean
	/** Base URL of the Management API, for callers issuing their own requests. */
	readonly apiBaseUrl: string
	readonly startConnect: (
		orgId: OrgId,
		userId: UserId,
		options: { readonly callbackUrl: string; readonly returnTo?: string },
	) => Effect.Effect<
		{ readonly redirectUrl: string; readonly state: string },
		IntegrationsConfigurationError | IntegrationsPersistenceError
	>
	/**
	 * Exchange the callback code (PKCE) and persist the grant. The consent screen grants one
	 * Supabase organization; it is returned so the caller can bind it.
	 */
	readonly completeConnect: (
		code: string,
		state: string,
		initiator: OAuthFlowInitiator,
	) => Effect.Effect<
		{
			readonly orgId: OrgId
			readonly connectedByUserId: UserId
			readonly returnTo: string | null
			readonly organization: SupabaseOrganization
		},
		| IntegrationsValidationError
		| IntegrationsConfigurationError
		| IntegrationsRevokedError
		| IntegrationsUpstreamError
		| IntegrationsPersistenceError
	>
	/**
	 * The org's access token, refreshed when it is within a minute of expiry. Managed scrape
	 * targets resolve this for the scraper's Authorization header on every target-list reconcile.
	 */
	readonly getValidAccessToken: (
		orgId: OrgId,
	) => Effect.Effect<{ readonly accessToken: string }, SupabaseAccessTokenError>
	/**
	 * Run `use` with the org's access token. A 401 forces one refresh and a retry; when the
	 * fresh token is rejected too, the grant is stamped revoked so discovery stops using it.
	 */
	readonly withAccessToken: <A, E>(
		orgId: OrgId,
		use: (accessToken: string) => Effect.Effect<A, E | SupabaseApiError>,
	) => Effect.Effect<A, Exclude<E, SupabaseApiError> | SupabaseApiError | SupabaseAccessTokenError>
	/** Whether a grant is stored and not stamped revoked, i.e. discovery may use it. */
	readonly isGrantUsable: (orgId: OrgId) => Effect.Effect<boolean, IntegrationsPersistenceError>
	/** Revoke the grant at Supabase (best effort, logged) and drop the stored tokens. */
	readonly disconnect: (
		orgId: OrgId,
	) => Effect.Effect<{ readonly disconnected: boolean }, IntegrationsPersistenceError>
}

export class SupabaseOAuthService extends Context.Service<SupabaseOAuthService, SupabaseOAuthServiceApi>()(
	"@maple/backend/services/SupabaseOAuthService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const httpClient = yield* HttpClient.HttpClient
			const oauth = yield* makeOAuthConnectionHelpers({
				provider: SUPABASE_PROVIDER,
				providerLabel: "Supabase",
				database,
				env,
			})
			const apiBaseUrl = apiBaseOf(env)

			const startConnect = Effect.fn("SupabaseOAuthService.startConnect")(function* (
				orgId: OrgId,
				userId: UserId,
				options: { readonly callbackUrl: string; readonly returnTo?: string },
			) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const config = yield* resolveConfig(env)
				const state = randomBytes(24).toString("base64url")
				const codeVerifier = generateCodeVerifier()
				const currentTime = yield* Clock.currentTimeMillis

				yield* oauth.purgeExpiredStates(currentTime)
				yield* oauth.dbExecute((db) =>
					db.run(
						PG.insertInto(OAuthAuthStates).values({
							state,
							orgId,
							provider: SUPABASE_PROVIDER,
							initiatedByUserId: userId,
							redirectUri: options.callbackUrl,
							returnTo: options.returnTo ?? null,
							codeVerifier,
							createdAt: currentTime,
							expiresAt: currentTime + OAUTH_STATE_TTL_MS,
						}),
					),
				)

				// Scopes are configured on the OAuth app, so none are sent here.
				const params = new URLSearchParams({
					client_id: config.clientId,
					redirect_uri: options.callbackUrl,
					response_type: "code",
					state,
					code_challenge: deriveCodeChallenge(codeVerifier),
					code_challenge_method: "S256",
				})
				return { redirectUrl: `${config.authorizeUrl}?${params.toString()}`, state }
			})

			const completeConnect = Effect.fn("SupabaseOAuthService.completeConnect")(function* (
				code: string,
				state: string,
				initiator: OAuthFlowInitiator,
			) {
				const config = yield* resolveConfig(env)
				const stateRow = yield* oauth.consumeStateRow(state, initiator)
				if (stateRow.codeVerifier === null) {
					return yield* new IntegrationsValidationError({
						message: "OAuth state is missing its PKCE verifier. Restart the connect flow.",
					})
				}
				const orgId = stateRow.orgId
				yield* Effect.annotateCurrentSpan({ orgId })

				const tokenResponse = yield* oauth.exchangeAuthorizationCode(
					config,
					code,
					stateRow.redirectUri,
					{
						code_verifier: stateRow.codeVerifier,
					},
				)
				const refreshToken = tokenResponse.refresh_token
				// Discovery must renew indefinitely; a grant with no refresh token dies in 24h.
				if (refreshToken === undefined) {
					return yield* new IntegrationsValidationError({
						message:
							"Supabase returned no refresh token, so this connection would stop working within a day. Reconnect and try again.",
					})
				}

				// A refused grant is never persisted, so this is the only chance to invalidate it upstream.
				const revokeRefusedGrant = revokeGrant(httpClient, config.apiBaseUrl, {
					...config,
					refreshToken,
				}).pipe(
					Effect.catchTag("@maple/supabase/SupabaseApiError", (error) =>
						Effect.logWarning("Supabase revoke of a refused grant failed", {
							error: error.message,
						}),
					),
				)

				const organizations = yield* listOrganizations(
					httpClient,
					config.apiBaseUrl,
					tokenResponse.access_token,
				).pipe(
					Effect.catchTag("@maple/supabase/SupabaseApiError", (error) =>
						revokeRefusedGrant.pipe(
							Effect.andThen(
								Effect.fail(
									error.kind === "unauthorized"
										? new IntegrationsRevokedError({ message: error.message })
										: toUpstreamError(error.message, error.status),
								),
							),
						),
					),
				)
				yield* Effect.annotateCurrentSpan("maple.supabase.organizations", organizations.length)
				const [organization, ...others] = organizations
				if (organization === undefined || others.length > 0) {
					yield* revokeRefusedGrant
					return yield* new IntegrationsValidationError({
						message:
							organization === undefined
								? "The Supabase authorization grants access to no organization"
								: "The Supabase authorization covers more than one organization; reconnect and pick one",
					})
				}

				const accessEnc = yield* oauth.encryptValue(tokenResponse.access_token)
				const refreshEnc = yield* oauth.encryptValue(refreshToken)
				const currentTime = yield* Clock.currentTimeMillis
				const expiresAt =
					tokenResponse.expires_in === undefined
						? null
						: currentTime + tokenResponse.expires_in * 1000

				yield* oauth.upsertConnection(orgId, currentTime, {
					externalUserId: organization.id,
					externalUserEmail: null,
					externalAccountName: organization.name,
					connectedByUserId: stateRow.initiatedByUserId,
					scope: tokenResponse.scope ?? "",
					accessTokenCiphertext: accessEnc.ciphertext,
					accessTokenIv: accessEnc.iv,
					accessTokenTag: accessEnc.tag,
					refreshTokenCiphertext: refreshEnc.ciphertext,
					refreshTokenIv: refreshEnc.iv,
					refreshTokenTag: refreshEnc.tag,
					expiresAt,
				})

				return {
					orgId,
					connectedByUserId: stateRow.initiatedByUserId,
					returnTo: stateRow.returnTo ?? null,
					organization,
				}
			})

			const getValidAccessToken = Effect.fn("SupabaseOAuthService.getValidAccessToken")(function* (
				orgId: OrgId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const config = yield* resolveConfig(env)
				// A stamped grant failed a refresh or had a fresh token rejected; reconnecting clears it.
				const { accessToken } = yield* oauth.getValidConnectionToken(config, orgId, {
					failIfRevoked: true,
				})
				return { accessToken }
			})

			const withAccessToken = <A, E>(
				orgId: OrgId,
				use: (accessToken: string) => Effect.Effect<A, E | SupabaseApiError>,
			) =>
				resolveConfig(env).pipe(
					Effect.flatMap((config) =>
						oauth.withRejectedTokenRetry(config, orgId, isSupabaseTokenRejected, use),
					),
					Effect.withSpan("SupabaseOAuthService.withAccessToken", { attributes: { orgId } }),
				)

			const isGrantUsable = Effect.fn("SupabaseOAuthService.isGrantUsable")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const row = yield* oauth.loadConnection(orgId)
				return row !== null && row.revokedAt === null
			})

			/** Best effort: a failed revoke still drops the local grant, and is logged. */
			const revokeUpstream = Effect.fn("SupabaseOAuthService.revokeUpstream")(function* (orgId: OrgId) {
				const config = yield* resolveConfig(env)
				const row = yield* oauth.loadConnection(orgId)
				if (
					row === null ||
					row.refreshTokenCiphertext === null ||
					row.refreshTokenIv === null ||
					row.refreshTokenTag === null
				) {
					return false
				}
				const refreshToken = yield* oauth.decryptValue({
					ciphertext: row.refreshTokenCiphertext,
					iv: row.refreshTokenIv,
					tag: row.refreshTokenTag,
				})
				yield* revokeGrant(httpClient, config.apiBaseUrl, { ...config, refreshToken })
				return true
			})

			const disconnect = Effect.fn("SupabaseOAuthService.disconnect")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const revoked = yield* revokeUpstream(orgId).pipe(
					Effect.catch((error) =>
						Effect.logWarning("Supabase grant revoke failed; dropping the local grant anyway", {
							orgId,
							error: error.message,
						}).pipe(Effect.as(false)),
					),
				)
				yield* Effect.annotateCurrentSpan("maple.supabase.revoked_upstream", revoked)
				return yield* oauth.deleteConnection(orgId)
			})

			return {
				isConfigured: isSupabaseConfigured(env),
				apiBaseUrl,
				startConnect,
				completeConnect,
				getValidAccessToken,
				withAccessToken,
				isGrantUsable,
				disconnect,
			} satisfies SupabaseOAuthServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
