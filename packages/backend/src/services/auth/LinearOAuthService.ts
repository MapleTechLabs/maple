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
import * as PG from "@maple-dev/effect-orm/postgres"
import { OAuthAuthStates } from "@maple/db/tables"
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Env, type EnvConfig } from "@maple/backend/platform/Env"
import { Database } from "@maple/backend/platform/DatabaseLive"
import {
	isNotFound,
	linearData,
	linearGraphql,
} from "@maple/backend/services/integrations/linear/LinearGraphql"
import {
	makeOAuthConnectionHelpers,
	OAUTH_STATE_TTL_MS,
	type OAuthTokenEndpointConfig,
} from "./oauth/connection-helpers"
import type { OAuthFlowInitiator } from "./oauth/oauth-state"

const LINEAR_PROVIDER = "linear"
const AUTHORIZE_URL = "https://linear.app/oauth/authorize"
const TOKEN_URL = "https://api.linear.app/oauth/token"
const REVOKE_URL = "https://api.linear.app/oauth/revoke"
/** `write` covers reopening an issue and attaching the incident link; `read` lists teams. */
const SCOPES = "read,write"

const decodeOrgId = Schema.decodeUnknownSync(OrgId)

const ViewerSchema = Schema.Struct({
	organization: Schema.Struct({ id: Schema.String, name: Schema.String }),
})

const TeamSchema = Schema.Struct({
	team: Schema.Struct({ id: Schema.String, key: Schema.String, name: Schema.String }),
})

const TeamsSchema = Schema.Struct({
	teams: Schema.Struct({
		nodes: Schema.Array(Schema.Struct({ id: Schema.String, key: Schema.String, name: Schema.String })),
	}),
})

const resolveConfig = (
	env: EnvConfig,
): Effect.Effect<
	OAuthTokenEndpointConfig & { readonly clientSecret: Redacted.Redacted<string> },
	IntegrationsValidationError
> =>
	Option.match(
		Option.all({ clientId: env.LINEAR_OAUTH_CLIENT_ID, clientSecret: env.LINEAR_OAUTH_CLIENT_SECRET }),
		{
			onNone: () =>
				Effect.fail(
					new IntegrationsValidationError({
						message:
							"LINEAR_OAUTH_CLIENT_ID and LINEAR_OAUTH_CLIENT_SECRET are required to use Linear",
					}),
				),
			onSome: ({ clientId, clientSecret }) =>
				Effect.succeed({ tokenUrl: TOKEN_URL, clientId, clientSecret }),
		},
	)

export interface LinearTeam {
	readonly id: string
	readonly key: string
	readonly name: string
}

type LinearAccessError =
	| IntegrationsNotConnectedError
	| IntegrationsRevokedError
	| IntegrationsUpstreamError
	| IntegrationsPersistenceError
	| IntegrationsValidationError

export interface LinearOAuthServiceApi {
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
		initiator: OAuthFlowInitiator,
	) => Effect.Effect<
		{ readonly orgId: OrgId; readonly returnTo: string | null },
		| IntegrationsValidationError
		| IntegrationsUpstreamError
		| IntegrationsRevokedError
		| IntegrationsPersistenceError
	>
	readonly getStatus: (orgId: OrgId) => Effect.Effect<
		| { readonly connected: false }
		| {
				readonly connected: true
				readonly workspaceName: string | null
				readonly connectedByUserId: UserId
				readonly revoked: boolean
		  },
		IntegrationsPersistenceError
	>
	/**
	 * Run `use` with the org's Linear token. A token Linear rejects is refreshed
	 * once and retried; a rejected fresh token marks the connection revoked.
	 */
	readonly withAccessToken: <A, E>(
		orgId: OrgId,
		use: (accessToken: string) => Effect.Effect<A, E | IntegrationsRevokedError>,
	) => Effect.Effect<A, E | LinearAccessError>
	readonly listTeams: (orgId: OrgId) => Effect.Effect<ReadonlyArray<LinearTeam>, LinearAccessError>
	/** One team by id, or null when the workspace has no such team the app can see. */
	readonly getTeam: (orgId: OrgId, teamId: string) => Effect.Effect<LinearTeam | null, LinearAccessError>
	readonly disconnect: (
		orgId: OrgId,
	) => Effect.Effect<{ readonly disconnected: boolean }, IntegrationsPersistenceError>
}

export class LinearOAuthService extends Context.Service<LinearOAuthService, LinearOAuthServiceApi>()(
	"@maple/backend/services/LinearOAuthService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const httpClient = yield* HttpClient.HttpClient
			const oauth = yield* makeOAuthConnectionHelpers({
				provider: LINEAR_PROVIDER,
				providerLabel: "Linear",
				database,
				env,
			})

			const startConnect = Effect.fn("LinearOAuthService.startConnect")(function* (
				orgId: OrgId,
				userId: UserId,
				options: { readonly callbackUrl: string; readonly returnTo?: string },
			) {
				const config = yield* resolveConfig(env)
				const state = randomBytes(24).toString("base64url")
				const currentTime = yield* Clock.currentTimeMillis

				yield* oauth.purgeExpiredStates(currentTime)
				yield* oauth.dbExecute((db) =>
					db.run(
						PG.insertInto(OAuthAuthStates).values({
							state,
							orgId,
							provider: LINEAR_PROVIDER,
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
					// Issues and comments are authored by the Maple app, not the person who connected it.
					actor: "app",
				})
				return { redirectUrl: `${AUTHORIZE_URL}?${params.toString()}`, state }
			})

			const completeConnect = Effect.fn("LinearOAuthService.completeConnect")(function* (
				code: string,
				state: string,
				initiator: OAuthFlowInitiator,
			) {
				const config = yield* resolveConfig(env)
				const stateRow = yield* oauth.consumeStateRow(state, initiator)
				const tokens = yield* oauth.exchangeAuthorizationCode(config, code, stateRow.redirectUri)
				const viewer = yield* linearGraphql(
					httpClient,
					tokens.access_token,
					"MapleConnectedWorkspace",
					"query MapleConnectedWorkspace { organization { id name } }",
				).pipe(Effect.flatMap(linearData(ViewerSchema, "workspace lookup")))

				const accessEnc = yield* oauth.encryptValue(tokens.access_token)
				const refreshEnc = tokens.refresh_token
					? yield* oauth.encryptValue(tokens.refresh_token)
					: null
				const currentTime = yield* Clock.currentTimeMillis
				const orgId = decodeOrgId(stateRow.orgId)

				// An app-actor grant belongs to the workspace, so the workspace is the principal.
				yield* oauth.upsertConnection(orgId, currentTime, {
					externalUserId: viewer.organization.id,
					externalUserEmail: null,
					externalAccountName: viewer.organization.name,
					connectedByUserId: stateRow.initiatedByUserId,
					scope: tokens.scope ?? SCOPES,
					accessTokenCiphertext: accessEnc.ciphertext,
					accessTokenIv: accessEnc.iv,
					accessTokenTag: accessEnc.tag,
					refreshTokenCiphertext: refreshEnc?.ciphertext ?? null,
					refreshTokenIv: refreshEnc?.iv ?? null,
					refreshTokenTag: refreshEnc?.tag ?? null,
					expiresAt: tokens.expires_in != null ? currentTime + tokens.expires_in * 1000 : null,
				})
				return { orgId, returnTo: stateRow.returnTo ?? null }
			})

			const getStatus = Effect.fn("LinearOAuthService.getStatus")(function* (orgId: OrgId) {
				const row = yield* oauth.loadConnection(orgId)
				if (row === null) return { connected: false } as const
				return {
					connected: true,
					workspaceName: row.externalAccountName,
					connectedByUserId: row.connectedByUserId,
					revoked: row.revokedAt !== null,
				} as const
			})

			const withAccessToken = <A, E>(
				orgId: OrgId,
				use: (accessToken: string) => Effect.Effect<A, E | IntegrationsRevokedError>,
			): Effect.Effect<A, E | LinearAccessError> =>
				Effect.gen(function* () {
					const config = yield* resolveConfig(env)
					return yield* oauth.withRejectedTokenRetry(
						config,
						orgId,
						(error: E | IntegrationsRevokedError): error is IntegrationsRevokedError =>
							error instanceof IntegrationsRevokedError,
						use,
					)
				})

			const listTeams = Effect.fn("LinearOAuthService.listTeams")(function* (orgId: OrgId) {
				const result = yield* withAccessToken(orgId, (accessToken) =>
					linearGraphql(
						httpClient,
						accessToken,
						"MapleTeams",
						"query MapleTeams { teams(first: 250) { nodes { id key name } } }",
					),
				)
				const teams = yield* linearData(TeamsSchema, "team list")(result)
				return teams.teams.nodes.toSorted((a, b) => a.name.localeCompare(b.name))
			})

			const getTeam = Effect.fn("LinearOAuthService.getTeam")(function* (orgId: OrgId, teamId: string) {
				const result = yield* withAccessToken(orgId, (accessToken) =>
					linearGraphql(
						httpClient,
						accessToken,
						"MapleTeamLookup",
						"query MapleTeamLookup($id: String!) { team(id: $id) { id key name } }",
						{ id: teamId },
					),
				)
				if (result.errors.some(isNotFound)) return null
				return (yield* linearData(TeamSchema, "team lookup")(result)).team
			})

			/** Best effort: the grant is dropped on Maple's side whatever Linear answers. */
			const revokeAtLinear = (orgId: OrgId) =>
				Effect.gen(function* () {
					const row = yield* oauth.loadConnection(orgId)
					if (row === null) return
					const accessToken = yield* oauth.decryptValue({
						ciphertext: row.accessTokenCiphertext,
						iv: row.accessTokenIv,
						tag: row.accessTokenTag,
					})
					yield* oauth.postForm(REVOKE_URL, { token: accessToken, token_type_hint: "access_token" })
				}).pipe(Effect.ignore, Effect.withSpan("LinearOAuthService.revokeAtLinear"))

			const disconnect = Effect.fn("LinearOAuthService.disconnect")(function* (orgId: OrgId) {
				yield* revokeAtLinear(orgId)
				return yield* oauth.deleteConnection(orgId)
			})

			return {
				startConnect,
				completeConnect,
				getStatus,
				withAccessToken,
				listTeams,
				getTeam,
				disconnect,
			} satisfies LinearOAuthServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
