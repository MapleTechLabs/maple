import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Duration, Effect, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import { ChatConnectorId, ChatWorkspaceId, OrgId, UserId } from "@maple/domain/http"
import {
	chatConnectorConfigNames,
	ChatConnectorNotConfigured,
	ChatOutboundError,
	ChatSettingsRejected,
	socketIngress,
	type ChatConnector,
	type ChatOutboundTransport,
	type ChatWorkspaceSettings,
} from "@maple/chat-platform"
import { connectors } from "@maple/chat-platform/connectors"
import { Env } from "@maple/backend/platform/Env"
import { OAuthStateRepository } from "@maple/backend/services/auth/OAuthStateRepository"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { forgetChatWorkspace, resolveChatWorkspace } from "./chat-workspace-rows"
import type { RegisteredChatConnector } from "./chat-outbound"
import { ChatConnectorRegistry, ChatWorkspaceService } from "./ChatWorkspaceService"

/**
 * The host half of the chat-platform contract, driven by a fake connector: no
 * chat platform is named here, nothing reaches the network, and every branch of
 * the install flow is reachable. A connector added tomorrow changes none of it.
 */

const ORG = Schema.decodeSync(OrgId)("org_chat_1")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_chat_2")
const USER = Schema.decodeSync(UserId)("user_chat_1")
const OTHER_USER = Schema.decodeSync(UserId)("user_chat_2")
const TEST_CONNECTOR = Schema.decodeSync(ChatConnectorId)("testchat")
const IDENTITY_CONNECTOR = Schema.decodeSync(ChatConnectorId)("testchatid")
const UNREGISTERED = Schema.decodeSync(ChatConnectorId)("nosuchchat")
const CALLBACK = "https://api.localhost/oauth/chat/testchat/callback"
const IDENTITY_CALLBACK = "https://api.localhost/oauth/chat/testchatid/identity/callback"

/**
 * The fake connector declares a config name the HOST already resolves: the
 * runtime catalog is built from the shipped registry, so a name invented here
 * would never reach `Env` and every install would read as unconfigured.
 */
const CONFIG_NAME = chatConnectorConfigNames[0] ?? "CHAT_CONNECTOR_CONFIG_MISSING"

/** Mirror of the service's (unexported) state TTL — 10 minutes. */
const STATE_TTL_MS = 10 * 60_000

/** No frame ever reaches the fake connector's socket half — see its `ingress` below. */
const unreachableStep = (): never => {
	throw new Error("the install flow drove the ingress state machine")
}

/**
 * A connector with no platform behind it: `complete` reads the workspace out of
 * the callback the test wrote, which is exactly what a real connector does with
 * whatever its platform binds to the callback credential.
 */
const testConnector: ChatConnector = {
	id: TEST_CONNECTOR,
	manifest: {
		id: TEST_CONNECTOR,
		name: "Test Chat",
		description: "A connector that exists only in this test.",
		icon: { viewBox: "0 0 24 24", paths: ["M0 0h24v24H0z"] },
		accent: "#000000",
		settingsFields: [{ key: "approver", label: "Approver", help: "Who may approve.", kind: "text" }],
	},
	install: {
		requiredConfig: [{ name: CONFIG_NAME, secret: true }],
		authorizeUrl: ({ config, state, redirectUri }) =>
			config.has(CONFIG_NAME)
				? Effect.succeed(`https://chat.test/authorize?state=${state}&redirect_uri=${redirectUri}`)
				: Effect.fail(
						new ChatConnectorNotConfigured({
							connector: TEST_CONNECTOR,
							message: `${CONFIG_NAME} is not set`,
						}),
					),
		complete: ({ params }) =>
			Effect.succeed({
				externalWorkspaceId: params.get("workspace") ?? "workspace-default",
				name: params.get("name") ?? "Test workspace",
				// A connector whose platform mints a per-workspace secret returns it here as one
				// opaque string; one that does not returns nothing, and both must work.
				...(params.has("credentials") ? { credentials: params.get("credentials") ?? "" } : undefined),
			}),
		decodeSettings: (input: ChatWorkspaceSettings) =>
			input.approver === undefined || /^[a-z]+$/.test(input.approver)
				? Effect.succeed(input)
				: Effect.fail(
						new ChatSettingsRejected({
							connector: TEST_CONNECTOR,
							message: "approver must be lowercase letters",
						}),
					),
	},
	// The install half neither receives events nor carries a turn, so both of the
	// other halves die rather than pretending: a test that reaches one of them is
	// testing the wrong thing.
	outbound: {
		connectorId: TEST_CONNECTOR,
		limits: { maxMessageChars: 1000, minEditInterval: Duration.millis(500) },
		requiredConfig: [],
		transport: Effect.die("the install flow reached the outbound transport"),
	},
	ingress: socketIngress({
		requiredConfig: [],
		stateSchema: Schema.String,
		initialState: "",
		connectUrl: () => "wss://chat.test/gateway",
		onOpen: unreachableStep,
		onFrame: unreachableStep,
		onClose: unreachableStep,
		heartbeat: unreachableStep,
	}),
}

/**
 * The same fake connector plus the identity half, for a platform that CAN say who clicked.
 *
 * `complete` reads the account out of the callback the test wrote, standing in for the id a real
 * connector reads back from the platform with the grant. The tests below write a second, rival
 * user id into the same callback — the point being that nothing there reaches the stored row.
 */
const identityConnector: ChatConnector = {
	...testConnector,
	id: IDENTITY_CONNECTOR,
	manifest: { ...testConnector.manifest, id: IDENTITY_CONNECTOR },
	identity: {
		authorizeUrl: ({ state, redirectUri }) =>
			Effect.succeed(`https://chat.test/identity?state=${state}&redirect_uri=${redirectUri}`),
		complete: ({ params }) =>
			Effect.succeed({
				externalUserId: params.get("account") ?? "account-default",
				displayName: params.get("display") ?? undefined,
			}),
	},
}

/** A workspace whose platform no longer honours the bot's grant. */
const REVOKED_WORKSPACE = "workspace-revoked"

/** A workspace the bot was removed from. */
const KICKED_WORKSPACE = "workspace-kicked"

/**
 * The fake connector with an outbound half that can answer where alerts may go: it lists one
 * channel per workspace, named after the platform's own workspace id so a test can see which one
 * it was asked about, and refuses the grant for {@link REVOKED_WORKSPACE}.
 */
const unreachable = () => Effect.die("the destination listing reached another transport method")
const listingTransport: ChatOutboundTransport = {
	post: unreachable,
	edit: unreachable,
	typing: unreachable,
	openThread: unreachable,
	conversation: unreachable,
	history: unreachable,
	destinations: (workspaceId) =>
		workspaceId === KICKED_WORKSPACE
			? Effect.fail(
					new ChatOutboundError({
						message: "Test Chat answered 404",
						connectorId: TEST_CONNECTOR,
						operation: "destinations",
						reason: "not_found",
					}),
				)
			: workspaceId === REVOKED_WORKSPACE
				? Effect.fail(
						new ChatOutboundError({
							message: "Test Chat refused the call: missing_scope",
							connectorId: TEST_CONNECTOR,
							operation: "destinations",
							reason: "auth",
						}),
					)
				: Effect.succeed([{ id: `${workspaceId}-alerts`, name: "alerts", private: false }]),
}
const listingConnector: ChatConnector = {
	...testConnector,
	outbound: { ...testConnector.outbound, transport: Effect.succeed(listingTransport) },
}

/** The same connector, needing a deployment-wide credential no test config sets. */
const unconfiguredListingConnector: ChatConnector = {
	...listingConnector,
	outbound: {
		...listingConnector.outbound,
		requiredConfig: [{ name: "MAPLE_TESTCHAT_UNSET_OUTBOUND_KEY", secret: true }],
	},
}

const makeConfig = (withConnectorConfig: boolean) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			MAPLE_APP_BASE_URL: "https://web.localhost",
			// Every config name the shipped registry declares, so `available` is true
			// for the fake connector and the real ones alike.
			...(withConnectorConfig
				? Object.fromEntries(chatConnectorConfigNames.map((name) => [name, `${name}-value`]))
				: undefined),
		}),
	)

const makeLayer = (
	testDb: TestDb,
	options?: { readonly configured?: boolean; readonly registry?: ReadonlyArray<RegisteredChatConnector> },
) =>
	Layer.effect(ChatWorkspaceService, ChatWorkspaceService.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		// Merged, not just provided: the state-row assertions read the repository too.
		Layer.provideMerge(OAuthStateRepository.layer),
		Layer.provide(Layer.succeed(ChatConnectorRegistry, options?.registry ?? [testConnector])),
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(makeConfig(options?.configured ?? true)),
	)

/** Link a workspace directly, for the paths that start from one already linked. */
const insertWorkspace = (testDb: TestDb, id: string, orgId: string, externalWorkspaceId: string) =>
	Effect.promise(() =>
		executeSql(
			testDb,
			`insert into chat_workspaces (id, org_id, connector, external_workspace_id, name, settings, created_at)
			 values ($1, $2, $3, $4, $5, '{}'::jsonb, now())`,
			[id, orgId, TEST_CONNECTOR, externalWorkspaceId, "Test workspace"],
		),
	).pipe(Effect.as(Schema.decodeSync(ChatWorkspaceId)(id)))

const stateFrom = (url: string): string => new URL(url).searchParams.get("state") ?? ""

const callback = (state: string, workspace: string, name?: string) =>
	new URLSearchParams({ state, workspace, ...(name === undefined ? undefined : { name }) })

/** A link callback, plus whatever else a test wants to see ignored. */
const identityCallback = (state: string, account: string, extra?: Record<string, string>) =>
	new URLSearchParams({ state, account, ...extra })

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

describe("ChatWorkspaceService", () => {
	it.effect("lists every registered connector, with the org's workspaces", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			const id = yield* insertWorkspace(
				testDb,
				"11111111-1111-4111-8111-111111111111",
				ORG,
				"workspace-1",
			)
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				const statuses = yield* chat.list(ORG)
				assert.strictEqual(statuses.length, 1)
				const status = statuses[0]
				assert.isTrue(status?.available)
				assert.deepStrictEqual(
					status?.workspaces.map((workspace) => workspace.id),
					[id],
				)
			}).pipe(Effect.provide(makeLayer(testDb)))
		}),
	)

	it.effect("lists the connectors Maple actually ships when nothing substitutes them", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				const statuses = yield* chat.list(ORG)
				// The default registry is the real one, and every connector's declared
				// config is set above — so the host reports each as installable.
				assert.strictEqual(statuses.length, connectors.length)
				assert.isTrue(statuses.every((status) => status.available))
			}).pipe(Effect.provide(makeLayer(testDb, { registry: connectors })))
		}),
	)

	it.effect("reports a connector as unavailable when its config is absent", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				const statuses = yield* chat.list(ORG)
				assert.isTrue(statuses.every((status) => !status.available))
			}).pipe(Effect.provide(makeLayer(testDb, { configured: false })))
		}),
	)

	it.effect("lists where an alert can go in the org's own workspace", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			const id = yield* insertWorkspace(
				testDb,
				"11111111-1111-4111-8111-111111111111",
				ORG,
				"workspace-1",
			)
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				// The platform is asked about ITS workspace id, not Maple's row id.
				assert.deepStrictEqual(yield* chat.listDestinations(ORG, id), [
					{ id: "workspace-1-alerts", name: "alerts", private: false },
				])
				// Another org holding the id learns nothing about the workspace.
				const failure = yield* chat.listDestinations(OTHER_ORG, id).pipe(Effect.flip)
				assert.strictEqual(failure._tag, "@maple/http/errors/IntegrationsNotFoundError")
			}).pipe(Effect.provide(makeLayer(testDb, { registry: [listingConnector] })))
		}),
	)

	it.effect("asks for a reinstall when the platform refuses the bot's grant", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			const id = yield* insertWorkspace(
				testDb,
				"22222222-2222-4222-8222-222222222222",
				ORG,
				REVOKED_WORKSPACE,
			)
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				const failure = yield* chat.listDestinations(ORG, id).pipe(Effect.flip)
				assert.strictEqual(failure._tag, "@maple/http/errors/IntegrationsNotConnectedError")
				assert.include(failure.message, "Reinstall Test Chat")
			}).pipe(Effect.provide(makeLayer(testDb, { registry: [listingConnector] })))
		}),
	)

	it.effect("asks for a reinstall when the bot was removed from the workspace", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			const id = yield* insertWorkspace(
				testDb,
				"44444444-4444-4444-8444-444444444444",
				ORG,
				KICKED_WORKSPACE,
			)
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				const failure = yield* chat.listDestinations(ORG, id).pipe(Effect.flip)
				assert.strictEqual(failure._tag, "@maple/http/errors/IntegrationsNotConnectedError")
				assert.include(failure.message, "no longer in this workspace")
			}).pipe(Effect.provide(makeLayer(testDb, { registry: [listingConnector] })))
		}),
	)

	it.effect("reports a deployment without the connector's outbound config, before any request", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			const id = yield* insertWorkspace(
				testDb,
				"55555555-5555-4555-8555-555555555555",
				ORG,
				"workspace-1",
			)
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				const failure = yield* chat.listDestinations(ORG, id).pipe(Effect.flip)
				assert.strictEqual(failure._tag, "@maple/http/errors/IntegrationsConfigurationError")
			}).pipe(Effect.provide(makeLayer(testDb, { registry: [unconfiguredListingConnector] })))
		}),
	)

	it.effect("refuses an install for a connector nobody ships", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				const failure = yield* chat.beginInstall(ORG, USER, UNREGISTERED, CALLBACK).pipe(Effect.flip)
				assert.strictEqual(failure._tag, "@maple/http/errors/IntegrationsNotFoundError")
			}).pipe(Effect.provide(makeLayer(testDb)))
		}),
	)

	it.effect("refuses an install the deployment has no config for, and writes no state", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				const failure = yield* chat
					.beginInstall(ORG, USER, TEST_CONNECTOR, CALLBACK)
					.pipe(Effect.flip)
				assert.strictEqual(failure._tag, "@maple/http/errors/IntegrationsConfigurationError")
				// No state row for an install that can never be completed.
				const states = yield* Effect.promise(() =>
					queryFirstRow<{ count: number }>(
						testDb,
						"select count(*)::int as count from oauth_auth_states",
					),
				)
				assert.strictEqual(states?.count, 0)
			}).pipe(Effect.provide(makeLayer(testDb, { configured: false })))
		}),
	)

	it.effect("mints an authorize URL and a state row namespaced per connector", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				const { url } = yield* chat.beginInstall(ORG, USER, TEST_CONNECTOR, CALLBACK)
				const states = yield* OAuthStateRepository
				const stored = yield* states.findByState(stateFrom(url))
				assert.isTrue(Option.isSome(stored))
				assert.strictEqual(Option.getOrUndefined(stored)?.provider, `chat:${TEST_CONNECTOR}`)
			}).pipe(Effect.provide(makeLayer(testDb)))
		}),
	)

	it.effect("links the workspace the connector vouched for, once", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				const { url } = yield* chat.beginInstall(ORG, USER, TEST_CONNECTOR, CALLBACK)
				const state = stateFrom(url)
				const linked = yield* chat.completeInstall(
					TEST_CONNECTOR,
					callback(state, "workspace-7", "Acme"),
				)
				assert.strictEqual(linked.orgId, ORG)
				assert.strictEqual(linked.name, "Acme")
				const statuses = yield* chat.list(ORG)
				assert.deepStrictEqual(
					statuses[0]?.workspaces.map((workspace) => workspace.externalWorkspaceId),
					["workspace-7"],
				)
				// Single-use: the same callback replayed is not a second link.
				const replay = yield* chat
					.completeInstall(TEST_CONNECTOR, callback(state, "workspace-7", "Acme"))
					.pipe(Effect.flip)
				assert.strictEqual(replay._tag, "@maple/http/errors/IntegrationsValidationError")
			}).pipe(Effect.provide(makeLayer(testDb)))
		}),
	)

	it.effect("refuses a callback with no state, an unknown state, and an expired one", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				const missing = yield* chat
					.completeInstall(TEST_CONNECTOR, new URLSearchParams({ workspace: "workspace-8" }))
					.pipe(Effect.flip)
				assert.strictEqual(missing._tag, "@maple/http/errors/IntegrationsValidationError")

				const unknown = yield* chat
					.completeInstall(TEST_CONNECTOR, callback("never-issued", "workspace-8"))
					.pipe(Effect.flip)
				assert.strictEqual(unknown._tag, "@maple/http/errors/IntegrationsValidationError")

				const { url } = yield* chat.beginInstall(ORG, USER, TEST_CONNECTOR, CALLBACK)
				yield* TestClock.adjust(STATE_TTL_MS + 1)
				const expired = yield* chat
					.completeInstall(TEST_CONNECTOR, callback(stateFrom(url), "workspace-8"))
					.pipe(Effect.flip)
				assert.strictEqual(expired._tag, "@maple/http/errors/IntegrationsValidationError")
				const statuses = yield* chat.list(ORG)
				assert.deepStrictEqual(statuses[0]?.workspaces, [])
			}).pipe(Effect.provide(makeLayer(testDb)))
		}),
	)

	it.effect("refuses to move a workspace another organization already linked", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			yield* insertWorkspace(testDb, "55555555-5555-4555-8555-555555555555", OTHER_ORG, "workspace-9")
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				const { url } = yield* chat.beginInstall(ORG, USER, TEST_CONNECTOR, CALLBACK)
				const failure = yield* chat
					.completeInstall(TEST_CONNECTOR, callback(stateFrom(url), "workspace-9"))
					.pipe(Effect.flip)
				assert.strictEqual(failure._tag, "@maple/http/errors/IntegrationsForbiddenError")
				// The other org keeps it, and the bot still resolves it to them.
				const resolved = yield* chat.resolve(TEST_CONNECTOR, "workspace-9")
				assert.strictEqual(Option.getOrUndefined(resolved)?.orgId, OTHER_ORG)
			}).pipe(Effect.provide(makeLayer(testDb)))
		}),
	)

	it.effect("refreshes the org's own workspace on a re-install, keeping its settings", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			const id = yield* insertWorkspace(
				testDb,
				"66666666-6666-4666-8666-666666666666",
				ORG,
				"workspace-10",
			)
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				yield* chat.updateSettings(ORG, id, { approver: "moderators" })
				const { url } = yield* chat.beginInstall(ORG, USER, TEST_CONNECTOR, CALLBACK)
				yield* chat.completeInstall(
					TEST_CONNECTOR,
					callback(stateFrom(url), "workspace-10", "Renamed"),
				)
				const statuses = yield* chat.list(ORG)
				const workspace = statuses[0]?.workspaces[0]
				assert.strictEqual(workspace?.id, id, "the same row, not a second link")
				assert.strictEqual(workspace?.name, "Renamed")
				assert.deepStrictEqual(workspace?.settings, { approver: "moderators" })
			}).pipe(Effect.provide(makeLayer(testDb)))
		}),
	)

	it.effect("validates settings through the connector and stores what it returns", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			const id = yield* insertWorkspace(
				testDb,
				"22222222-2222-4222-8222-222222222222",
				ORG,
				"workspace-2",
			)
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				const saved = yield* chat.updateSettings(ORG, id, { approver: "moderators" })
				assert.deepStrictEqual(saved.settings, { approver: "moderators" })
				// Read back through the path the bot uses, not just the write's return.
				const resolved = yield* chat.resolve(TEST_CONNECTOR, "workspace-2")
				assert.deepStrictEqual(Option.getOrUndefined(resolved)?.settings, { approver: "moderators" })
				// Blank values are dropped before the connector sees them, so an
				// emptied text field reads as "unset" for every connector.
				const cleared = yield* chat.updateSettings(ORG, id, { approver: "   " })
				assert.deepStrictEqual(cleared.settings, {})
				const failure = yield* chat.updateSettings(ORG, id, { approver: "ADMINS" }).pipe(Effect.flip)
				assert.strictEqual(failure._tag, "@maple/http/errors/IntegrationsValidationError")
			}).pipe(Effect.provide(makeLayer(testDb)))
		}),
	)

	it.effect("scopes settings and unlink to the owning org", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			const id = yield* insertWorkspace(
				testDb,
				"33333333-3333-4333-8333-333333333333",
				ORG,
				"workspace-3",
			)
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				const settingsFailure = yield* chat.updateSettings(OTHER_ORG, id, {}).pipe(Effect.flip)
				assert.strictEqual(settingsFailure._tag, "@maple/http/errors/IntegrationsNotFoundError")
				const uninstallFailure = yield* chat.uninstall(OTHER_ORG, id).pipe(Effect.flip)
				assert.strictEqual(uninstallFailure._tag, "@maple/http/errors/IntegrationsNotFoundError")
				yield* chat.uninstall(ORG, id)
				const statuses = yield* chat.list(ORG)
				assert.isTrue(statuses.every((status) => status.workspaces.length === 0))
				// Unlinked means the bot stops resolving it — that is what uninstall buys.
				const resolved = yield* chat.resolve(TEST_CONNECTOR, "workspace-3")
				assert.isTrue(Option.isNone(resolved))
			}).pipe(Effect.provide(makeLayer(testDb)))
		}),
	)

	it.effect("resolves a workspace to its org for the bot, and nothing else", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			yield* insertWorkspace(testDb, "44444444-4444-4444-8444-444444444444", ORG, "workspace-4")
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				const resolved = yield* chat.resolve(TEST_CONNECTOR, "workspace-4")
				assert.strictEqual(Option.getOrUndefined(resolved)?.orgId, ORG)
				const missing = yield* chat.resolve(TEST_CONNECTOR, "workspace-unknown")
				assert.isTrue(Option.isNone(missing))
			}).pipe(Effect.provide(makeLayer(testDb)))
		}),
	)

	it.effect("stores a connector's per-workspace credential sealed, and hands it back decrypted", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				const { url } = yield* chat.beginInstall(ORG, USER, TEST_CONNECTOR, CALLBACK)
				const params = callback(stateFrom(url), "workspace-cred", "Acme")
				params.set("credentials", '{"token":"a-workspaces-own-token"}')
				yield* chat.completeInstall(TEST_CONNECTOR, params)

				const resolved = yield* chat.resolve(TEST_CONNECTOR, "workspace-cred")
				assert.strictEqual(
					Option.getOrUndefined(resolved)?.credentials,
					'{"token":"a-workspaces-own-token"}',
				)
				// Sealed at rest: the column holds no plaintext for anyone reading the table.
				const row = yield* Effect.promise(() =>
					queryFirstRow<{ credentials_ciphertext: string | null }>(
						testDb,
						"select credentials_ciphertext from chat_workspaces where external_workspace_id = 'workspace-cred'",
					),
				)
				assert.isString(row?.credentials_ciphertext)
				assert.notInclude(row?.credentials_ciphertext ?? "", "token")
			}).pipe(Effect.provide(makeLayer(testDb)))
		}),
	)

	it.effect("resolves a connector that stores no credential with none", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				const { url } = yield* chat.beginInstall(ORG, USER, TEST_CONNECTOR, CALLBACK)
				yield* chat.completeInstall(TEST_CONNECTOR, callback(stateFrom(url), "workspace-plain"))
				const resolved = yield* chat.resolve(TEST_CONNECTOR, "workspace-plain")
				assert.isTrue(Option.isSome(resolved))
				assert.isUndefined(Option.getOrUndefined(resolved)?.credentials)
			}).pipe(Effect.provide(makeLayer(testDb)))
		}),
	)

	it.effect("refuses an account link for a connector that cannot say who clicked", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				const failure = yield* chat
					.beginLink(ORG, USER, TEST_CONNECTOR, IDENTITY_CALLBACK)
					.pipe(Effect.flip)
				assert.strictEqual(failure._tag, "@maple/http/errors/IntegrationsNotFoundError")
				// And the card is told as much rather than being left to guess.
				const statuses = yield* chat.list(ORG, USER)
				assert.isFalse(statuses[0]?.supportsIdentity)
			}).pipe(Effect.provide(makeLayer(testDb)))
		}),
	)

	it.effect("mints a link state under the identity namespace, not the install's", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				const { url } = yield* chat.beginLink(ORG, USER, IDENTITY_CONNECTOR, IDENTITY_CALLBACK)
				const states = yield* OAuthStateRepository
				const stored = yield* states.findByState(stateFrom(url))
				assert.strictEqual(
					Option.getOrUndefined(stored)?.provider,
					`chat_identity:${IDENTITY_CONNECTOR}`,
				)
				assert.strictEqual(Option.getOrUndefined(stored)?.initiatedByUserId, USER)
			}).pipe(Effect.provide(makeLayer(testDb, { registry: [identityConnector] })))
		}),
	)

	it.effect("binds the chat account to the user who STARTED the link, not the callback", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				const { url } = yield* chat.beginLink(ORG, USER, IDENTITY_CONNECTOR, IDENTITY_CALLBACK)
				const linked = yield* chat.completeLink(
					IDENTITY_CONNECTOR,
					// A rival Maple user named in the callback, which is exactly the thing
					// that must not be read: the state row is the only authority here.
					identityCallback(stateFrom(url), "account-1", {
						display: "ada",
						user_id: OTHER_USER,
						org_id: OTHER_ORG,
					}),
				)
				assert.strictEqual(linked.orgId, ORG)
				assert.strictEqual(linked.displayName, "ada")

				const mine = yield* chat.list(ORG, USER)
				assert.isTrue(mine[0]?.supportsIdentity)
				assert.strictEqual(mine[0]?.identity?.externalUserId, "account-1")
				assert.strictEqual(mine[0]?.identity?.userId, USER)
				// The user the callback named holds nothing.
				const theirs = yield* chat.list(ORG, OTHER_USER)
				assert.isUndefined(theirs[0]?.identity)
				// And a list nobody is asking on behalf of reports no link at all.
				const anonymous = yield* chat.list(ORG)
				assert.isUndefined(anonymous[0]?.identity)
			}).pipe(Effect.provide(makeLayer(testDb, { registry: [identityConnector] })))
		}),
	)

	it.effect("keeps the install and link state namespaces from redeeming each other", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				const install = yield* chat.beginInstall(ORG, USER, IDENTITY_CONNECTOR, CALLBACK)
				const asLink = yield* chat
					.completeLink(IDENTITY_CONNECTOR, identityCallback(stateFrom(install.url), "account-2"))
					.pipe(Effect.flip)
				assert.strictEqual(asLink._tag, "@maple/http/errors/IntegrationsValidationError")

				const link = yield* chat.beginLink(ORG, USER, IDENTITY_CONNECTOR, IDENTITY_CALLBACK)
				const asInstall = yield* chat
					.completeInstall(IDENTITY_CONNECTOR, callback(stateFrom(link.url), "workspace-11"))
					.pipe(Effect.flip)
				assert.strictEqual(asInstall._tag, "@maple/http/errors/IntegrationsValidationError")

				const statuses = yield* chat.list(ORG, USER)
				assert.isUndefined(statuses[0]?.identity)
				assert.deepStrictEqual(statuses[0]?.workspaces, [])
			}).pipe(Effect.provide(makeLayer(testDb, { registry: [identityConnector] })))
		}),
	)

	it.effect("refuses a link state that has expired", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				const { url } = yield* chat.beginLink(ORG, USER, IDENTITY_CONNECTOR, IDENTITY_CALLBACK)
				yield* TestClock.adjust(STATE_TTL_MS + 1)
				const expired = yield* chat
					.completeLink(IDENTITY_CONNECTOR, identityCallback(stateFrom(url), "account-3"))
					.pipe(Effect.flip)
				assert.strictEqual(expired._tag, "@maple/http/errors/IntegrationsValidationError")
				const statuses = yield* chat.list(ORG, USER)
				assert.isUndefined(statuses[0]?.identity)
			}).pipe(Effect.provide(makeLayer(testDb, { registry: [identityConnector] })))
		}),
	)

	it.effect("forgets a workspace the bot was removed from, by the platform's own id", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			yield* insertWorkspace(testDb, "55555555-5555-4555-8555-555555555555", ORG, "workspace-5")
			yield* Effect.gen(function* () {
				const database = yield* Database
				assert.isTrue(yield* forgetChatWorkspace(database, TEST_CONNECTOR, "workspace-5"))
				assert.isTrue(
					Option.isNone(yield* resolveChatWorkspace(database, TEST_CONNECTOR, "workspace-5")),
				)
				// A removal nobody linked is not a failure — the bot can be added and removed from a
				// workspace that never reached Maple at all.
				assert.isFalse(yield* forgetChatWorkspace(database, TEST_CONNECTOR, "workspace-5"))
			}).pipe(Effect.provide(testDb.layer))
		}),
	)
})
