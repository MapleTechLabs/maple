import {
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsRevokedError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	LinearFeatureSwitches,
	type LinearFeatureSettingsRequest,
	OrgId,
	type UserId,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { LinearFeatureSettings } from "@maple/db/tables"
import {
	Clock,
	Context,
	Effect,
	Layer,
	Option,
	Redacted,
	Schema,
	String as Str,
	Array as Arr,
	Record as Rec,
} from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Env, type EnvConfig } from "@maple/backend/platform/Env"
import { LinearOAuthClientSecret } from "@maple/infra/secrets"
import { Database } from "@maple/backend/platform/DatabaseLive"
import {
	isNotFound,
	linearData,
	linearGraphql,
} from "@maple/backend/services/integrations/linear/LinearGraphql"
import { makeOAuthConnectionHelpers, type OAuthTokenEndpointConfig } from "./oauth/connection-helpers"
import type { OAuthFlowInitiator } from "./oauth/oauth-state"
import { newOAuthState } from "./oauth/oauth-state"

const LINEAR_PROVIDER = "linear"
const AUTHORIZE_URL = "https://linear.app/oauth/authorize"
const TOKEN_URL = "https://api.linear.app/oauth/token"
const REVOKE_URL = "https://api.linear.app/oauth/revoke"
/** `write` covers reopening an issue and attaching the incident link; `read` lists teams. */
const SCOPES = "read,write"

const decodeOrgId = Schema.decodeUnknownSync(OrgId)

/** Every feature on: an org that never changed a switch. */
const switchesOf = (row: PG.SelectRowOf<typeof LinearFeatureSettings>) =>
	new LinearFeatureSwitches({
		openIssuesEnabled: row.openIssuesEnabled,
		updateCommentsEnabled: row.updateCommentsEnabled,
		reopenIssuesEnabled: row.reopenIssuesEnabled,
		resolveCommentsEnabled: row.resolveCommentsEnabled,
	})

export const ALL_LINEAR_FEATURES = new LinearFeatureSwitches({
	openIssuesEnabled: true,
	updateCommentsEnabled: true,
	reopenIssuesEnabled: true,
	resolveCommentsEnabled: true,
})

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
	configuredSecret: Option.Option<Redacted.Redacted>,
): Effect.Effect<
	OAuthTokenEndpointConfig & { readonly clientSecret: Redacted.Redacted },
	IntegrationsValidationError
> =>
	Option.match(Option.all({ clientId: env.LINEAR_OAUTH_CLIENT_ID, clientSecret: configuredSecret }), {
		onNone: () =>
			Effect.fail(
				new IntegrationsValidationError({
					message:
						"LINEAR_OAUTH_CLIENT_ID and LINEAR_OAUTH_CLIENT_SECRET are required to use Linear",
				}),
			),
		onSome: ({ clientId, clientSecret }) =>
			Effect.succeed({ tokenUrl: TOKEN_URL, clientId, clientSecret }),
	})

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
				readonly features: LinearFeatureSwitches
		  },
		IntegrationsPersistenceError
	>
	/** The org's switches; every feature is on until someone changes one. */
	readonly getFeatures: (orgId: OrgId) => Effect.Effect<LinearFeatureSwitches, IntegrationsPersistenceError>
	/** Saves the switches the update names; the others keep their value. */
	readonly setFeatures: (
		orgId: OrgId,
		userId: UserId,
		update: LinearFeatureSettingsRequest,
	) => Effect.Effect<LinearFeatureSwitches, IntegrationsPersistenceError>
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
	readonly disconnect: (orgId: OrgId) => Effect.Effect<
		{
			readonly disconnected: boolean
			/** False when a stored grant was not revoked at the vendor; the local grant is dropped anyway. */
			readonly grantRevoked: boolean
		},
		IntegrationsPersistenceError
	>
}

export class LinearOAuthService extends Context.Service<LinearOAuthService, LinearOAuthServiceApi>()(
	"@maple/backend/services/LinearOAuthService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const clientSecret = yield* LinearOAuthClientSecret
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
				const config = yield* resolveConfig(env, clientSecret)
				const state = yield* newOAuthState
				yield* oauth.saveState(
					state,
					{ orgId, userId },
					{ redirectUri: options.callbackUrl, returnTo: options.returnTo ?? null },
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
				const config = yield* resolveConfig(env, clientSecret)
				const stateRow = yield* oauth.consumeStateRow(state, initiator)
				const tokens = yield* oauth.exchangeAuthorizationCode(config, code, stateRow.redirectUri)
				const viewer = yield* linearGraphql(
					httpClient,
					tokens.access_token,
					"MapleConnectedWorkspace",
					"query MapleConnectedWorkspace { organization { id name } }",
				).pipe(Effect.flatMap(linearData(ViewerSchema, "workspace lookup")))

				const orgId = decodeOrgId(stateRow.orgId)
				const accessEnc = yield* oauth.sealAccessToken(orgId, tokens.access_token)
				const refreshEnc = tokens.refresh_token
					? yield* oauth.sealRefreshToken(orgId, tokens.refresh_token)
					: null
				const currentTime = yield* Clock.currentTimeMillis

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

			const getFeatures = Effect.fn("LinearOAuthService.getFeatures")(function* (orgId: OrgId) {
				const rows = yield* oauth.dbExecute((db) =>
					db.run(
						PG.from(LinearFeatureSettings)
							.select()
							.where(($) => [$.orgId.eq(orgId)])
							.limit(1),
					),
				)
				const row = rows[0]
				return row === undefined ? ALL_LINEAR_FEATURES : switchesOf(row)
			})

			const setFeatures = Effect.fn("LinearOAuthService.setFeatures")(function* (
				orgId: OrgId,
				userId: UserId,
				update: LinearFeatureSettingsRequest,
			) {
				yield* Effect.annotateCurrentSpan({ orgId })
				// Only the switches sent: a concurrent save of another one keeps its value.
				const set = {
					...(update.openIssuesEnabled !== undefined && {
						openIssuesEnabled: update.openIssuesEnabled,
					}),
					...(update.updateCommentsEnabled !== undefined && {
						updateCommentsEnabled: update.updateCommentsEnabled,
					}),
					...(update.reopenIssuesEnabled !== undefined && {
						reopenIssuesEnabled: update.reopenIssuesEnabled,
					}),
					...(update.resolveCommentsEnabled !== undefined && {
						resolveCommentsEnabled: update.resolveCommentsEnabled,
					}),
				}
				if (Rec.isEmptyRecord<string, unknown>(set)) return yield* getFeatures(orgId)
				const now = yield* Clock.currentTimeMillis
				const rows = yield* oauth.dbExecute((db) =>
					db.run(
						PG.insertInto(LinearFeatureSettings)
							.values({
								orgId,
								...ALL_LINEAR_FEATURES,
								...set,
								createdAt: now,
								updatedAt: now,
								updatedBy: userId,
							})
							.onConflictDoUpdate({
								target: ["orgId"],
								set: () => ({ ...set, updatedAt: now, updatedBy: userId }),
							})
							.returning(),
					),
				)
				const row = rows[0]
				return row === undefined ? yield* getFeatures(orgId) : switchesOf(row)
			})

			const getStatus = Effect.fn("LinearOAuthService.getStatus")(function* (orgId: OrgId) {
				const row = yield* oauth.loadConnection(orgId)
				if (row === null) return { connected: false } as const
				return {
					connected: true,
					workspaceName: row.externalAccountName,
					connectedByUserId: row.connectedByUserId,
					revoked: row.revokedAt !== null,
					features: yield* getFeatures(orgId),
				} as const
			})

			const withAccessToken = <A, E>(
				orgId: OrgId,
				use: (accessToken: string) => Effect.Effect<A, E | IntegrationsRevokedError>,
			): Effect.Effect<A, E | LinearAccessError> =>
				Effect.gen(function* () {
					const config = yield* resolveConfig(env, clientSecret)
					return yield* oauth.withRejectedTokenRetry(
						config,
						orgId,
						(error: E | IntegrationsRevokedError): error is IntegrationsRevokedError =>
							Schema.is(IntegrationsRevokedError)(error),
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
				return Arr.sortWith(
					teams.teams.nodes,
					(team) => team.name,
					(self: string, that: string) => Str.localeCompare(that)(self),
				)
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
				// A team the app cannot see answers FORBIDDEN; to the picker it does not exist either.
				if (Arr.some(result.errors, (error) => isNotFound(error) || error.code === "FORBIDDEN"))
					return null
				return (yield* linearData(TeamSchema, "team lookup")(result)).team
			})

			/**
			 * Revokes the stored refresh and access tokens at Linear and answers whether Linear took it.
			 * Best effort: a failure is logged, and the grant is dropped on Maple's side either way.
			 */
			const revokeAtLinear = Effect.fn("LinearOAuthService.revokeAtLinear")(
				(orgId: OrgId) =>
					oauth
						.revokeStoredTokens(orgId, (token, kind) =>
							oauth.postForm(REVOKE_URL, { token, token_type_hint: kind }),
						)
						.pipe(Effect.as(true)),
				(effect, orgId) =>
					Effect.catch(effect, (error) =>
						Effect.logWarning("Linear grant revoke failed; dropping the local grant anyway", {
							orgId,
							error: error.message,
						}).pipe(Effect.as(false)),
					),
			)

			const disconnect = Effect.fn("LinearOAuthService.disconnect")(function* (orgId: OrgId) {
				const grantRevoked = yield* revokeAtLinear(orgId)
				yield* Effect.annotateCurrentSpan({ orgId, "maple.linear.revoked_upstream": grantRevoked })
				const deleted = yield* oauth.deleteConnection(orgId)
				return { ...deleted, grantRevoked }
			})

			return {
				startConnect,
				completeConnect,
				getStatus,
				getFeatures,
				setFeatures,
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
