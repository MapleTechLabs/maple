// Shared OAuth-connection machinery for provider integrations (Cloudflare,
// Hazel, ...). Both providers persist into the same `oauth_connections` /
// `oauth_auth_states` tables, so the state-row lifecycle, encrypted token
// persistence, token-endpoint HTTP calls, and refresh semantics live here —
// parameterized by provider id and display label. Provider-specific flow
// (PKCE, OIDC discovery, account resolution) stays in each service.

import { createHash, randomBytes, randomUUID } from "node:crypto"
import {
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsRevokedError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	type OrgId,
} from "@maple/domain/http"
import type { PullSourcePlatform, SourceId } from "@maple/domain/primitives"
import type { MapleDb } from "@maple/db/client"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	OAuthAuthStates,
	OAuthConnections,
	type OAuthConnectionInsert,
	type OAuthConnectionRow,
} from "@maple/db/tables"
import { Clock, Effect, Option, Redacted, Schedule, Schema, Semaphore } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import {
	decryptAes256Gcm,
	encryptAes256Gcm,
	parseBase64Aes256GcmKey,
	type EncryptedValue,
} from "@maple/backend/platform/Crypto"
import type { DatabaseApi } from "@maple/backend/platform/DatabaseLive"
import { deleteSourcesOf, createIntegrationSource } from "@maple/backend/services/org/integration-sources"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import type { EnvConfig } from "@maple/backend/platform/Env"
import { makeOAuthStateConsumer, type OAuthFlowInitiator } from "./oauth-state"

export const OAUTH_STATE_TTL_MS = 10 * 60_000 // 10 minutes
export const OAUTH_REFRESH_LEEWAY_MS = 60_000 // refresh when the access token is within 1 minute of expiry

/**
 * How long `getValidConnectionToken` may serve a connection row from the
 * in-isolate memo instead of re-reading Postgres.
 *
 * Why this exists: an uncached read on a hot path is a network call exposed to
 * the dial itself — measured at p50 11ms but with ~4% of dials stalling out.
 * Poller and scrape paths call this once per tick per org, which made it one of
 * the largest sources of dial volume on the api worker. Requests now share one
 * connection per invocation (`pg-connection-scope.ts`), which amortizes the
 * dial but not the round trip.
 *
 * 60s is deliberately far tighter than the token's own lifetime: the memo is
 * about collapsing a burst of same-tick reads, not about holding credentials.
 * It is also bounded twice over — an entry is only served while `rowIsValid`
 * still holds for it, so a token nearing expiry re-reads regardless of TTL.
 */
const CONNECTION_MEMO_TTL_MS = 60_000

/** Standard OAuth2 token payload (OIDC providers add `id_token`). */
export const OAuthTokenResponseSchema = Schema.Struct({
	access_token: Schema.String,
	token_type: Schema.optionalKey(Schema.String),
	expires_in: Schema.optionalKey(Schema.Number),
	refresh_token: Schema.optionalKey(Schema.String),
	scope: Schema.optionalKey(Schema.String),
	id_token: Schema.optionalKey(Schema.String),
})
export type OAuthTokenResponse = typeof OAuthTokenResponseSchema.Type

const decodeTokenResponse = Schema.decodeUnknownEffect(OAuthTokenResponseSchema)
const decodeJsonUnknown = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

/**
 * RFC 6749 §5.2 error body. Token endpoints answer 400/401 for many reasons —
 * `invalid_client` (rotated/misconfigured client secret), `invalid_request`,
 * `invalid_scope` — and only `invalid_grant` means the grant itself is dead.
 * Classifying any other 400/401 as revoked would let one bad Maple client
 * secret stamp every tenant connection revoked at once.
 */
const decodeOAuthErrorCode = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Struct({ error: Schema.String })),
)

const oauthErrorCodeOf = (text: string): Option.Option<string> =>
	Option.map(decodeOAuthErrorCode(text), (body) => body.error)

/** PKCE (RFC 7636) S256 pair: the verifier is stashed on the auth-state row and replayed at exchange. */
export const generateCodeVerifier = (): string => randomBytes(32).toString("base64url")
export const deriveCodeChallenge = (verifier: string): string =>
	createHash("sha256").update(verifier).digest("base64url")

/** Hard cap on one token-endpoint POST (execute + body read). */
const TOKEN_REQUEST_TIMEOUT = "20 seconds"

export const toUpstreamError = (message: string, status?: number, cause?: unknown) =>
	new IntegrationsUpstreamError({
		message,
		...(!(status === undefined) ? { status } : undefined),
		...(!(cause === undefined) ? { cause } : undefined),
	})

/** The token-endpoint slice of a provider's resolved OAuth config. */
export interface OAuthTokenEndpointConfig {
	readonly tokenUrl: string
	readonly clientId: string
	/** null for a public (PKCE-only) client. Stays Redacted until the token POST body. */
	readonly clientSecret: Redacted.Redacted<string> | null
	/** How a confidential client authenticates (RFC 6749 s2.3.1); defaults to the POST body. */
	readonly clientAuthentication?: "client_secret_post" | "client_secret_basic"
	/** A non-RFC status the provider answers for an unknown or rotated-away refresh token (Supabase: 404). */
	readonly deadRefreshTokenStatus?: number
}

/** Client credentials for a token-endpoint call: body params plus any Authorization header. */
const clientCredentials = (
	config: OAuthTokenEndpointConfig,
): { readonly params: Record<string, string>; readonly headers: Record<string, string> } => {
	if (config.clientSecret === null) return { params: { client_id: config.clientId }, headers: {} }
	const secret = Redacted.value(config.clientSecret)
	if (config.clientAuthentication === "client_secret_basic") {
		const basic = Buffer.from(
			`${encodeURIComponent(config.clientId)}:${encodeURIComponent(secret)}`,
		).toString("base64")
		return { params: {}, headers: { authorization: `Basic ${basic}` } }
	}
	return { params: { client_id: config.clientId, client_secret: secret }, headers: {} }
}

export interface MakeOAuthConnectionHelpersOptions {
	/** Row value in `oauth_connections.provider` / `oauth_auth_states.provider`. */
	readonly provider: string
	/** Display name used in error messages ("Cloudflare", "Hazel"). */
	readonly providerLabel: string
	readonly database: DatabaseApi
	readonly env: EnvConfig
	/** Set when the connection sends data: it owns a source, created and deleted with it. */
	readonly source?: {
		readonly platform: PullSourcePlatform
		readonly name: (connection: { readonly externalAccountName: string | null }) => string
		/** Other rows that send as the same source, linked when the source is created. */
		readonly link?: (
			db: MapleDb,
			orgId: OrgId,
			sourceId: SourceId,
		) => Effect.Effect<unknown, Effect.Error<ReturnType<MapleDb["run"]>>>
	}
}

/**
 * Build the provider-parameterized connection helpers. Effectful because it
 * validates the shared token-encryption key up front.
 */
export const makeOAuthConnectionHelpers = (options: MakeOAuthConnectionHelpersOptions) =>
	Effect.gen(function* () {
		const { provider, providerLabel, database, env, source } = options
		const httpClient = yield* HttpClient.HttpClient

		const encryptionKey = yield* parseBase64Aes256GcmKey(
			Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
			(message) =>
				new IntegrationsValidationError({
					message:
						message === "Expected a non-empty base64 encryption key"
							? "MAPLE_INGEST_KEY_ENCRYPTION_KEY is required"
							: message === "Expected base64 for exactly 32 bytes"
								? "MAPLE_INGEST_KEY_ENCRYPTION_KEY must be base64 for exactly 32 bytes"
								: message,
				}),
		)

		const toPersistenceError = makePersistenceErrorMapper(
			IntegrationsPersistenceError,
			`${providerLabel} integration database error`,
		)

		const dbExecute = makeDbExecute(database, `${providerLabel} integration`, toPersistenceError)

		const encryptValue = (plaintext: string) =>
			encryptAes256Gcm(
				plaintext,
				encryptionKey,
				(message) =>
					new IntegrationsPersistenceError({
						message: `Failed to encrypt ${providerLabel} token: ${message}`,
					}),
			)

		const decryptValue = (encrypted: EncryptedValue) =>
			decryptAes256Gcm(
				encrypted,
				encryptionKey,
				() =>
					new IntegrationsPersistenceError({
						message: `Failed to decrypt stored ${providerLabel} token`,
					}),
			)

		const purgeExpiredStates = (currentTime: number) =>
			dbExecute((db) =>
				db.run(PG.deleteFrom(OAuthAuthStates).where(($) => [$.expiresAt.lt(currentTime)])),
			)

		const consumeState = makeOAuthStateConsumer(database, toPersistenceError)

		/** Claim this provider's state row, only for the Maple user and org that started the flow. */
		const consumeStateRow = (state: string, initiator: OAuthFlowInitiator) =>
			consumeState({ state, provider, initiator })

		/**
		 * Per-isolate connection-row memo backing `getValidConnectionToken` only.
		 *
		 * Scoped to that one caller on purpose. `loadConnection` /
		 * `requireConnection` must stay uncached: the refresh path re-reads the row
		 * specifically to detect that a *different* isolate rotated the refresh
		 * token (see `refreshWithSingleFlight`), and a memo there would hand that
		 * re-read its own stale row and turn a recoverable race into a spurious
		 * "revoked".
		 */
		const connectionMemo = new Map<string, { row: OAuthConnectionRow; expiresAt: number }>()

		/**
		 * Drop the memoized row for an org. Must be called from every path that
		 * writes or removes the connection — a stale entry here serves a token for
		 * a grant that was just revoked or reconnected.
		 */
		const invalidateConnectionMemo = (orgId: OrgId) =>
			Effect.sync(() => {
				connectionMemo.delete(orgId)
			})

		const loadConnection = (orgId: OrgId) =>
			dbExecute((db) =>
				db.run(
					PG.from(OAuthConnections)
						.select()
						.where(($) => [$.orgId.eq(orgId), $.provider.eq(provider)])
						.limit(1),
				),
			).pipe(Effect.map((rows) => rows[0] ?? null))

		const requireConnection = Effect.fn("OAuthConnectionHelpers.requireConnection")(function* (
			orgId: OrgId,
		) {
			const row = yield* loadConnection(orgId)
			if (!row) {
				return yield* Effect.fail(
					new IntegrationsNotConnectedError({
						message: `${providerLabel} is not connected for this organization`,
					}),
				)
			}
			return row satisfies OAuthConnectionRow
		})

		/**
		 * Write (or overwrite) the org's connection. The unique index on (orgId, provider)
		 * makes select-then-branch unnecessary; a reconnect keeps the row id and its source.
		 */
		const upsertConnection = (
			orgId: OrgId,
			currentTime: number,
			values: Omit<
				OAuthConnectionInsert,
				"id" | "orgId" | "provider" | "sourceId" | "createdAt" | "updatedAt"
			>,
		) =>
			dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						const [connection] = yield* db.run(
							PG.insertInto(OAuthConnections)
								.values({
									id: randomUUID(),
									orgId,
									provider,
									createdAt: currentTime,
									updatedAt: currentTime,
									...values,
								})
								.onConflictDoUpdate({
									target: ["orgId", "provider"],
									// Reconnecting with fresh tokens clears any prior revocation so
									// pollers resume automatically.
									set: { ...values, revokedAt: null, updatedAt: currentTime },
								})
								.returning("id", "sourceId", "externalAccountName"),
						)
						if (source === undefined || connection === undefined || connection.sourceId !== null)
							return
						const sourceId = yield* createIntegrationSource(
							db,
							orgId,
							{ platform: source.platform, name: source.name(connection) },
							currentTime,
						)
						yield* db.run(
							PG.update(OAuthConnections)
								.set({ sourceId })
								.where(($) => [$.id.eq(connection.id)]),
						)
						if (source.link !== undefined) yield* source.link(db, orgId, sourceId)
					}),
				),
			).pipe(Effect.ensuring(invalidateConnectionMemo(orgId)))

		/**
		 * Stamp the connection as revoked (idempotent — only the first stamp writes).
		 * Pollers filter on `revokedAt IS NULL`, so a revoked grant stops being
		 * retried every tick; `upsertConnection` (reconnect) clears the stamp.
		 * With `unchangedSince`, the stamp is a no-op once the row was rewritten after that read.
		 * Best-effort: bookkeeping must never mask the revocation error itself.
		 */
		const markConnectionRevoked = Effect.fn("OAuthConnectionHelpers.markConnectionRevoked")(function* (
			orgId: OrgId,
			unchangedSince?: number,
		) {
			const currentTime = yield* Clock.currentTimeMillis
			// Before the write, not after: the memo must not outlive the decision to
			// revoke even if the stamp itself fails (it is best-effort/ignored below).
			yield* invalidateConnectionMemo(orgId)
			yield* dbExecute((db) =>
				db.run(
					PG.update(OAuthConnections)
						.set({ revokedAt: currentTime })
						.where(($) => [
							$.orgId.eq(orgId),
							$.provider.eq(provider),
							$.revokedAt.isNull(),
							...(unchangedSince === undefined ? [] : [$.updatedAt.eq(unchangedSince)]),
						]),
				),
			).pipe(Effect.ignore)
		})

		/** Drop the org's connection row and its source; reports whether anything was removed. */
		const deleteConnection = (orgId: OrgId) =>
			dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						const deleted = yield* db.run(
							PG.deleteFrom(OAuthConnections)
								.where(($) => [$.orgId.eq(orgId), $.provider.eq(provider)])
								.returning("id", "sourceId"),
						)
						yield* deleteSourcesOf(db, orgId, deleted)
						return deleted
					}),
				),
			).pipe(
				Effect.map((result) => ({ disconnected: result.length > 0 })),
				Effect.ensuring(invalidateConnectionMemo(orgId)),
			)

		/** POST an `application/x-www-form-urlencoded` body and return the raw status + text. */
		const postForm = Effect.fn("OAuthConnectionHelpers.postForm")(
			function* (url: string, params: Record<string, string>, headers: Record<string, string> = {}) {
				const request = HttpClientRequest.post(url, {
					headers: { accept: "application/json", ...headers },
				}).pipe(HttpClientRequest.bodyUrlParams(params))
				// Bounded so a stalled token endpoint cannot pin the uninterruptible refresh (and its permit).
				return yield* Effect.gen(function* () {
					const response = yield* httpClient.execute(request)
					const text = yield* response.text
					return { status: response.status, text }
				}).pipe(
					Effect.timeoutOrElse({
						duration: TOKEN_REQUEST_TIMEOUT,
						orElse: () =>
							Effect.fail(toUpstreamError(`${providerLabel} OAuth request timed out`)),
					}),
				)
			},
			Effect.catchTag("HttpClientError", (error) =>
				Effect.fail(
					toUpstreamError(
						`${providerLabel} OAuth request failed: ${error.message}`,
						error.response?.status,
						error.reason,
					),
				),
			),
		)

		const parseTokenPayload = (text: string) =>
			decodeJsonUnknown(text).pipe(
				Effect.mapError(() =>
					toUpstreamError(`${providerLabel} token endpoint returned a non-JSON response`),
				),
				Effect.flatMap((json) =>
					decodeTokenResponse(json).pipe(
						Effect.mapError(() =>
							toUpstreamError(`${providerLabel} token endpoint returned an unexpected payload`),
						),
					),
				),
			)

		const exchangeAuthorizationCode = Effect.fn("OAuthConnectionHelpers.exchangeAuthorizationCode")(
			function* (
				config: OAuthTokenEndpointConfig,
				code: string,
				redirectUri: string,
				extraParams: Record<string, string> = {},
			) {
				const credentials = clientCredentials(config)
				const { status, text } = yield* postForm(
					config.tokenUrl,
					{
						grant_type: "authorization_code",
						code,
						redirect_uri: redirectUri,
						...credentials.params,
						...extraParams,
					},
					credentials.headers,
				)
				if (status < 200 || status >= 300) {
					return yield* Effect.fail(
						toUpstreamError(`Token exchange failed: ${text || status}`, status),
					)
				}
				return yield* parseTokenPayload(text)
			},
		)

		/**
		 * Refresh-grant call with the shared classification rule: only a 400/401
		 * whose RFC 6749 error body says `invalid_grant` means the grant itself is
		 * gone (revoked / rotated away). Every other failure — `invalid_client`
		 * from a rotated Maple secret, a bodyless 400, 429s, 5xx — is a
		 * non-mutating upstream failure and must not stamp the connection revoked.
		 */
		const refreshAccessToken = Effect.fn("OAuthConnectionHelpers.refreshAccessToken")(function* (
			config: OAuthTokenEndpointConfig,
			refreshToken: string,
		) {
			const credentials = clientCredentials(config)
			const { status, text } = yield* postForm(
				config.tokenUrl,
				{ grant_type: "refresh_token", refresh_token: refreshToken, ...credentials.params },
				credentials.headers,
			)
			if (status === config.deadRefreshTokenStatus) {
				return yield* Effect.fail(
					new IntegrationsRevokedError({
						message: `${providerLabel} connection is no longer authorized; reconnect required`,
					}),
				)
			}
			if (status === 400 || status === 401) {
				const errorCode = oauthErrorCodeOf(text)
				// Only a decoded `invalid_grant` means revoked: a None (bodyless or
				// undecodable 400/401) stays a transient upstream failure below.
				if (Option.contains(errorCode, "invalid_grant")) {
					return yield* Effect.fail(
						new IntegrationsRevokedError({
							message: `${providerLabel} connection is no longer authorized; reconnect required`,
						}),
					)
				}
				return yield* Effect.fail(
					toUpstreamError(
						`Token refresh failed with ${status}${Option.match(errorCode, {
							onNone: () => "",
							onSome: (code) => ` (${code})`,
						})}`,
						status,
					),
				)
			}
			if (status < 200 || status >= 300) {
				return yield* Effect.fail(toUpstreamError(`Token refresh failed with ${status}`, status))
			}
			return yield* parseTokenPayload(text)
		})

		const persistRefreshedTokens = Effect.fn("OAuthConnectionHelpers.persistRefreshedTokens")(function* (
			row: OAuthConnectionRow,
			tokenResponse: OAuthTokenResponse,
		) {
			const accessEnc = yield* encryptValue(tokenResponse.access_token)
			const refreshEnc = tokenResponse.refresh_token
				? yield* encryptValue(tokenResponse.refresh_token)
				: null
			const currentTime = yield* Clock.currentTimeMillis
			const expiresAt =
				tokenResponse.expires_in != null ? currentTime + tokenResponse.expires_in * 1000 : null
			yield* dbExecute((db) =>
				db.run(
					PG.update(OAuthConnections)
						.set({
							accessTokenCiphertext: accessEnc.ciphertext,
							accessTokenIv: accessEnc.iv,
							accessTokenTag: accessEnc.tag,
							refreshTokenCiphertext: refreshEnc?.ciphertext ?? row.refreshTokenCiphertext,
							refreshTokenIv: refreshEnc?.iv ?? row.refreshTokenIv,
							refreshTokenTag: refreshEnc?.tag ?? row.refreshTokenTag,
							expiresAt,
							// A successful refresh proves the grant alive, even if a racing isolate stamped it.
							revokedAt: null,
							updatedAt: currentTime,
						})
						.where(($) => [$.id.eq(row.id)]),
				),
			).pipe(
				// The provider already rotated the refresh token, so this write holds the
				// only usable copy — losing it to a transient Postgres blip turns into a
				// permanent disconnect on the next refresh. Retry hard before giving up.
				Effect.retry({ times: 3, schedule: Schedule.exponential("100 millis") }),
			)
			return tokenResponse.access_token
		})

		const rowIsValid = (row: OAuthConnectionRow, currentTime: number) =>
			row.expiresAt === null || row.expiresAt - currentTime > OAUTH_REFRESH_LEEWAY_MS

		const accessTokenFromRow = (row: OAuthConnectionRow) =>
			decryptValue({
				ciphertext: row.accessTokenCiphertext,
				iv: row.accessTokenIv,
				tag: row.accessTokenTag,
			}).pipe(Effect.map((accessToken) => ({ accessToken, row })))

		// Providers rotate refresh tokens on use, so two concurrent refreshes with the same
		// stored token make the loser 400 — which would falsely surface as "revoked". Serialize
		// refreshes within this isolate (refreshes are rare, one permit is fine) and re-check the
		// row after acquiring: a fiber that waited usually finds the winner's fresh tokens.
		const refreshSemaphore = Semaphore.makeUnsafe(1)

		const refreshRow = (config: OAuthTokenEndpointConfig, orgId: OrgId, row: OAuthConnectionRow) =>
			Effect.gen(function* () {
				if (!row.refreshTokenCiphertext || !row.refreshTokenIv || !row.refreshTokenTag) {
					yield* markConnectionRevoked(orgId)
					return yield* Effect.fail(
						new IntegrationsRevokedError({
							message: `${providerLabel} access token expired and no refresh token is stored — reconnect required`,
						}),
					)
				}

				const refreshToken = yield* decryptValue({
					ciphertext: row.refreshTokenCiphertext,
					iv: row.refreshTokenIv,
					tag: row.refreshTokenTag,
				})
				return yield* refreshAccessToken(config, refreshToken).pipe(
					Effect.flatMap((refreshed) => persistRefreshedTokens(row, refreshed)),
					// The provider rotates the refresh token on use, so an interrupt between the POST and
					// the write loses the only usable copy. postForm's timeout and the write's retries bound it.
					Effect.uninterruptible,
					Effect.map((accessToken) => ({ accessToken, row })),
					// Cross-isolate race: a concurrent worker isolate may have consumed the rotated
					// refresh token and persisted new tokens between our read and our refresh. Before
					// declaring the connection revoked, re-read the row — if a newer, valid token
					// landed, use it.
					Effect.catchTag("@maple/http/errors/IntegrationsRevokedError", (error) =>
						Effect.gen(function* () {
							const latest = yield* requireConnection(orgId)
							const advanced = latest.updatedAt > row.updatedAt
							if (advanced && rowIsValid(latest, yield* Clock.currentTimeMillis)) {
								return yield* accessTokenFromRow(latest)
							}
							// Only while the row is still the one we read: a racing isolate may persist
							// fresh tokens between our re-read and this stamp.
							yield* markConnectionRevoked(orgId, row.updatedAt)
							return yield* Effect.fail(error)
						}),
					),
				)
			})

		const refreshWithSingleFlight = (config: OAuthTokenEndpointConfig, orgId: OrgId) =>
			refreshSemaphore.withPermits(1)(
				Effect.gen(function* () {
					// Double-checked: another local fiber may have refreshed while we waited.
					const row = yield* requireConnection(orgId)
					if (rowIsValid(row, yield* Clock.currentTimeMillis)) {
						return yield* accessTokenFromRow(row)
					}
					return yield* refreshRow(config, orgId, row)
				}),
			)

		/**
		 * The provider rejected an access token whose `expiresAt` still says it is good (revoked
		 * or superseded upstream). Refresh once regardless of expiry, unless another fiber or
		 * isolate already replaced the rejected token.
		 */
		const refreshRejectedToken = (
			config: OAuthTokenEndpointConfig,
			orgId: OrgId,
			rejectedAccessToken: string,
		) =>
			refreshSemaphore.withPermits(1)(
				Effect.gen(function* () {
					yield* invalidateConnectionMemo(orgId)
					const row = yield* requireConnection(orgId)
					const current = yield* accessTokenFromRow(row)
					if (current.accessToken !== rejectedAccessToken) return current
					return yield* refreshRow(config, orgId, row)
				}),
			)

		/**
		 * Stamp the grant revoked because the provider rejected `rejectedAccessToken`, but only
		 * while the row still holds that token and has not changed since it was read. A reconnect
		 * or a refresh elsewhere in the meantime wins, so a late 401 never revokes a newer grant.
		 * Reports whether the stamp landed.
		 */
		const markRejectedTokenRevoked = Effect.fn("OAuthConnectionHelpers.markRejectedTokenRevoked")(
			function* (orgId: OrgId, rejectedAccessToken: string) {
				yield* invalidateConnectionMemo(orgId)
				const row = yield* requireConnection(orgId)
				const { accessToken } = yield* accessTokenFromRow(row)
				if (accessToken !== rejectedAccessToken) return false
				const currentTime = yield* Clock.currentTimeMillis
				const stamped = yield* dbExecute((db) =>
					db.run(
						PG.update(OAuthConnections)
							.set({ revokedAt: currentTime })
							.where(($) => [
								$.id.eq(row.id),
								$.updatedAt.eq(row.updatedAt),
								$.revokedAt.isNull(),
							])
							.returning("id"),
					),
				)
				return stamped.length > 0
			},
		)

		/**
		 * Decrypted access token for the org's connection, refreshing (single-flight)
		 * when it is within the expiry leeway. Returns the row alongside so callers
		 * can project provider-specific fields (account id, scope, ...).
		 */
		const getValidConnectionToken = Effect.fn("OAuthConnectionHelpers.getValidConnectionToken")(
			function* (
				config: OAuthTokenEndpointConfig,
				orgId: OrgId,
				options: {
					/** Fail a revoked grant before refreshing it: its fresh token would be unusable too. */
					readonly failIfRevoked?: boolean
				} = {},
			) {
				const usable = (row: OAuthConnectionRow) =>
					options.failIfRevoked === true && row.revokedAt !== null
						? Effect.fail(
								new IntegrationsRevokedError({
									message: `${providerLabel} no longer accepts this authorization — reconnect the integration`,
								}),
							)
						: Effect.void
				const nowMs = yield* Clock.currentTimeMillis
				const memoized = connectionMemo.get(orgId)
				if (memoized !== undefined && memoized.expiresAt > nowMs && rowIsValid(memoized.row, nowMs)) {
					yield* Effect.annotateCurrentSpan("maple.oauth.connection_memo_hit", true)
					yield* usable(memoized.row)
					return yield* accessTokenFromRow(memoized.row)
				}
				yield* Effect.annotateCurrentSpan("maple.oauth.connection_memo_hit", false)

				const row = yield* requireConnection(orgId)
				yield* usable(row)
				if (rowIsValid(row, nowMs)) {
					connectionMemo.set(orgId, { row, expiresAt: nowMs + CONNECTION_MEMO_TTL_MS })
					return yield* accessTokenFromRow(row)
				}
				// Deliberately not memoized. `refreshWithSingleFlight` resolves to the
				// row as it was read *before* the refresh, so its ciphertext is the
				// superseded token — caching it would serve a stale credential for the
				// whole TTL. Refreshes are rare; the next call re-reads and memoizes
				// the persisted row.
				return yield* refreshWithSingleFlight(config, orgId)
			},
		)

		/**
		 * Run `use` with the org's access token (a stamped grant fails first). A rejected token forces
		 * one refresh and a retry; a rejected fresh token stamps the grant revoked.
		 */
		const withRejectedTokenRetry = <A, E, Rejected extends E & { readonly message: string }>(
			config: OAuthTokenEndpointConfig,
			orgId: OrgId,
			isRejected: (error: E) => error is Rejected,
			use: (accessToken: string) => Effect.Effect<A, E>,
		) =>
			Effect.gen(function* () {
				const { accessToken } = yield* getValidConnectionToken(config, orgId, { failIfRevoked: true })
				return yield* use(accessToken).pipe(
					Effect.catchIf(isRejected, () =>
						Effect.gen(function* () {
							const refreshed = yield* refreshRejectedToken(config, orgId, accessToken)
							return yield* use(refreshed.accessToken).pipe(
								Effect.catchIf(isRejected, (rejected) =>
									markRejectedTokenRevoked(orgId, refreshed.accessToken).pipe(
										Effect.tap((stamped) =>
											Effect.annotateCurrentSpan(
												`maple.${provider}.grant_revoked`,
												stamped,
											),
										),
										Effect.andThen(
											Effect.fail(
												new IntegrationsRevokedError({
													message: rejected.message,
												}),
											),
										),
									),
								),
							)
						}),
					),
				)
			})

		return {
			toPersistenceError,
			dbExecute,
			encryptValue,
			decryptValue,
			purgeExpiredStates,
			consumeStateRow,
			loadConnection,
			requireConnection,
			upsertConnection,
			deleteConnection,
			markConnectionRevoked,
			markRejectedTokenRevoked,
			postForm,
			exchangeAuthorizationCode,
			refreshAccessToken,
			refreshRejectedToken,
			persistRefreshedTokens,
			rowIsValid,
			getValidConnectionToken,
			withRejectedTokenRetry,
		} as const
	})
