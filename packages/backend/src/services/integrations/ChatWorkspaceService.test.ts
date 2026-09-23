import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Duration, Effect, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import { ChatConnectorId, ChatWorkspaceId, OrgId, UserId } from "@maple/domain/http"
import {
	chatConnectorConfigNames,
	ChatConnectorNotConfigured,
	ChatSettingsRejected,
	socketIngress,
	type ChatConnector,
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
import { ChatConnectorRegistry, ChatWorkspaceService } from "./ChatWorkspaceService"

/**
 * The host half of the chat-platform contract, driven by a fake connector: no
 * chat platform is named here, nothing reaches the network, and every branch of
 * the install flow is reachable. A connector added tomorrow changes none of it.
 */

const ORG = Schema.decodeSync(OrgId)("org_chat_1")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_chat_2")
const USER = Schema.decodeSync(UserId)("user_chat_1")
const TEST_CONNECTOR = Schema.decodeSync(ChatConnectorId)("testchat")
const UNREGISTERED = Schema.decodeSync(ChatConnectorId)("nosuchchat")
const CALLBACK = "https://api.localhost/oauth/chat/testchat/callback"

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
	options?: { readonly configured?: boolean; readonly registry?: ReadonlyArray<ChatConnector<unknown>> },
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
