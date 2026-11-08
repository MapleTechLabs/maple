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
import { OAuthAuthStates, SearchConsoleSites } from "@maple/db/tables"
import { Clock, Context, Effect, Layer, Option, Schema, String as Str, Array as Arr } from "effect"
import { FetchHttpClient } from "effect/http"
import { Env, type EnvConfig } from "@maple/backend/platform/Env"
import { Database } from "@maple/backend/platform/DatabaseLive"
import {
	isSearchConsoleTokenRejected,
	type SearchConsoleTokenRejectedError,
} from "@maple/backend/services/integrations/google-search-console/client"
import {
	makeOAuthConnectionHelpers,
	OAUTH_STATE_TTL_MS,
	type OAuthTokenEndpointConfig,
	toUpstreamError,
} from "./oauth/connection-helpers"
import type { OAuthFlowInitiator } from "./oauth/oauth-state"

export const GOOGLE_PROVIDER = "google"
/** Where Google redirects after consent; registered as an authorized redirect URI on the client. */
export const GOOGLE_CALLBACK_PATH = "/api/integrations/google/callback"

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_URL = "https://oauth2.googleapis.com/token"
const REVOKE_URL = "https://oauth2.googleapis.com/revoke"
export const SEARCH_CONSOLE_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"
const SCOPES = `openid email ${SEARCH_CONSOLE_SCOPE}`

/** The claims Maple reads from the id_token Google returns with the code exchange. */
const IdTokenClaims = Schema.Struct({
	sub: Schema.String,
	email: Schema.optionalKey(Schema.String),
})
const decodeIdTokenClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(IdTokenClaims))

/**
 * The id_token comes straight from Google's token endpoint over TLS, so its payload is read
 * without verifying the signature (Google's OpenID guidance for server-side code flows).
 */
const idTokenClaims = (idToken: string | undefined) => {
	const payload = idToken === undefined ? undefined : Str.split(".")(idToken)[1]
	return payload === undefined
		? Effect.fail(toUpstreamError("Google did not return an id_token for the connected account"))
		: decodeIdTokenClaims(Buffer.from(payload, "base64url").toString("utf8")).pipe(
				Effect.mapError(() => toUpstreamError("Google returned an unreadable id_token")),
			)
}

const resolveConfig = Effect.fn("GoogleOAuthService.resolveConfig")(function* (env: EnvConfig) {
	const clientId = yield* Effect.fromOption(
		env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID,
		() =>
			new IntegrationsConfigurationError({
				message: "GOOGLE_SEARCH_CONSOLE_CLIENT_ID is required to use the Google Search Console integration",
			}),
	)
	const clientSecret = yield* Effect.fromOption(
		env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET,
		() =>
			new IntegrationsConfigurationError({
				message:
					"GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET is required to use the Google Search Console integration",
			}),
	)
	return { tokenUrl: TOKEN_URL, clientId, clientSecret } satisfies OAuthTokenEndpointConfig
})

/** Exact failures involved in resolving a usable Google access token. */
export type GoogleAccessTokenError =
	| IntegrationsNotConnectedError
	| IntegrationsRevokedError
	| IntegrationsUpstreamError
	| IntegrationsPersistenceError
	| IntegrationsValidationError
	| IntegrationsConfigurationError

export interface GoogleConnection {
	/** `oauth_connections.id`, which Search Console site rows reference. */
	readonly id: string
	readonly accountEmail: string | null
	readonly connectedByUserId: UserId
	readonly revoked: boolean
}

export interface GoogleOAuthServiceApi {
	readonly startConnect: (
		orgId: OrgId,
		userId: UserId,
		options: { readonly callbackUrl: string; readonly returnTo?: string },
	) => Effect.Effect<
		{ readonly redirectUrl: string; readonly state: string },
		IntegrationsConfigurationError | IntegrationsPersistenceError
	>
	readonly completeConnect: (
		code: string,
		state: string,
		initiator: OAuthFlowInitiator,
	) => Effect.Effect<
		{ readonly orgId: OrgId; readonly returnTo: string | null; readonly accountEmail: string | null },
		| IntegrationsValidationError
		| IntegrationsConfigurationError
		| IntegrationsUpstreamError
		| IntegrationsRevokedError
		| IntegrationsPersistenceError
	>
	/** The org's Google grant, or null when it has none. */
	readonly getConnection: (
		orgId: OrgId,
	) => Effect.Effect<GoogleConnection | null, IntegrationsPersistenceError>
	/**
	 * Run `use` with the org's Google token. A token Google rejects is refreshed once and
	 * retried; a rejected fresh token (or an `invalid_grant` refresh) marks the grant revoked.
	 */
	readonly withAccessToken: <A, E>(
		orgId: OrgId,
		use: (accessToken: string) => Effect.Effect<A, E | SearchConsoleTokenRejectedError>,
	) => Effect.Effect<A, Exclude<E, SearchConsoleTokenRejectedError> | GoogleAccessTokenError>
	/** Revoke the grant at Google (best effort) and drop it with every site row under it. */
	readonly disconnect: (
		orgId: OrgId,
	) => Effect.Effect<{ readonly disconnected: boolean }, IntegrationsPersistenceError>
}

export class GoogleOAuthService extends Context.Service<GoogleOAuthService, GoogleOAuthServiceApi>()(
	"@maple/backend/services/GoogleOAuthService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const oauth = yield* makeOAuthConnectionHelpers({
				provider: GOOGLE_PROVIDER,
				providerLabel: "Google",
				database,
				env,
				// Another Google account sees other properties: the old picks would only fail to import.
				onUpsert: (db, orgId, _currentTime, change) =>
					change.previousExternalUserId === null ||
					change.previousExternalUserId === change.externalUserId
						? Effect.void
						: db.run(PG.deleteFrom(SearchConsoleSites).where(($) => [$.orgId.eq(orgId)])),
			})

			const startConnect = Effect.fn("GoogleOAuthService.startConnect")(function* (
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
					db.run(
						PG.insertInto(OAuthAuthStates).values({
							state,
							orgId,
							provider: GOOGLE_PROVIDER,
							initiatedByUserId: userId,
							redirectUri: options.callbackUrl,
							returnTo: options.returnTo ?? null,
							createdAt: currentTime,
							expiresAt: currentTime + OAUTH_STATE_TTL_MS,
						}),
					),
				)

				const params = new URLSearchParams({
					client_id: config.clientId,
					redirect_uri: options.callbackUrl,
					response_type: "code",
					scope: SCOPES,
					state,
					// Offline access plus a forced consent screen: Google only returns a refresh token then.
					access_type: "offline",
					prompt: "consent",
					include_granted_scopes: "true",
				})
				return { redirectUrl: `${AUTHORIZE_URL}?${params.toString()}`, state }
			})

			const completeConnect = Effect.fn("GoogleOAuthService.completeConnect")(function* (
				code: string,
				state: string,
				initiator: OAuthFlowInitiator,
			) {
				yield* Effect.annotateCurrentSpan({ orgId: initiator.orgId })
				const config = yield* resolveConfig(env)
				const stateRow = yield* oauth.consumeStateRow(state, initiator)
				const tokens = yield* oauth.exchangeAuthorizationCode(config, code, stateRow.redirectUri)
				// Google's consent screen lets the user untick a scope; without it nothing works.
				const granted = Str.split(" ")(tokens.scope ?? "")
				if (!Arr.contains(granted, SEARCH_CONSOLE_SCOPE)) {
					return yield* new IntegrationsValidationError({
						message:
							"Google did not grant Search Console access. Reconnect and allow Maple to view your Search Console data.",
					})
				}
				if (tokens.refresh_token === undefined) {
					return yield* toUpstreamError(
						"Google did not return a refresh token. Reconnect and try again.",
					)
				}
				const claims = yield* idTokenClaims(tokens.id_token)

				const accessEnc = yield* oauth.encryptValue(tokens.access_token)
				const refreshEnc = yield* oauth.encryptValue(tokens.refresh_token)
				const currentTime = yield* Clock.currentTimeMillis
				const orgId = stateRow.orgId

				yield* oauth.upsertConnection(orgId, currentTime, {
					externalUserId: claims.sub,
					externalUserEmail: claims.email ?? null,
					externalAccountName: claims.email ?? null,
					connectedByUserId: stateRow.initiatedByUserId,
					scope: tokens.scope ?? SCOPES,
					accessTokenCiphertext: accessEnc.ciphertext,
					accessTokenIv: accessEnc.iv,
					accessTokenTag: accessEnc.tag,
					refreshTokenCiphertext: refreshEnc.ciphertext,
					refreshTokenIv: refreshEnc.iv,
					refreshTokenTag: refreshEnc.tag,
					expiresAt: tokens.expires_in != null ? currentTime + tokens.expires_in * 1000 : null,
				})
				return { orgId, returnTo: stateRow.returnTo ?? null, accountEmail: claims.email ?? null }
			})

			const getConnection = Effect.fn("GoogleOAuthService.getConnection")(function* (orgId: OrgId) {
				const row = yield* oauth.loadConnection(orgId)
				if (row === null) return null
				return {
					id: row.id,
					accountEmail: row.externalUserEmail,
					connectedByUserId: row.connectedByUserId,
					revoked: row.revokedAt !== null,
				} satisfies GoogleConnection
			})

			const withAccessToken = <A, E>(
				orgId: OrgId,
				use: (accessToken: string) => Effect.Effect<A, E | SearchConsoleTokenRejectedError>,
			) =>
				resolveConfig(env).pipe(
					Effect.flatMap((config) =>
						oauth.withRejectedTokenRetry(config, orgId, isSearchConsoleTokenRejected, use),
					),
					Effect.withSpan("GoogleOAuthService.withAccessToken", { attributes: { orgId } }),
				)

			/** Best effort: the grant is dropped on Maple's side whatever Google answers. */
			const revokeAtGoogle = Effect.fn("GoogleOAuthService.revokeAtGoogle")(
				function* (orgId: OrgId) {
					const row = yield* oauth.loadConnection(orgId)
					if (row === null) return
					// Revoking the refresh token ends the whole grant, access tokens included.
					const token = yield* oauth.decryptValue(
						row.refreshTokenCiphertext !== null &&
							row.refreshTokenIv !== null &&
							row.refreshTokenTag !== null
							? {
									ciphertext: row.refreshTokenCiphertext,
									iv: row.refreshTokenIv,
									tag: row.refreshTokenTag,
								}
							: {
									ciphertext: row.accessTokenCiphertext,
									iv: row.accessTokenIv,
									tag: row.accessTokenTag,
								},
					)
					yield* oauth.postForm(REVOKE_URL, { token })
				},
				(effect) => Effect.ignore(effect),
			)

			const disconnect = Effect.fn("GoogleOAuthService.disconnect")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				yield* revokeAtGoogle(orgId)
				return yield* oauth.deleteConnection(orgId)
			})

			return {
				startConnect,
				completeConnect,
				getConnection,
				withAccessToken,
				disconnect,
			} satisfies GoogleOAuthServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}

/** Whether Google is configured for this deployment (both client id and secret set). */
export const isGoogleOAuthConfigured = (env: EnvConfig): boolean =>
	Option.isSome(env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID) && Option.isSome(env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET)
