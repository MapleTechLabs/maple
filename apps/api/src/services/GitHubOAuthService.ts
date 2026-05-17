import { randomBytes, randomUUID } from "node:crypto"
import {
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsRevokedError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import {
	githubServiceRepos,
	oauthAuthStates,
	oauthConnections,
	type OAuthAuthStateRow,
	type OAuthConnectionRow,
} from "@maple/db"
import { and, eq, lt } from "drizzle-orm"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { decryptAes256Gcm, encryptAes256Gcm, parseBase64Aes256GcmKey } from "./Crypto"
import { Database, type DatabaseClient } from "./DatabaseLive"
import { Env, type EnvShape } from "./Env"

const GITHUB_PROVIDER = "github"
const STATE_TTL_MS = 10 * 60_000 // 10 minutes
const REFRESH_LEEWAY_MS = 60_000 // 1 minute

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
const GITHUB_USER_URL = "https://api.github.com/user"
const GITHUB_REPOS_URL = "https://api.github.com/user/repos"
const REPO_PAGE_LIMIT = 5

const TokenResponseSchema = Schema.Struct({
	access_token: Schema.optional(Schema.String),
	token_type: Schema.optional(Schema.String),
	scope: Schema.optional(Schema.String),
	error: Schema.optional(Schema.String),
	error_description: Schema.optional(Schema.String),
})

const UserInfoSchema = Schema.Struct({
	id: Schema.Number,
	login: Schema.String,
})

const RepoSchema = Schema.Struct({
	name: Schema.String,
	full_name: Schema.String,
	private: Schema.Boolean,
	owner: Schema.Struct({ login: Schema.String }),
})
const ReposResponseSchema = Schema.Array(RepoSchema)

const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponseSchema)
const decodeUserInfo = Schema.decodeUnknownEffect(UserInfoSchema)
const decodeReposResponse = Schema.decodeUnknownEffect(ReposResponseSchema)

interface ResolvedGitHubOAuthConfig {
	readonly clientId: string
	readonly clientSecret: string
	readonly scopes: string
}

const resolveConfig = (env: EnvShape): Effect.Effect<ResolvedGitHubOAuthConfig, IntegrationsValidationError> =>
	Effect.gen(function* () {
		const requireSome = <A>(
			opt: Option.Option<A>,
			message: string,
		): Effect.Effect<A, IntegrationsValidationError> =>
			Option.match(opt, {
				onNone: () => Effect.fail(new IntegrationsValidationError({ message })),
				onSome: (value) => Effect.succeed(value),
			})

		const clientId = yield* requireSome(
			env.GITHUB_OAUTH_CLIENT_ID,
			"GITHUB_OAUTH_CLIENT_ID is required to use the GitHub integration",
		)
		const clientSecretRedacted = yield* requireSome(
			env.GITHUB_OAUTH_CLIENT_SECRET,
			"GITHUB_OAUTH_CLIENT_SECRET is required to use the GitHub integration",
		)

		return {
			clientId,
			clientSecret: Redacted.value(clientSecretRedacted),
			scopes: env.GITHUB_OAUTH_SCOPES,
		}
	})

const toPersistenceError = (cause: unknown) =>
	new IntegrationsPersistenceError({
		message: cause instanceof Error ? cause.message : "GitHub integration database error",
	})

const toUpstreamError = (message: string, status?: number) =>
	new IntegrationsUpstreamError({ message, ...(status === undefined ? {} : { status }) })

export interface GitHubRepoSummary {
	readonly owner: string
	readonly name: string
	readonly fullName: string
	readonly private: boolean
}

export interface GitHubServiceRepoMapping {
	readonly serviceName: string
	readonly repoOwner: string
	readonly repoName: string
}

type GitHubConnectError =
	| IntegrationsValidationError
	| IntegrationsUpstreamError
	| IntegrationsPersistenceError

type GitHubApiError = GitHubConnectError | IntegrationsNotConnectedError | IntegrationsRevokedError

export interface GitHubOAuthServiceShape {
	readonly startConnect: (
		orgId: OrgId,
		userId: UserId,
		options: { readonly callbackUrl: string; readonly returnTo?: string },
	) => Effect.Effect<{ readonly redirectUrl: string; readonly state: string }, GitHubConnectError>
	readonly completeConnect: (
		code: string,
		state: string,
	) => Effect.Effect<{ readonly orgId: OrgId; readonly returnTo: string | null }, GitHubConnectError>
	readonly getStatus: (orgId: OrgId) => Effect.Effect<
		| { readonly connected: false }
		| {
				readonly connected: true
				readonly externalUserId: string
				readonly externalUserLogin: string | null
				readonly connectedByUserId: string
				readonly scope: string
		  },
		IntegrationsPersistenceError
	>
	readonly listRepos: (orgId: OrgId) => Effect.Effect<ReadonlyArray<GitHubRepoSummary>, GitHubApiError>
	readonly disconnect: (
		orgId: OrgId,
	) => Effect.Effect<{ readonly disconnected: boolean }, IntegrationsPersistenceError>
	readonly listServiceRepos: (
		orgId: OrgId,
	) => Effect.Effect<ReadonlyArray<GitHubServiceRepoMapping>, IntegrationsPersistenceError>
	readonly setServiceRepo: (
		orgId: OrgId,
		userId: UserId,
		mapping: GitHubServiceRepoMapping,
	) => Effect.Effect<GitHubServiceRepoMapping, IntegrationsPersistenceError>
	readonly deleteServiceRepo: (
		orgId: OrgId,
		serviceName: string,
	) => Effect.Effect<{ readonly deleted: boolean }, IntegrationsPersistenceError>
}

export class GitHubOAuthService extends Context.Service<GitHubOAuthService, GitHubOAuthServiceShape>()(
	"GitHubOAuthService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
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

			const dbExecute = <T>(fn: (db: DatabaseClient) => Promise<T>) =>
				database.execute(fn).pipe(Effect.mapError(toPersistenceError))

			const encryptValue = (plaintext: string) =>
				encryptAes256Gcm(
					plaintext,
					encryptionKey,
					(message) =>
						new IntegrationsPersistenceError({
							message: `Failed to encrypt GitHub token: ${message}`,
						}),
				)

			const decryptValue = (encrypted: { ciphertext: string; iv: string; tag: string }) =>
				decryptAes256Gcm(
					encrypted,
					encryptionKey,
					() =>
						new IntegrationsPersistenceError({
							message: "Failed to decrypt stored GitHub token",
						}),
				)

			const purgeExpiredStates = (currentTime: number) =>
				dbExecute((db) => db.delete(oauthAuthStates).where(lt(oauthAuthStates.expiresAt, currentTime)))

			const startConnect = Effect.fn("GitHubOAuthService.startConnect")(function* (
				orgId: OrgId,
				userId: UserId,
				options: { readonly callbackUrl: string; readonly returnTo?: string },
			) {
				const config = yield* resolveConfig(env)
				const state = randomBytes(24).toString("base64url")
				const currentTime = Date.now()

				yield* purgeExpiredStates(currentTime)
				yield* dbExecute((db) =>
					db.insert(oauthAuthStates).values({
						state,
						orgId,
						provider: GITHUB_PROVIDER,
						initiatedByUserId: userId,
						redirectUri: options.callbackUrl,
						returnTo: options.returnTo ?? null,
						createdAt: currentTime,
						expiresAt: currentTime + STATE_TTL_MS,
					}),
				)

				const params = new URLSearchParams({
					client_id: config.clientId,
					redirect_uri: options.callbackUrl,
					scope: config.scopes,
					state,
					allow_signup: "false",
				})
				return {
					redirectUrl: `${GITHUB_AUTHORIZE_URL}?${params.toString()}`,
					state,
				}
			})

			const requireStateRow = (state: string) =>
				Effect.gen(function* () {
					const rows = yield* dbExecute((db) =>
						db.select().from(oauthAuthStates).where(eq(oauthAuthStates.state, state)).limit(1),
					)
					const row = rows[0]
					if (!row) {
						return yield* Effect.fail(
							new IntegrationsValidationError({
								message: "OAuth state not recognized — restart the connect flow",
							}),
						)
					}
					if (row.expiresAt < Date.now()) {
						yield* dbExecute((db) =>
							db.delete(oauthAuthStates).where(eq(oauthAuthStates.state, state)),
						)
						return yield* Effect.fail(
							new IntegrationsValidationError({
								message: "OAuth state expired — restart the connect flow",
							}),
						)
					}
					return row satisfies OAuthAuthStateRow
				})

			const exchangeAuthorizationCode = (
				config: ResolvedGitHubOAuthConfig,
				code: string,
				redirectUri: string,
			) =>
				Effect.gen(function* () {
					const body = new URLSearchParams({
						grant_type: "authorization_code",
						code,
						redirect_uri: redirectUri,
						client_id: config.clientId,
						client_secret: config.clientSecret,
					})
					const response = yield* Effect.tryPromise({
						try: () =>
							fetch(GITHUB_TOKEN_URL, {
								method: "POST",
								headers: {
									"content-type": "application/x-www-form-urlencoded",
									accept: "application/json",
								},
								body: body.toString(),
							}),
						catch: (cause) =>
							toUpstreamError(
								cause instanceof Error
									? `Token exchange failed: ${cause.message}`
									: "Token exchange failed",
							),
					})
					if (!response.ok) {
						return yield* Effect.fail(
							toUpstreamError(`Token exchange failed with ${response.status}`, response.status),
						)
					}
					const json = yield* Effect.tryPromise({
						try: () => response.json(),
						catch: () => toUpstreamError("Token exchange returned a non-JSON response"),
					})
					const decoded = yield* decodeTokenResponse(json).pipe(
						Effect.mapError(() => toUpstreamError("Token exchange returned an unexpected payload")),
					)
					if (decoded.error || !decoded.access_token) {
						return yield* Effect.fail(
							new IntegrationsValidationError({
								message: decoded.error_description ?? decoded.error ?? "GitHub did not return an access token",
							}),
						)
					}
					return { accessToken: decoded.access_token, scope: decoded.scope ?? config.scopes }
				})

			const fetchUserInfo = (accessToken: string) =>
				Effect.gen(function* () {
					const response = yield* Effect.tryPromise({
						try: () =>
							fetch(GITHUB_USER_URL, {
								headers: {
									authorization: `Bearer ${accessToken}`,
									accept: "application/vnd.github+json",
									"user-agent": "maple-observability",
								},
							}),
						catch: (cause) =>
							toUpstreamError(
								cause instanceof Error
									? `GitHub user fetch failed: ${cause.message}`
									: "GitHub user fetch failed",
							),
					})
					if (!response.ok) {
						return yield* Effect.fail(
							toUpstreamError(`GitHub user fetch failed with ${response.status}`, response.status),
						)
					}
					const json = yield* Effect.tryPromise({
						try: () => response.json(),
						catch: () => toUpstreamError("GitHub user fetch returned a non-JSON response"),
					})
					return yield* decodeUserInfo(json).pipe(
						Effect.mapError(() => toUpstreamError("GitHub user fetch returned an unexpected payload")),
					)
				})

			const completeConnect = Effect.fn("GitHubOAuthService.completeConnect")(function* (
				code: string,
				state: string,
			) {
				const config = yield* resolveConfig(env)
				const stateRow = yield* requireStateRow(state)
				yield* dbExecute((db) => db.delete(oauthAuthStates).where(eq(oauthAuthStates.state, state)))

				const token = yield* exchangeAuthorizationCode(config, code, stateRow.redirectUri)
				const userInfo = yield* fetchUserInfo(token.accessToken)

				const accessEnc = yield* encryptValue(token.accessToken)
				const currentTime = Date.now()
				const orgId = stateRow.orgId as OrgId
				const externalUserId = String(userInfo.id)

				const existing = yield* dbExecute((db) =>
					db
						.select()
						.from(oauthConnections)
						.where(
							and(
								eq(oauthConnections.orgId, orgId),
								eq(oauthConnections.provider, GITHUB_PROVIDER),
							),
						)
						.limit(1),
				)

				if (existing[0]) {
					yield* dbExecute((db) =>
						db
							.update(oauthConnections)
							.set({
								externalUserId,
								externalUserEmail: null,
								externalUserLabel: userInfo.login,
								connectedByUserId: stateRow.initiatedByUserId,
								scope: token.scope,
								accessTokenCiphertext: accessEnc.ciphertext,
								accessTokenIv: accessEnc.iv,
								accessTokenTag: accessEnc.tag,
								refreshTokenCiphertext: null,
								refreshTokenIv: null,
								refreshTokenTag: null,
								expiresAt: null,
								updatedAt: currentTime,
							})
							.where(eq(oauthConnections.id, existing[0]!.id)),
					)
				} else {
					yield* dbExecute((db) =>
						db.insert(oauthConnections).values({
							id: randomUUID(),
							orgId,
							provider: GITHUB_PROVIDER,
							externalUserId,
							externalUserEmail: null,
							externalUserLabel: userInfo.login,
							connectedByUserId: stateRow.initiatedByUserId,
							scope: token.scope,
							accessTokenCiphertext: accessEnc.ciphertext,
							accessTokenIv: accessEnc.iv,
							accessTokenTag: accessEnc.tag,
							refreshTokenCiphertext: null,
							refreshTokenIv: null,
							refreshTokenTag: null,
							expiresAt: null,
							createdAt: currentTime,
							updatedAt: currentTime,
						}),
					)
				}

				return { orgId, returnTo: stateRow.returnTo ?? null }
			})

			const loadConnection = (orgId: OrgId) =>
				dbExecute((db) =>
					db
						.select()
						.from(oauthConnections)
						.where(
							and(
								eq(oauthConnections.orgId, orgId),
								eq(oauthConnections.provider, GITHUB_PROVIDER),
							),
						)
						.limit(1),
				).pipe(Effect.map((rows) => rows[0] ?? null))

			const requireConnection = (orgId: OrgId) =>
				Effect.gen(function* () {
					const row = yield* loadConnection(orgId)
					if (!row) {
						return yield* Effect.fail(
							new IntegrationsNotConnectedError({
								message: "GitHub is not connected for this organization",
							}),
						)
					}
					return row satisfies OAuthConnectionRow
				})

			const getValidAccessToken = (orgId: OrgId) =>
				Effect.gen(function* () {
					const row = yield* requireConnection(orgId)
					const isValid = row.expiresAt == null || row.expiresAt - Date.now() > REFRESH_LEEWAY_MS
					if (!isValid) {
						return yield* Effect.fail(
							new IntegrationsRevokedError({
								message: "GitHub access token expired — reconnect required",
							}),
						)
					}
					return yield* decryptValue({
						ciphertext: row.accessTokenCiphertext,
						iv: row.accessTokenIv,
						tag: row.accessTokenTag,
					})
				})

			const getStatus = Effect.fn("GitHubOAuthService.getStatus")(function* (orgId: OrgId) {
				const row = yield* loadConnection(orgId)
				if (!row) {
					return { connected: false } as const
				}
				return {
					connected: true,
					externalUserId: row.externalUserId,
					externalUserLogin: row.externalUserLabel,
					connectedByUserId: row.connectedByUserId,
					scope: row.scope,
				} as const
			})

			const parseNextPage = (linkHeader: string | null): boolean => {
				if (!linkHeader) return false
				return linkHeader.split(",").some((part) => /rel="next"/.test(part))
			}

			const listRepos = Effect.fn("GitHubOAuthService.listRepos")(function* (orgId: OrgId) {
				const accessToken = yield* getValidAccessToken(orgId)
				const collected: Array<GitHubRepoSummary> = []
				let page = 1
				while (page <= REPO_PAGE_LIMIT) {
					const params = new URLSearchParams({
						per_page: "100",
						page: String(page),
						sort: "full_name",
						affiliation: "owner,collaborator,organization_member",
					})
					const response = yield* Effect.tryPromise({
						try: () =>
							fetch(`${GITHUB_REPOS_URL}?${params.toString()}`, {
								headers: {
									authorization: `Bearer ${accessToken}`,
									accept: "application/vnd.github+json",
									"user-agent": "maple-observability",
								},
							}),
						catch: (cause) =>
							toUpstreamError(
								cause instanceof Error
									? `GitHub repos request failed: ${cause.message}`
									: "GitHub repos request failed",
							),
					})
					if (response.status === 401) {
						return yield* Effect.fail(
							new IntegrationsRevokedError({
								message: "GitHub rejected the access token — reconnect required",
							}),
						)
					}
					if (!response.ok) {
						return yield* Effect.fail(
							toUpstreamError(`GitHub repos returned ${response.status}`, response.status),
						)
					}
					const json = yield* Effect.tryPromise({
						try: () => response.json(),
						catch: () => toUpstreamError("GitHub repos returned a non-JSON response"),
					})
					const decoded = yield* decodeReposResponse(json).pipe(
						Effect.mapError(() => toUpstreamError("GitHub repos returned an unexpected payload")),
					)
					for (const repo of decoded) {
						collected.push({
							owner: repo.owner.login,
							name: repo.name,
							fullName: repo.full_name,
							private: repo.private,
						})
					}
					if (!parseNextPage(response.headers.get("link"))) break
					page += 1
				}
				return collected
			})

			const disconnect = Effect.fn("GitHubOAuthService.disconnect")(function* (orgId: OrgId) {
				const result = yield* dbExecute((db) =>
					db
						.delete(oauthConnections)
						.where(
							and(
								eq(oauthConnections.orgId, orgId),
								eq(oauthConnections.provider, GITHUB_PROVIDER),
							),
						),
				)
				return { disconnected: (result.rowsAffected ?? 0) > 0 }
			})

			const listServiceRepos = Effect.fn("GitHubOAuthService.listServiceRepos")(function* (
				orgId: OrgId,
			) {
				const rows = yield* dbExecute((db) =>
					db.select().from(githubServiceRepos).where(eq(githubServiceRepos.orgId, orgId)),
				)
				return rows.map((row) => ({
					serviceName: row.serviceName,
					repoOwner: row.repoOwner,
					repoName: row.repoName,
				}))
			})

			const setServiceRepo = Effect.fn("GitHubOAuthService.setServiceRepo")(function* (
				orgId: OrgId,
				userId: UserId,
				mapping: GitHubServiceRepoMapping,
			) {
				const currentTime = Date.now()
				const existing = yield* dbExecute((db) =>
					db
						.select()
						.from(githubServiceRepos)
						.where(
							and(
								eq(githubServiceRepos.orgId, orgId),
								eq(githubServiceRepos.serviceName, mapping.serviceName),
							),
						)
						.limit(1),
				)
				if (existing[0]) {
					yield* dbExecute((db) =>
						db
							.update(githubServiceRepos)
							.set({
								repoOwner: mapping.repoOwner,
								repoName: mapping.repoName,
								updatedAt: currentTime,
							})
							.where(eq(githubServiceRepos.id, existing[0]!.id)),
					)
				} else {
					yield* dbExecute((db) =>
						db.insert(githubServiceRepos).values({
							id: randomUUID(),
							orgId,
							serviceName: mapping.serviceName,
							repoOwner: mapping.repoOwner,
							repoName: mapping.repoName,
							createdByUserId: userId,
							createdAt: currentTime,
							updatedAt: currentTime,
						}),
					)
				}
				return mapping
			})

			const deleteServiceRepo = Effect.fn("GitHubOAuthService.deleteServiceRepo")(function* (
				orgId: OrgId,
				serviceName: string,
			) {
				const result = yield* dbExecute((db) =>
					db
						.delete(githubServiceRepos)
						.where(
							and(
								eq(githubServiceRepos.orgId, orgId),
								eq(githubServiceRepos.serviceName, serviceName),
							),
						),
				)
				return { deleted: (result.rowsAffected ?? 0) > 0 }
			})

			return {
				startConnect,
				completeConnect,
				getStatus,
				listRepos,
				disconnect,
				listServiceRepos,
				setServiceRepo,
				deleteServiceRepo,
			} satisfies GitHubOAuthServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
	static readonly Live = this.layer
	static readonly Default = this.layer
}
