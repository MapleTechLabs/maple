import { randomUUID } from "node:crypto"
import {
	ChatConnectorId,
	ChatIdentityId,
	ChatWorkspaceId,
	IntegrationsConfigurationError,
	IntegrationsForbiddenError,
	IntegrationsNotConnectedError,
	IntegrationsNotFoundError,
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	OrgId,
	UserId,
	type OAuthStatePersistenceError,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { ChatWorkspaces, type ChatWorkspaceRow } from "@maple/db/tables"
import {
	isConnectorConfigured,
	type ChatConnector,
	type ChatDestination,
	type ChatWorkspaceSettings,
} from "@maple/chat-platform"
import {
	Array as Arr,
	Clock,
	Context,
	Duration,
	Effect,
	Layer,
	Option,
	Schema,
	Record as Rec,
	String as Str,
} from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database, type DatabaseError } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { secretKeyringFromEnv } from "@maple/backend/platform/SecretBox"
import {
	openChatWorkspaceCredentials,
	sealChatWorkspaceCredentials,
	storedCredentials,
} from "@maple/backend/services/integrations/chat-workspace-credentials"
import { OAuthStateRepository } from "@maple/backend/services/auth/OAuthStateRepository"
import type { OAuthFlowInitiator } from "@maple/backend/services/auth/oauth/oauth-state"
import {
	linkChatIdentity,
	listChatIdentities,
	unlinkChatIdentity,
	type ChatIdentityLink,
} from "@maple/backend/services/integrations/chat-identity-rows"
import {
	resolveChatWorkspace,
	type ChatWorkspaceResolution,
} from "@maple/backend/services/integrations/chat-workspace-rows"
import { chatAppRevokeDecision } from "@maple/backend/services/integrations/chat-app-ownership"
import {
	chatConnectorCredentials,
	ChatConnectorRegistry,
	chatOutboundTransport,
	loadOwnedChatWorkspace,
	missingOutboundConfig,
} from "@maple/backend/services/integrations/chat-outbound"
import { newOAuthState } from "@maple/backend/services/auth/oauth/oauth-state"

export { ChatConnectorRegistry }
export type { ChatIdentityLink, ChatWorkspaceResolution }

/**
 * Linking chat workspaces to orgs, for every chat platform Maple ships.
 *
 * The service knows connectors only through the registry: it hands a connector
 * the config the host resolved, takes back a workspace identity the connector
 * vouched for, and stores it in one generic table. Nothing here is per-platform,
 * and a platform that needs something this contract has no room for belongs in
 * the contract, not in a branch.
 */

/** `oauth_auth_states.provider` for a chat install, namespaced per connector. */
const stateProvider = (connector: ChatConnectorId): string => `chat:${connector}`

/**
 * `oauth_auth_states.provider` for linking one person's chat account — its own namespace.
 *
 * Separate from the install's so neither half can redeem the other's state: an install state
 * carries an admin's intent to link a workspace, and one that crossed would let an authorize
 * redirect finish work nobody started.
 */
const identityStateProvider = (connector: ChatConnectorId): string => `chat_identity:${connector}`

/** Public callback path a connector's platform redirects to (mounted in http-graph.ts). */
export const chatCallbackPath = (connector: ChatConnectorId): string => `/oauth/chat/${connector}/callback`

/** The identity half's own public callback path (mounted in http-graph.ts). */
export const chatIdentityCallbackPath = (connector: ChatConnectorId): string =>
	`/oauth/chat/${connector}/identity/callback`

const CROSS_ORG_CONFLICT_MESSAGE =
	"This chat workspace is already linked to a different Maple organization. Unlink it there first."

/** How long a platform may take to end a grant before the unlink goes on without it. */
const REVOKE_TIMEOUT = Duration.seconds(10)

/** Workspaces of one org unlinked at a time when the org itself is going. */
const UNINSTALL_CONCURRENCY = 4

/**
 * What the platform's side of an unlink came to. `unsupported` is a connector with no revoke;
 * `skipped` is a deployment that does not own its chat app (`chat-app-ownership.ts`).
 */
export type ChatRevokeOutcome = "revoked" | "unsupported" | "skipped" | "failed" | "timed_out"

/** What unlinking every workspace of an org came to. */
export interface ChatUninstallAllResult {
	/** Links dropped. */
	readonly uninstalled: number
	/** Workspaces whose grant the platform did not end: it refused, or never answered. */
	readonly revokeFailures: number
	/** Links that could not be dropped. */
	readonly unlinkFailures: number
}

/** The row id is a UUID we mint, so the brand is a decode that cannot fail. */
const newWorkspaceId = () => Schema.decodeSync(ChatWorkspaceId)(randomUUID())

/** Same for the identity row. */
const newChatIdentityId = () => Schema.decodeSync(ChatIdentityId)(randomUUID())

const decodeOrgId = Schema.decodeUnknownEffect(OrgId)
const decodeUserId = Schema.decodeUnknownEffect(UserId)

export interface ChatWorkspaceSummary {
	readonly id: ChatWorkspaceId
	readonly connector: ChatConnectorId
	readonly externalWorkspaceId: string
	readonly name: string
	readonly settings: ChatWorkspaceSettings
	readonly features: ChatWorkspaceFeatures
	readonly createdAt: number
}

/** The workspace's switches, one per feature of `INTEGRATION_FEATURES.chat`; all on when linked. */
export interface ChatWorkspaceFeatures {
	readonly alertsEnabled: boolean
	readonly directMessagesEnabled: boolean
	readonly assistantEnabled: boolean
}

/** A workspace edit: the settings when sent, and only the switches it names. */
export interface ChatWorkspaceUpdate {
	readonly settings?: ChatWorkspaceSettings
	readonly features?: Partial<ChatWorkspaceFeatures>
}

/** One connector as the dashboard sees it: is it usable here, and what is linked. */
export interface ChatConnectorStatus {
	readonly connector: ChatConnector<unknown>
	readonly available: boolean
	readonly workspaces: ReadonlyArray<ChatWorkspaceSummary>
	/** Whether this connector can prove who clicked, and so offer per-person links at all. */
	readonly supportsIdentity: boolean
	/** The caller's own chat account here — only when `list` was told who is asking. */
	readonly identity?: ChatIdentityLink | undefined
}

export interface ChatWorkspaceServiceApi {
	/**
	 * Every registered connector, with this org's linked workspaces.
	 *
	 * Given a `userId` the result also carries that user's own chat-account link per connector,
	 * so the dashboard's card renders the org's install and the caller's own link in one read.
	 */
	readonly list: (
		orgId: OrgId,
		userId?: UserId,
	) => Effect.Effect<ReadonlyArray<ChatConnectorStatus>, IntegrationsPersistenceError>
	readonly beginInstall: (
		orgId: OrgId,
		userId: UserId,
		connectorId: ChatConnectorId,
		callbackUrl: string,
	) => Effect.Effect<
		{ readonly url: string },
		IntegrationsNotFoundError | IntegrationsConfigurationError | IntegrationsPersistenceError
	>
	readonly completeInstall: (
		connectorId: ChatConnectorId,
		params: URLSearchParams,
		/** The signed-in Maple user finishing the flow; must be the one who started it. */
		initiator: OAuthFlowInitiator,
	) => Effect.Effect<
		{ readonly orgId: OrgId; readonly name: string },
		| IntegrationsNotFoundError
		| IntegrationsValidationError
		| IntegrationsConfigurationError
		| IntegrationsForbiddenError
		| IntegrationsUpstreamError
		| IntegrationsPersistenceError
	>
	/** Begin linking the caller's own chat account to their Maple user. */
	readonly beginLink: (
		orgId: OrgId,
		userId: UserId,
		connectorId: ChatConnectorId,
		callbackUrl: string,
	) => Effect.Effect<
		{ readonly url: string },
		IntegrationsNotFoundError | IntegrationsConfigurationError | IntegrationsPersistenceError
	>
	readonly completeLink: (
		connectorId: ChatConnectorId,
		params: URLSearchParams,
		/** The signed-in Maple user finishing the flow; must be the one who started it. */
		initiator: OAuthFlowInitiator,
	) => Effect.Effect<
		{ readonly orgId: OrgId; readonly displayName?: string | undefined },
		| IntegrationsNotFoundError
		| IntegrationsValidationError
		| IntegrationsConfigurationError
		| IntegrationsUpstreamError
		| IntegrationsPersistenceError
	>
	/** Drop the caller's own link for a connector; `unlinked` is false when there was none. */
	readonly unlink: (
		orgId: OrgId,
		userId: UserId,
		connectorId: ChatConnectorId,
	) => Effect.Effect<
		{ readonly unlinked: boolean },
		IntegrationsNotFoundError | IntegrationsPersistenceError
	>
	/**
	 * Saves the settings and the switches the update names in one statement; the rest keep their
	 * value, and an empty update is a read.
	 */
	readonly updateWorkspace: (
		orgId: OrgId,
		workspaceId: ChatWorkspaceId,
		update: ChatWorkspaceUpdate,
	) => Effect.Effect<
		ChatWorkspaceSummary,
		IntegrationsNotFoundError | IntegrationsValidationError | IntegrationsPersistenceError
	>
	/**
	 * Ends the platform's grant where the connector can (best effort), then drops the link. A
	 * platform that refuses or is down never keeps the row.
	 */
	readonly uninstall: (
		orgId: OrgId,
		workspaceId: ChatWorkspaceId,
	) => Effect.Effect<void, IntegrationsNotFoundError | IntegrationsPersistenceError>
	/** The same for every workspace the org linked, for an org that is being deleted. */
	readonly uninstallAll: (
		orgId: OrgId,
	) => Effect.Effect<ChatUninstallAllResult, IntegrationsPersistenceError>
	/**
	 * The channels in one of the org's workspaces an alert can be posted to, read live from the
	 * platform. A grant the platform refuses is `NotConnected`: only reinstalling fixes it.
	 */
	readonly listDestinations: (
		orgId: OrgId,
		workspaceId: ChatWorkspaceId,
	) => Effect.Effect<
		ReadonlyArray<ChatDestination>,
		| IntegrationsNotFoundError
		| IntegrationsNotConnectedError
		| IntegrationsUpstreamError
		| IntegrationsConfigurationError
		| IntegrationsPersistenceError
	>
	/**
	 * The org behind an inbound chat event. Called by the Worker that runs the
	 * bot, which reaches the same Postgres through its own Hyperdrive binding —
	 * there is no internal HTTP hop, so there is no second credential to hold and
	 * no second place the resolution can disagree.
	 */
	readonly resolve: (
		connectorId: ChatConnectorId,
		externalWorkspaceId: string,
	) => Effect.Effect<Option.Option<ChatWorkspaceResolution>, IntegrationsPersistenceError>
}

const make: Effect.Effect<
	ChatWorkspaceServiceApi,
	never,
	Database | Env | OAuthStateRepository | HttpClient.HttpClient
> = Effect.gen(function* () {
	const database = yield* Database
	const env = yield* Env
	const states = yield* OAuthStateRepository
	const httpClient = yield* HttpClient.HttpClient
	const registry = yield* ChatConnectorRegistry

	const config = env.CHAT_CONNECTOR_CONFIG

	/**
	 * The keyring the per-workspace credential envelope is sealed and opened with.
	 *
	 * Read lazily rather than at layer build: only a connector whose install mints a credential
	 * needs it, and a deployment without one must still list, link and unlink everything else.
	 */
	const credentialKeyring = secretKeyringFromEnv(
		env,
		(message) =>
			new IntegrationsConfigurationError({
				message: `Chat workspace credentials cannot be stored on this deployment: ${message}`,
			}),
	)

	const toPersistenceError = (error: DatabaseError | OAuthStatePersistenceError) =>
		new IntegrationsPersistenceError({ message: `${error._tag}: ${error.message}` })
	const dbExecute = makeDbExecute(database, "ChatWorkspaceService", toPersistenceError)

	const notFound = (message: string) => new IntegrationsNotFoundError({ message })

	/** Redeem the callback's state: single-use, and only for the identity that started the flow. */
	const consumeState = (params: URLSearchParams, provider: string, initiator: OAuthFlowInitiator) => {
		const state = params.get("state")
		return state === null
			? Effect.fail(new IntegrationsValidationError({ message: "The callback carried no state" }))
			: states
					.consume({ state, provider, initiator })
					.pipe(
						Effect.catchTag("@maple/http/errors/OAuthStatePersistenceError", (error) =>
							Effect.fail(toPersistenceError(error)),
						),
					)
	}

	const requireConnector = (connectorId: ChatConnectorId) =>
		Effect.fromOption(
			Arr.findFirst(registry, (connector) => connector.id === connectorId),
			() => notFound(`No chat connector named ${connectorId}`),
		)

	/** The identity half of a connector, or the failure a connector without one earns. */
	const requireIdentity = (connector: ChatConnector<unknown>) =>
		connector.identity === undefined
			? Effect.fail(notFound(`${connector.manifest.name} cannot link individual accounts`))
			: Effect.succeed(connector.identity)

	/**
	 * Settings reach the connector as the admin typed them, minus blanks: a
	 * cleared text field means "unset", which every connector would otherwise
	 * have to spell out as an empty-string case in its own schema.
	 */
	const validateSettings = (connector: ChatConnector<unknown>, settings: ChatWorkspaceSettings) =>
		connector.install
			.decodeSettings(
				Rec.fromEntries(
					Arr.flatMap(Rec.toEntries(settings), ([key, value]) =>
						Str.trim(value).length > 0 ? [[key, Str.trim(value)] as const] : [],
					),
				),
			)
			.pipe(Effect.mapError((error) => new IntegrationsValidationError({ message: error.message })))

	// The table codecs decode the id, connector and settings, so an unreadable row fails the
	// read as a persistence error rather than surfacing as a 500 when the response is encoded.
	const toSummary = (row: ChatWorkspaceRow): ChatWorkspaceSummary => ({
		id: row.id,
		connector: row.connector,
		externalWorkspaceId: row.externalWorkspaceId,
		name: row.name,
		settings: row.settings,
		features: {
			alertsEnabled: row.alertsEnabled,
			directMessagesEnabled: row.directMessagesEnabled,
			assistantEnabled: row.assistantEnabled,
		},
		createdAt: row.createdAt,
	})

	const rowsForOrg = (orgId: OrgId) =>
		dbExecute((db) =>
			db.run(
				PG.from(ChatWorkspaces)
					.select()
					.where(($) => [$.orgId.eq(orgId)])
					.orderBy(["createdAt", "asc"]),
			),
		)

	const list = Effect.fn("ChatWorkspaceService.list")(function* (orgId: OrgId, userId?: UserId) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const rows = yield* rowsForOrg(orgId)
		const summaries = Arr.map(rows, toSummary)
		// One query for every connector's link rather than one per connector: a
		// person holds at most one link each, and the card reads them together.
		const identities = userId === undefined ? [] : yield* listChatIdentities(database, orgId, userId)
		return Arr.map(registry, (connector) => ({
			connector,
			available: isConnectorConfigured(connector, config),
			workspaces: Arr.filter(summaries, (workspace) => workspace.connector === connector.id),
			supportsIdentity: connector.identity !== undefined,
			identity: Arr.findFirst(identities, (link) => link.connector === connector.id).pipe(
				Option.getOrUndefined,
			),
		}))
	})

	const beginInstall = Effect.fn("ChatWorkspaceService.beginInstall")(function* (
		orgId: OrgId,
		userId: UserId,
		connectorId: ChatConnectorId,
		callbackUrl: string,
	) {
		yield* Effect.annotateCurrentSpan({ orgId, "maple.chat.connector": connectorId })
		const connector = yield* requireConnector(connectorId)
		const state = yield* newOAuthState
		// The URL first: an unconfigured connector fails here, before a state row
		// nobody will ever redeem is written.
		const url = yield* connector.install
			.authorizeUrl({ config, state, redirectUri: callbackUrl })
			.pipe(Effect.mapError((error) => new IntegrationsConfigurationError({ message: error.message })))
		yield* states
			.save({
				state,
				provider: stateProvider(connectorId),
				initiator: { orgId, userId },
				redirectUri: callbackUrl,
				returnTo: null,
			})
			.pipe(Effect.mapError(toPersistenceError))
		return { url }
	})

	// The state only redeems for the signed-in Maple user and org that began the
	// install, so an authorize URL forwarded to a chat-workspace manager links
	// nothing to the sender's org. The workspace identity comes from the connector,
	// and a workspace already linked to another org is rejected below, not moved.
	const completeInstall = Effect.fn("ChatWorkspaceService.completeInstall")(function* (
		connectorId: ChatConnectorId,
		params: URLSearchParams,
		initiator: OAuthFlowInitiator,
	) {
		yield* Effect.annotateCurrentSpan({ "maple.chat.connector": connectorId })
		const connector = yield* requireConnector(connectorId)
		const row = yield* consumeState(params, stateProvider(connectorId), initiator)
		const now = yield* Clock.currentTimeMillis
		const orgId = yield* decodeOrgId(row.orgId).pipe(
			Effect.mapError(
				(error) =>
					new IntegrationsPersistenceError({
						message: `Stored install state has an invalid orgId: ${error.message}`,
					}),
			),
		)
		yield* Effect.annotateCurrentSpan({ orgId })

		// The connector's HTTP client is supplied here, from the one this service
		// acquired: a connector's install flow must not leak `HttpClient` into the
		// requirements of whoever calls `completeInstall`.
		const installed = yield* connector.install
			.complete({ config, params, redirectUri: row.redirectUri })
			.pipe(
				Effect.provideService(HttpClient.HttpClient, httpClient),
				Effect.catchTags({
					"@maple/chat-platform/ChatConnectorNotConfigured": (error) =>
						Effect.fail(new IntegrationsConfigurationError({ message: error.message })),
					"@maple/chat-platform/ChatInstallFailed": (error) =>
						Effect.fail(new IntegrationsUpstreamError({ message: error.message })),
				}),
			)

		// A connector that minted a per-workspace secret hands it over as one opaque string; it is
		// sealed here and never read above the connector that wrote it. A re-install replaces it,
		// because the platform issued a new one and the old one is what was just revoked.
		const credentials = installed.credentials
		const sealed =
			credentials === undefined
				? null
				: yield* Effect.flatMap(credentialKeyring, (keyring) =>
						sealChatWorkspaceCredentials(
							credentials,
							keyring,
							{
								orgId,
								connector: connectorId,
								externalWorkspaceId: installed.externalWorkspaceId,
							},
							(message) =>
								new IntegrationsPersistenceError({
									message: `The chat workspace credential could not be stored: ${message}`,
								}),
						),
					)
		const credentialColumns = {
			credentialsCiphertext: sealed?.ciphertext ?? null,
			credentialsIv: sealed?.iv ?? null,
			credentialsTag: sealed?.tag ?? null,
		}

		const inserted = yield* dbExecute((db) =>
			db.run(
				PG.insertInto(ChatWorkspaces)
					.values({
						id: newWorkspaceId(),
						orgId,
						connector: connectorId,
						externalWorkspaceId: installed.externalWorkspaceId,
						name: installed.name,
						settings: {},
						...credentialColumns,
						createdAt: now,
					})
					.onConflictDoUpdate({
						target: ["connector", "externalWorkspaceId"],
						// A re-install refreshes the org's own row (the name and the credential may
						// both have changed) and keeps its settings. Another org's row is left alone:
						// the update is skipped, and zero returned rows is the conflict.
						where: ($) => $.orgId.eq(orgId),
						set: { name: installed.name, ...credentialColumns },
					})
					.returning("id"),
			),
		)
		if (inserted.length === 0) {
			// The branch the conflict guard exists to produce: this workspace is
			// already linked to a different org. Worth counting, so it is logged.
			yield* Effect.logWarning("Chat workspace is already linked to another organization", {
				orgId,
				connector: connectorId,
				externalWorkspaceId: installed.externalWorkspaceId,
			})
			return yield* new IntegrationsForbiddenError({ message: CROSS_ORG_CONFLICT_MESSAGE })
		}
		yield* Effect.logInfo("Chat workspace linked", {
			orgId,
			connector: connectorId,
			externalWorkspaceId: installed.externalWorkspaceId,
		})
		return { orgId, name: installed.name }
	})

	const beginLink = Effect.fn("ChatWorkspaceService.beginLink")(function* (
		orgId: OrgId,
		userId: UserId,
		connectorId: ChatConnectorId,
		callbackUrl: string,
	) {
		yield* Effect.annotateCurrentSpan({ orgId, "maple.chat.connector": connectorId })
		const connector = yield* requireConnector(connectorId)
		const identity = yield* requireIdentity(connector)
		const state = yield* newOAuthState
		// The URL first, as the install does: an unconfigured connector fails here,
		// before a state row nobody will ever redeem is written.
		const url = yield* identity
			.authorizeUrl({ config, state, redirectUri: callbackUrl })
			.pipe(Effect.mapError((error) => new IntegrationsConfigurationError({ message: error.message })))
		yield* states
			.save({
				state,
				provider: identityStateProvider(connectorId),
				// The Maple user the callback will bind the chat account to: see `completeLink`.
				initiator: { orgId, userId },
				redirectUri: callbackUrl,
				returnTo: null,
			})
			.pipe(Effect.mapError(toPersistenceError))
		return { url }
	})

	/**
	 * Bind the chat account that just authorized to the Maple user who started the link.
	 *
	 * The state row names that user, and it only redeems when `initiator` (the session finishing
	 * the link) is the same user and org, so a link URL forwarded to a colleague binds nothing.
	 * The provider namespace keeps install and link states from redeeming each other.
	 */
	const completeLink = Effect.fn("ChatWorkspaceService.completeLink")(function* (
		connectorId: ChatConnectorId,
		params: URLSearchParams,
		initiator: OAuthFlowInitiator,
	) {
		yield* Effect.annotateCurrentSpan({ "maple.chat.connector": connectorId })
		const connector = yield* requireConnector(connectorId)
		const identity = yield* requireIdentity(connector)
		const row = yield* consumeState(params, identityStateProvider(connectorId), initiator)
		const now = yield* Clock.currentTimeMillis
		const orgId = yield* decodeOrgId(row.orgId).pipe(
			Effect.mapError(
				(error) =>
					new IntegrationsPersistenceError({
						message: `Stored link state has an invalid orgId: ${error.message}`,
					}),
			),
		)
		yield* Effect.annotateCurrentSpan({ orgId })

		// The connector's HTTP client is supplied here, from the one this service
		// acquired, so `completeLink` leaks no `HttpClient` to its caller.
		const account = yield* identity.complete({ config, params, redirectUri: row.redirectUri }).pipe(
			Effect.provideService(HttpClient.HttpClient, httpClient),
			Effect.catchTags({
				"@maple/chat-platform/ChatConnectorNotConfigured": (error) =>
					Effect.fail(new IntegrationsConfigurationError({ message: error.message })),
				"@maple/chat-platform/ChatIdentityFailed": (error) =>
					Effect.fail(new IntegrationsUpstreamError({ message: error.message })),
			}),
		)

		// Decoded, not trusted: the column is a `$type<UserId>()` cast over whatever is in the
		// table, and this value becomes the tenant a mutating tool runs under.
		const initiatedBy = yield* decodeUserId(row.initiatedByUserId).pipe(
			Effect.mapError(
				(error) =>
					new IntegrationsPersistenceError({
						message: `Stored link state has an invalid userId: ${error.message}`,
					}),
			),
		)

		yield* linkChatIdentity(database, {
			id: newChatIdentityId(),
			orgId,
			connectorId,
			externalUserId: account.externalUserId,
			userId: initiatedBy,
			...(account.displayName === undefined ? undefined : { displayName: account.displayName }),
			nowMs: now,
		})
		yield* Effect.logInfo("Chat account linked", {
			orgId,
			connector: connectorId,
			userId: initiatedBy,
		})
		return { orgId, displayName: account.displayName }
	})

	const unlink = Effect.fn("ChatWorkspaceService.unlink")(function* (
		orgId: OrgId,
		userId: UserId,
		connectorId: ChatConnectorId,
	) {
		yield* Effect.annotateCurrentSpan({ orgId, "maple.chat.connector": connectorId })
		yield* requireConnector(connectorId)
		const unlinked = yield* unlinkChatIdentity(database, orgId, connectorId, userId)
		if (unlinked) {
			yield* Effect.logInfo("Chat account unlinked", { orgId, connector: connectorId, userId })
		}
		return { unlinked }
	})

	const loadOwned = Effect.fnUntraced(function* (orgId: OrgId, workspaceId: ChatWorkspaceId) {
		const rows = yield* dbExecute((db) =>
			db.run(
				PG.from(ChatWorkspaces)
					.select()
					.where(($) => [$.id.eq(workspaceId), $.orgId.eq(orgId)])
					.limit(1),
			),
		)
		const row = rows[0]
		if (row === undefined) return yield* notFound("No chat workspace with this id")
		return row
	})

	const updateWorkspace = Effect.fn("ChatWorkspaceService.updateWorkspace")(function* (
		orgId: OrgId,
		workspaceId: ChatWorkspaceId,
		update: ChatWorkspaceUpdate,
	) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const row = yield* loadOwned(orgId, workspaceId)
		const connector = update.settings === undefined ? undefined : yield* requireConnector(row.connector)
		const settings =
			connector === undefined || update.settings === undefined
				? undefined
				: yield* validateSettings(connector, update.settings)
		const features = update.features ?? {}
		// Only the columns sent: a concurrent save of another switch keeps its value.
		const set = {
			...(settings !== undefined && { settings }),
			...(features.alertsEnabled !== undefined && { alertsEnabled: features.alertsEnabled }),
			...(features.directMessagesEnabled !== undefined && {
				directMessagesEnabled: features.directMessagesEnabled,
			}),
			...(features.assistantEnabled !== undefined && { assistantEnabled: features.assistantEnabled }),
		}
		if (Rec.isEmptyRecord<string, unknown>(set)) return toSummary(row)
		const updated = yield* dbExecute((db) =>
			db.run(
				PG.update(ChatWorkspaces)
					.set(set)
					.where(($) => [$.id.eq(workspaceId), $.orgId.eq(orgId)])
					.returning(),
			),
		)
		const stored = updated[0]
		// Lost a race with an unlink: the row was there a statement ago.
		if (stored === undefined) return yield* notFound("No chat workspace with this id")
		return toSummary(stored)
	})

	/** Decided once: a preview or local stack never ends a grant its chat app may share. */
	const revokeDecision = chatAppRevokeDecision(env.MAPLE_ENVIRONMENT)

	/** The connector's own `revoke` for the row, bounded in time. A refusal fails. */
	const callConnectorRevoke = Effect.fnUntraced(function* (row: ChatWorkspaceRow) {
		const connector = Arr.findFirst(registry, (candidate) => candidate.id === row.connector)
		const revoke = Option.getOrUndefined(connector)?.install.revoke
		if (revoke === undefined) return "unsupported" satisfies ChatRevokeOutcome
		const sealed = storedCredentials(row)
		// Only a workspace that stored a credential needs the key to open it.
		const keyring = sealed === null ? null : yield* credentialKeyring
		const own =
			sealed === null || keyring === null
				? undefined
				: yield* openChatWorkspaceCredentials(
						sealed,
						keyring,
						{
							orgId: row.orgId,
							connector: row.connector,
							externalWorkspaceId: row.externalWorkspaceId,
						},
						// The message never carries the cause: everything below it is key material.
						(message) =>
							new IntegrationsConfigurationError({
								message: `Stored chat workspace credential is unreadable: ${message}`,
							}),
					)
		const revoked = yield* revoke({
			externalWorkspaceId: row.externalWorkspaceId,
			credentials: chatConnectorCredentials(env.CHAT_CONNECTOR_OUTBOUND_CONFIG, own),
		}).pipe(
			Effect.provideService(HttpClient.HttpClient, httpClient),
			Effect.timeoutOption(REVOKE_TIMEOUT),
		)
		return (Option.isSome(revoked) ? "revoked" : "timed_out") satisfies ChatRevokeOutcome
	})

	/**
	 * Ends the platform's side of a link where this deployment owns its chat app. Best effort: the
	 * outcome goes on the span, and a refusal, a timeout or a defect is logged and never fails.
	 */
	const revokeAtPlatform = Effect.fn("ChatWorkspaceService.revokeAtPlatform")(function* (
		row: ChatWorkspaceRow,
	) {
		yield* Effect.annotateCurrentSpan({
			orgId: row.orgId,
			"maple.chat.connector": row.connector,
			"maple.chat.revoke_attempted": revokeDecision.revoke,
		})
		if (!revokeDecision.revoke) {
			yield* Effect.annotateCurrentSpan({
				"maple.chat.revoke_outcome": "skipped" satisfies ChatRevokeOutcome,
				"maple.chat.revoke_skip_reason": revokeDecision.reason,
			})
			return "skipped" satisfies ChatRevokeOutcome
		}
		const notRevoked = (error: string) =>
			// The connector's message names no credential; the token rides request headers only.
			Effect.logWarning("Chat workspace grant was not revoked at the platform", {
				orgId: row.orgId,
				connector: row.connector,
				error,
			}).pipe(Effect.as("failed" satisfies ChatRevokeOutcome))
		const outcome = yield* callConnectorRevoke(row).pipe(
			Effect.catch((error) => notRevoked(error.message)),
			// A defect's text is not logged: nothing vouches for what it carries.
			Effect.catchDefect(() => notRevoked("the connector's revoke died")),
		)
		yield* Effect.annotateCurrentSpan({ "maple.chat.revoke_outcome": outcome })
		if (outcome === "timed_out") {
			yield* Effect.logWarning("Chat workspace revoke timed out at the platform", {
				orgId: row.orgId,
				connector: row.connector,
			})
		}
		return outcome
	})

	/** Revokes at the platform, then drops the row whatever the platform answered. */
	const unlinkRow = Effect.fn("ChatWorkspaceService.unlinkRow")(function* (row: ChatWorkspaceRow) {
		const revoke = yield* revokeAtPlatform(row)
		const deleted = yield* dbExecute((db) =>
			db.run(
				PG.deleteFrom(ChatWorkspaces)
					.where(($) => [$.id.eq(row.id), $.orgId.eq(row.orgId)])
					.returning("id"),
			),
		)
		if (deleted.length > 0) {
			yield* Effect.logInfo("Chat workspace unlinked", { orgId: row.orgId, connector: row.connector })
		}
		return { revoke, unlinked: deleted.length > 0 }
	})

	const uninstall = Effect.fn("ChatWorkspaceService.uninstall")(function* (
		orgId: OrgId,
		workspaceId: ChatWorkspaceId,
	) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const rows = yield* dbExecute((db) =>
			db.run(
				PG.from(ChatWorkspaces)
					.select()
					.where(($) => [$.id.eq(workspaceId), $.orgId.eq(orgId)])
					.limit(1),
			),
		)
		const row = rows[0]
		if (row === undefined) return yield* notFound("No chat workspace with this id")
		const { unlinked } = yield* unlinkRow(row)
		// Lost a race with another unlink of the same workspace.
		if (!unlinked) return yield* notFound("No chat workspace with this id")
	})

	const uninstallAll = Effect.fn("ChatWorkspaceService.uninstallAll")(function* (orgId: OrgId) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const rows = yield* dbExecute((db) =>
			db.run(
				PG.from(ChatWorkspaces)
					.select()
					.where(($) => [$.orgId.eq(orgId)]),
			),
		)
		// Each row on its own: one that cannot be dropped must not stop the others' revokes.
		const results = yield* Effect.forEach(
			rows,
			(row) =>
				unlinkRow(row).pipe(
					Effect.map((result) => ({ ...result, failed: false })),
					Effect.catch((error) =>
						Effect.logWarning("Chat workspace could not be unlinked", {
							orgId,
							connector: row.connector,
							error: error.message,
						}).pipe(Effect.as({ revoke: null, unlinked: false, failed: true })),
					),
				),
			{ concurrency: UNINSTALL_CONCURRENCY },
		)
		const count = (matches: (result: (typeof results)[number]) => boolean) =>
			Arr.filter(results, matches).length
		const result = {
			uninstalled: count((row) => row.unlinked),
			revokeFailures: count((row) => row.revoke === "failed" || row.revoke === "timed_out"),
			unlinkFailures: count((row) => row.failed),
		} satisfies ChatUninstallAllResult
		yield* Effect.annotateCurrentSpan({
			"maple.chat.uninstalled": result.uninstalled,
			"maple.chat.revoke_failures": result.revokeFailures,
			"maple.chat.unlink_failures": result.unlinkFailures,
		})
		return result
	})

	const listDestinations = Effect.fn("ChatWorkspaceService.listDestinations")(function* (
		orgId: OrgId,
		workspaceId: ChatWorkspaceId,
	) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const keyring = yield* credentialKeyring
		const workspace = yield* loadOwnedChatWorkspace(database, registry, orgId, workspaceId, keyring).pipe(
			Effect.catchTags({
				"@maple/backend/lib/DatabaseError": (error) => Effect.fail(toPersistenceError(error)),
				"@maple/backend/ChatWorkspaceCredentialsUnreadable": () =>
					Effect.fail(
						new IntegrationsNotConnectedError({
							message:
								"This workspace's stored credential is unreadable. Reinstall the app from Integrations to relink it.",
						}),
					),
			}),
		)
		if (Option.isNone(workspace)) return yield* notFound("No chat workspace with this id")
		const name = workspace.value.connector.manifest.name
		const missing = missingOutboundConfig(workspace.value, env.CHAT_CONNECTOR_OUTBOUND_CONFIG)
		if (missing.length > 0) {
			return yield* new IntegrationsConfigurationError({
				message: `${name} is not configured on this deployment (${Arr.join(missing, ", ")})`,
			})
		}
		const transport = yield* chatOutboundTransport(
			workspace.value,
			env.CHAT_CONNECTOR_OUTBOUND_CONFIG,
			httpClient,
		)
		return yield* transport.destinations(workspace.value.externalWorkspaceId).pipe(
			Effect.mapError((error) => {
				switch (error.reason) {
					case "auth":
						return new IntegrationsNotConnectedError({
							message: `Maple can't read this workspace's channels. Reinstall ${name} from Integrations to grant channel access.`,
						})
					case "not_found":
						return new IntegrationsNotConnectedError({
							message: `The Maple bot is no longer in this workspace. Reinstall ${name} from Integrations to add it back.`,
						})
					case "rejected":
					case "rate_limited":
					case undefined:
						return new IntegrationsUpstreamError({
							message: error.message,
							...(error.status === undefined ? undefined : { status: error.status }),
							cause: error,
						})
				}
			}),
		)
	})

	const resolve = Effect.fn("ChatWorkspaceService.resolve")(function* (
		connectorId: ChatConnectorId,
		externalWorkspaceId: string,
	) {
		yield* Effect.annotateCurrentSpan({ "maple.chat.connector": connectorId })
		// A deployment with no usable key resolves the workspace without its credential rather than
		// failing the lookup: everything that does not need one keeps working, and the connector
		// that does reports it cannot post.
		const keyring = yield* credentialKeyring.pipe(
			Effect.tapError((error) =>
				Effect.logError("Chat workspace credential key is unusable").pipe(
					Effect.annotateLogs({ "error.type": error._tag, "error.message": error.message }),
				),
			),
			Effect.orElseSucceed(() => null),
		)
		const resolved = yield* resolveChatWorkspace(database, connectorId, externalWorkspaceId, keyring)
		// The one cross-tenant lookup here — the resolved org belongs on the span.
		if (Option.isSome(resolved)) yield* Effect.annotateCurrentSpan({ orgId: resolved.value.orgId })
		return resolved
	})

	return ChatWorkspaceService.of({
		list,
		beginInstall,
		completeInstall,
		beginLink,
		completeLink,
		unlink,
		updateWorkspace,
		uninstall,
		uninstallAll,
		listDestinations,
		resolve,
	})
})

export class ChatWorkspaceService extends Context.Service<ChatWorkspaceService, ChatWorkspaceServiceApi>()(
	"@maple/backend/services/ChatWorkspaceService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(OAuthStateRepository.layer),
	)
}
