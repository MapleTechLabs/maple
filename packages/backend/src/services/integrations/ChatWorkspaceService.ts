import { randomBytes, randomUUID } from "node:crypto"
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
import { chatWorkspaces, type ChatWorkspaceRow } from "@maple/db"
import {
	isConnectorConfigured,
	type ChatConnector,
	type ChatDestination,
	type ChatWorkspaceSettings,
} from "@maple/chat-platform"
import { and, asc, eq } from "drizzle-orm"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { parseBase64Aes256GcmKey } from "@maple/backend/platform/Crypto"
import { Database, type DatabaseError } from "@maple/backend/platform/DatabaseLive"
import { Env } from "@maple/backend/platform/Env"
import { sealChatWorkspaceCredentials } from "@maple/backend/services/integrations/chat-workspace-credentials"
import { dateToMs, msToDate } from "@maple/backend/platform/time"
import { OAuthStateRepository } from "@maple/backend/services/auth/OAuthStateRepository"
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
import {
	ChatConnectorRegistry,
	chatOutboundTransport,
	loadOwnedChatWorkspace,
	missingOutboundConfig,
} from "@maple/backend/services/integrations/chat-outbound"

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

/** How long an install may sit between the authorize redirect and the callback. */
const STATE_TTL_MS = 10 * 60_000

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

/** The row id is a UUID we mint, so the brand is a decode that cannot fail. */
const newWorkspaceId = () => Schema.decodeSync(ChatWorkspaceId)(randomUUID())

/** Same for the identity row. */
const newChatIdentityId = () => Schema.decodeSync(ChatIdentityId)(randomUUID())

/**
 * Stored settings are decoded rather than trusted: the column's type is a cast,
 * and a value that is not a string map would otherwise surface as a 500 when the
 * response is encoded instead of as this service's own persistence failure.
 */
const decodeStoredSettings = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.String))

const decodeOrgId = Schema.decodeUnknownEffect(OrgId)
const decodeUserId = Schema.decodeUnknownEffect(UserId)
const decodeChatWorkspaceId = Schema.decodeUnknownEffect(ChatWorkspaceId)
const decodeConnectorId = Schema.decodeUnknownEffect(ChatConnectorId)

export interface ChatWorkspaceSummary {
	readonly id: ChatWorkspaceId
	readonly connector: ChatConnectorId
	readonly externalWorkspaceId: string
	readonly name: string
	readonly settings: ChatWorkspaceSettings
	readonly createdAt: number
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
	readonly updateSettings: (
		orgId: OrgId,
		workspaceId: ChatWorkspaceId,
		settings: ChatWorkspaceSettings,
	) => Effect.Effect<
		ChatWorkspaceSummary,
		IntegrationsNotFoundError | IntegrationsValidationError | IntegrationsPersistenceError
	>
	readonly uninstall: (
		orgId: OrgId,
		workspaceId: ChatWorkspaceId,
	) => Effect.Effect<void, IntegrationsNotFoundError | IntegrationsPersistenceError>
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
	 * The key the per-workspace credential envelope is sealed and opened with.
	 *
	 * Read lazily rather than at layer build: only a connector whose install mints a credential
	 * needs it, and a deployment without one must still list, link and unlink everything else.
	 */
	const credentialKey = parseBase64Aes256GcmKey(
		Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
		(message) =>
			new IntegrationsConfigurationError({
				message: `Chat workspace credentials cannot be stored on this deployment: ${message}`,
			}),
	)

	const toPersistenceError = (error: DatabaseError | OAuthStatePersistenceError) =>
		new IntegrationsPersistenceError({ message: `${error._tag}: ${error.message}` })

	const notFound = (message: string) => new IntegrationsNotFoundError({ message })

	const requireConnector = (connectorId: ChatConnectorId) =>
		Option.match(
			Arr.findFirst(registry, (connector) => connector.id === connectorId),
			{
				onNone: () => Effect.fail(notFound(`No chat connector named ${connectorId}`)),
				onSome: (connector) => Effect.succeed(connector),
			},
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
				Object.fromEntries(
					Object.entries(settings).flatMap(([key, value]) =>
						value.trim().length > 0 ? [[key, value.trim()] as const] : [],
					),
				),
			)
			.pipe(Effect.mapError((error) => new IntegrationsValidationError({ message: error.message })))

	const toSummary = (
		row: ChatWorkspaceRow,
	): Effect.Effect<ChatWorkspaceSummary, IntegrationsPersistenceError> =>
		Effect.all({
			id: decodeChatWorkspaceId(row.id),
			connector: decodeConnectorId(row.connector),
			settings: decodeStoredSettings(row.settings),
		}).pipe(
			Effect.mapError(
				(error) =>
					new IntegrationsPersistenceError({
						message: `Stored chat workspace is unreadable: ${error.message}`,
					}),
			),
			Effect.map(({ id, connector, settings }) => ({
				id,
				connector,
				externalWorkspaceId: row.externalWorkspaceId,
				name: row.name,
				settings,
				createdAt: dateToMs(row.createdAt),
			})),
		)

	const rowsForOrg = (orgId: OrgId) =>
		database
			.execute((db) =>
				db
					.select()
					.from(chatWorkspaces)
					.where(eq(chatWorkspaces.orgId, orgId))
					.orderBy(asc(chatWorkspaces.createdAt)),
			)
			.pipe(Effect.mapError(toPersistenceError))

	const list = Effect.fn("ChatWorkspaceService.list")(function* (orgId: OrgId, userId?: UserId) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const rows = yield* rowsForOrg(orgId)
		const summaries = yield* Effect.forEach(rows, toSummary)
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
		yield* Effect.annotateCurrentSpan({ orgId, "chat.connector": connectorId })
		const connector = yield* requireConnector(connectorId)
		const state = randomBytes(24).toString("base64url")
		// The URL first: an unconfigured connector fails here, before a state row
		// nobody will ever redeem is written.
		const url = yield* connector.install
			.authorizeUrl({ config, state, redirectUri: callbackUrl })
			.pipe(Effect.mapError((error) => new IntegrationsConfigurationError({ message: error.message })))
		const now = yield* Clock.currentTimeMillis
		yield* states.purgeExpired(now).pipe(Effect.mapError(toPersistenceError))
		yield* states
			.insert({
				state,
				orgId,
				provider: stateProvider(connectorId),
				initiatedByUserId: userId,
				redirectUri: callbackUrl,
				returnTo: null,
				createdAt: msToDate(now),
				expiresAt: msToDate(now + STATE_TTL_MS),
			})
			.pipe(Effect.mapError(toPersistenceError))
		return { url }
	})

	// The same known gap the other OAuth install service in this directory
	// documents: `state` is unguessable, single-use and TTL-bounded, but it is not
	// bound to the browser that started the install, so an attacker who gets a
	// chat-workspace manager to complete THEIR authorize URL links that manager's
	// workspace to the attacker's org. Closing it is the same architecture call,
	// unmade for the same reason — that service's `completeInstall` lists the three
	// options. What is closed here: the workspace identity comes from the
	// connector, which must read it from whatever the platform bound to the
	// callback credential, and a workspace already linked to another org is
	// rejected below rather than moved.
	const completeInstall = Effect.fn("ChatWorkspaceService.completeInstall")(function* (
		connectorId: ChatConnectorId,
		params: URLSearchParams,
	) {
		yield* Effect.annotateCurrentSpan({ "chat.connector": connectorId })
		const connector = yield* requireConnector(connectorId)
		const state = params.get("state")
		if (state === null) {
			return yield* Effect.fail(
				new IntegrationsValidationError({ message: "The callback carried no state" }),
			)
		}
		const stateRow = yield* states.findByState(state).pipe(Effect.mapError(toPersistenceError))
		if (Option.isNone(stateRow) || stateRow.value.provider !== stateProvider(connectorId)) {
			return yield* Effect.fail(
				new IntegrationsValidationError({
					message: "Install state not recognized — start the install again",
				}),
			)
		}
		const row = stateRow.value
		const now = yield* Clock.currentTimeMillis
		// Single-use: burn the state before doing any side effects.
		yield* states.deleteByState(state).pipe(Effect.mapError(toPersistenceError))
		if (dateToMs(row.expiresAt) < now) {
			return yield* Effect.fail(
				new IntegrationsValidationError({
					message: "Install state expired — start the install again",
				}),
			)
		}
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
				: yield* Effect.flatMap(credentialKey, (key) =>
						sealChatWorkspaceCredentials(
							credentials,
							key,
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

		const inserted = yield* database
			.execute((db) =>
				db
					.insert(chatWorkspaces)
					.values({
						id: newWorkspaceId(),
						orgId,
						connector: connectorId,
						externalWorkspaceId: installed.externalWorkspaceId,
						name: installed.name,
						settings: {},
						...credentialColumns,
						createdAt: msToDate(now),
					})
					.onConflictDoUpdate({
						target: [chatWorkspaces.connector, chatWorkspaces.externalWorkspaceId],
						// A re-install refreshes the org's own row (the name and the credential may
						// both have changed) and keeps its settings. Another org's row is left alone:
						// the update is skipped, and zero returned rows is the conflict.
						setWhere: eq(chatWorkspaces.orgId, orgId),
						set: { name: installed.name, ...credentialColumns },
					})
					.returning({ id: chatWorkspaces.id }),
			)
			.pipe(Effect.mapError(toPersistenceError))
		if (inserted.length === 0) {
			// The branch the conflict guard exists to produce: this workspace is
			// already linked to a different org. Worth counting, so it is logged.
			yield* Effect.logWarning("Chat workspace is already linked to another organization", {
				orgId,
				connector: connectorId,
				externalWorkspaceId: installed.externalWorkspaceId,
			})
			return yield* Effect.fail(new IntegrationsForbiddenError({ message: CROSS_ORG_CONFLICT_MESSAGE }))
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
		yield* Effect.annotateCurrentSpan({ orgId, "chat.connector": connectorId })
		const identity = yield* requireIdentity(yield* requireConnector(connectorId))
		const state = randomBytes(24).toString("base64url")
		// The URL first, as the install does: an unconfigured connector fails here,
		// before a state row nobody will ever redeem is written.
		const url = yield* identity
			.authorizeUrl({ config, state, redirectUri: callbackUrl })
			.pipe(Effect.mapError((error) => new IntegrationsConfigurationError({ message: error.message })))
		const now = yield* Clock.currentTimeMillis
		yield* states.purgeExpired(now).pipe(Effect.mapError(toPersistenceError))
		yield* states
			.insert({
				state,
				orgId,
				provider: identityStateProvider(connectorId),
				// The Maple user the callback will bind the chat account to — see `completeLink`.
				initiatedByUserId: userId,
				redirectUri: callbackUrl,
				returnTo: null,
				createdAt: msToDate(now),
				expiresAt: msToDate(now + STATE_TTL_MS),
			})
			.pipe(Effect.mapError(toPersistenceError))
		return { url }
	})

	/**
	 * Bind the chat account that just authorized to the Maple user who started the link.
	 *
	 * That user comes from the state row's `initiatedByUserId`, never from the session on the
	 * callback request. The callback is a top-level redirect the chat platform issues, so the
	 * browser that opens it need not be the browser that began the link — binding on a cookie
	 * would let somebody finish a link in a different session, onto whichever Maple user happened
	 * to be signed in there. The state row is the only thing that knows both halves, and it is
	 * unguessable, single-use and TTL-bounded.
	 */
	const completeLink = Effect.fn("ChatWorkspaceService.completeLink")(function* (
		connectorId: ChatConnectorId,
		params: URLSearchParams,
	) {
		yield* Effect.annotateCurrentSpan({ "chat.connector": connectorId })
		const identity = yield* requireIdentity(yield* requireConnector(connectorId))
		const state = params.get("state")
		if (state === null) {
			return yield* Effect.fail(
				new IntegrationsValidationError({ message: "The callback carried no state" }),
			)
		}
		const stateRow = yield* states.findByState(state).pipe(Effect.mapError(toPersistenceError))
		// The provider check is what keeps the two halves apart: an install's state names
		// `chat:<connector>` and is refused here, and the reverse holds in `completeInstall`.
		if (Option.isNone(stateRow) || stateRow.value.provider !== identityStateProvider(connectorId)) {
			return yield* Effect.fail(
				new IntegrationsValidationError({
					message: "Link state not recognized — start the link again",
				}),
			)
		}
		const row = stateRow.value
		const now = yield* Clock.currentTimeMillis
		// Single-use: burn the state before doing any side effects.
		yield* states.deleteByState(state).pipe(Effect.mapError(toPersistenceError))
		if (dateToMs(row.expiresAt) < now) {
			return yield* Effect.fail(
				new IntegrationsValidationError({ message: "Link state expired — start the link again" }),
			)
		}
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
		yield* Effect.annotateCurrentSpan({ orgId, "chat.connector": connectorId })
		yield* requireConnector(connectorId)
		const unlinked = yield* unlinkChatIdentity(database, orgId, connectorId, userId)
		if (unlinked) {
			yield* Effect.logInfo("Chat account unlinked", { orgId, connector: connectorId, userId })
		}
		return { unlinked }
	})

	const loadOwned = Effect.fnUntraced(function* (orgId: OrgId, workspaceId: ChatWorkspaceId) {
		const rows = yield* database
			.execute((db) =>
				db
					.select()
					.from(chatWorkspaces)
					.where(and(eq(chatWorkspaces.id, workspaceId), eq(chatWorkspaces.orgId, orgId)))
					.limit(1),
			)
			.pipe(Effect.mapError(toPersistenceError))
		const row = rows[0]
		if (row === undefined) return yield* Effect.fail(notFound("No chat workspace with this id"))
		return row
	})

	const updateSettings = Effect.fn("ChatWorkspaceService.updateSettings")(function* (
		orgId: OrgId,
		workspaceId: ChatWorkspaceId,
		settings: ChatWorkspaceSettings,
	) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const row = yield* loadOwned(orgId, workspaceId)
		const connector = yield* requireConnector(
			yield* decodeConnectorId(row.connector).pipe(
				Effect.mapError(
					(error) =>
						new IntegrationsPersistenceError({
							message: `Stored chat workspace is unreadable: ${error.message}`,
						}),
				),
			),
		)
		const validated = yield* validateSettings(connector, settings)
		const updated = yield* database
			.execute((db) =>
				db
					.update(chatWorkspaces)
					.set({ settings: validated })
					.where(and(eq(chatWorkspaces.id, workspaceId), eq(chatWorkspaces.orgId, orgId)))
					.returning(),
			)
			.pipe(Effect.mapError(toPersistenceError))
		const stored = updated[0]
		// Lost a race with an unlink: the row was there a statement ago.
		if (stored === undefined) return yield* Effect.fail(notFound("No chat workspace with this id"))
		return yield* toSummary(stored)
	})

	const uninstall = Effect.fn("ChatWorkspaceService.uninstall")(function* (
		orgId: OrgId,
		workspaceId: ChatWorkspaceId,
	) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const deleted = yield* database
			.execute((db) =>
				db
					.delete(chatWorkspaces)
					.where(and(eq(chatWorkspaces.id, workspaceId), eq(chatWorkspaces.orgId, orgId)))
					.returning({ connector: chatWorkspaces.connector }),
			)
			.pipe(Effect.mapError(toPersistenceError))
		const row = deleted[0]
		if (row === undefined) {
			return yield* Effect.fail(notFound("No chat workspace with this id"))
		}
		yield* Effect.logInfo("Chat workspace unlinked", { orgId, connector: row.connector })
	})

	const listDestinations = Effect.fn("ChatWorkspaceService.listDestinations")(function* (
		orgId: OrgId,
		workspaceId: ChatWorkspaceId,
	) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const key = yield* credentialKey
		const workspace = yield* loadOwnedChatWorkspace(database, registry, orgId, workspaceId, key).pipe(
			Effect.catchTags({
				"@maple/api/lib/DatabaseError": (error) => Effect.fail(toPersistenceError(error)),
				"@maple/backend/ChatWorkspaceCredentialsUnreadable": () =>
					Effect.fail(
						new IntegrationsNotConnectedError({
							message:
								"This workspace's stored credential is unreadable. Reinstall the app from Integrations to relink it.",
						}),
					),
			}),
		)
		if (Option.isNone(workspace)) return yield* Effect.fail(notFound("No chat workspace with this id"))
		const name = workspace.value.connector.manifest.name
		const missing = missingOutboundConfig(workspace.value, env.CHAT_CONNECTOR_OUTBOUND_CONFIG)
		if (missing.length > 0) {
			return yield* Effect.fail(
				new IntegrationsConfigurationError({
					message: `${name} is not configured on this deployment (${missing.join(", ")})`,
				}),
			)
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
		yield* Effect.annotateCurrentSpan({ "chat.connector": connectorId })
		// A deployment with no usable key resolves the workspace without its credential rather than
		// failing the lookup: everything that does not need one keeps working, and the connector
		// that does reports it cannot post.
		const key = yield* credentialKey.pipe(
			Effect.tapError((error) =>
				Effect.logError("Chat workspace credential key is unusable").pipe(
					Effect.annotateLogs({ "error.type": error._tag, "error.message": error.message }),
				),
			),
			Effect.orElseSucceed(() => null),
		)
		const resolved = yield* resolveChatWorkspace(database, connectorId, externalWorkspaceId, key)
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
		updateSettings,
		uninstall,
		listDestinations,
		resolve,
	})
})

export class ChatWorkspaceService extends Context.Service<ChatWorkspaceService, ChatWorkspaceServiceApi>()(
	"@maple/api/services/ChatWorkspaceService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(OAuthStateRepository.layer),
	)
}
