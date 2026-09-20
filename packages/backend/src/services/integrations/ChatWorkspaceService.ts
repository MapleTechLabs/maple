import { randomBytes, randomUUID } from "node:crypto"
import {
	ChatConnectorId,
	ChatWorkspaceId,
	IntegrationsConfigurationError,
	IntegrationsForbiddenError,
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
	connectors,
	isConnectorConfigured,
	type ChatConnector,
	type ChatWorkspaceSettings,
} from "@maple/chat-platform"
import { and, asc, eq } from "drizzle-orm"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { Database, type DatabaseError } from "@maple/backend/platform/DatabaseLive"
import { Env } from "@maple/backend/platform/Env"
import { dateToMs, msToDate } from "@maple/backend/platform/time"
import { OAuthStateRepository } from "@maple/backend/services/auth/OAuthStateRepository"

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

/** Public callback path a connector's platform redirects to (mounted in http-graph.ts). */
export const chatCallbackPath = (connector: ChatConnectorId): string => `/oauth/chat/${connector}/callback`

const CROSS_ORG_CONFLICT_MESSAGE =
	"This chat workspace is already linked to a different Maple organization. Unlink it there first."

/**
 * The connectors this service resolves ids against. A reference rather than a
 * direct import of the registry: production gets the real one by default, and a
 * test can hand the host half a fake connector and exercise the install flow
 * without a chat platform on the other end.
 */
export class ChatConnectorRegistry extends Context.Reference<ReadonlyArray<ChatConnector>>(
	"@maple/api/services/ChatConnectorRegistry",
	{ defaultValue: (): ReadonlyArray<ChatConnector> => connectors },
) {}

/** The row id is a UUID we mint, so the brand is a decode that cannot fail. */
const newWorkspaceId = () => Schema.decodeSync(ChatWorkspaceId)(randomUUID())

/**
 * Stored settings are decoded rather than trusted: the column's type is a cast,
 * and a value that is not a string map would otherwise surface as a 500 when the
 * response is encoded instead of as this service's own persistence failure.
 */
const decodeStoredSettings = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.String))

const decodeOrgId = Schema.decodeUnknownEffect(OrgId)
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
	readonly connector: ChatConnector
	readonly available: boolean
	readonly workspaces: ReadonlyArray<ChatWorkspaceSummary>
}

/** What the bot Worker needs to act on an inbound event. */
export interface ChatWorkspaceResolution {
	readonly orgId: OrgId
	readonly workspaceId: ChatWorkspaceId
	readonly settings: ChatWorkspaceSettings
}

export interface ChatWorkspaceServiceApi {
	/** Every registered connector, with this org's linked workspaces. */
	readonly list: (
		orgId: OrgId,
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

	/**
	 * Settings reach the connector as the admin typed them, minus blanks: a
	 * cleared text field means "unset", which every connector would otherwise
	 * have to spell out as an empty-string case in its own schema.
	 */
	const validateSettings = (connector: ChatConnector, settings: ChatWorkspaceSettings) =>
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

	const list = Effect.fn("ChatWorkspaceService.list")(function* (orgId: OrgId) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const rows = yield* rowsForOrg(orgId)
		const summaries = yield* Effect.forEach(rows, toSummary)
		return Arr.map(registry, (connector) => ({
			connector,
			available: isConnectorConfigured(connector, config),
			workspaces: Arr.filter(summaries, (workspace) => workspace.connector === connector.id),
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
						createdAt: msToDate(now),
					})
					.onConflictDoUpdate({
						target: [chatWorkspaces.connector, chatWorkspaces.externalWorkspaceId],
						// A re-install refreshes the org's own row (the name may have
						// changed) and keeps its settings. Another org's row is left alone:
						// the update is skipped, and zero returned rows is the conflict.
						setWhere: eq(chatWorkspaces.orgId, orgId),
						set: { name: installed.name },
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

	const resolve = Effect.fn("ChatWorkspaceService.resolve")(function* (
		connectorId: ChatConnectorId,
		externalWorkspaceId: string,
	) {
		yield* Effect.annotateCurrentSpan({ "chat.connector": connectorId })
		const rows = yield* database
			.execute((db) =>
				db
					.select()
					.from(chatWorkspaces)
					.where(
						and(
							eq(chatWorkspaces.connector, connectorId),
							eq(chatWorkspaces.externalWorkspaceId, externalWorkspaceId),
						),
					)
					.limit(1),
			)
			.pipe(Effect.mapError(toPersistenceError))
		const row = rows[0]
		if (row === undefined) return Option.none<ChatWorkspaceResolution>()
		const summary = yield* toSummary(row)
		const orgId = yield* decodeOrgId(row.orgId).pipe(
			Effect.mapError(
				(error) =>
					new IntegrationsPersistenceError({
						message: `Stored chat workspace has an invalid orgId: ${error.message}`,
					}),
			),
		)
		// The one cross-tenant lookup here — the resolved org belongs on the span.
		yield* Effect.annotateCurrentSpan({ orgId })
		return Option.some({ orgId, workspaceId: summary.id, settings: summary.settings })
	})

	return ChatWorkspaceService.of({
		list,
		beginInstall,
		completeInstall,
		updateSettings,
		uninstall,
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
