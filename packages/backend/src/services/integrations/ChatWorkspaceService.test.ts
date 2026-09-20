import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { ChatConnectorId, ChatWorkspaceId, OrgId, UserId } from "@maple/domain/http"
import { connectors } from "@maple/chat-platform"
import { Env } from "@maple/backend/platform/Env"
import { OAuthStateRepository } from "@maple/backend/services/auth/OAuthStateRepository"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import { ChatWorkspaceService } from "./ChatWorkspaceService"

/**
 * The host half of the chat-platform contract: no chat platform is named here,
 * and the config the test supplies is built from whatever the registered
 * connectors declared. A connector added tomorrow runs these same assertions.
 */

const ORG = Schema.decodeSync(OrgId)("org_chat_1")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_chat_2")
const USER = Schema.decodeSync(UserId)("user_chat_1")
const UNREGISTERED = Schema.decodeSync(ChatConnectorId)("testchat")
const CALLBACK = "https://api.localhost/oauth/chat/callback"

/** The first registered connector, whichever it is. */
const connector = connectors[0]
if (connector === undefined) throw new Error("No chat connector is registered")

/** Every config name the registry declares, filled with a placeholder value. */
const connectorConfig = Object.fromEntries(
	connectors.flatMap((entry) => entry.install.requiredConfig.map((name) => [name, `${name}-value`])),
)

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
			...(withConnectorConfig ? connectorConfig : undefined),
		}),
	)

const makeLayer = (testDb: TestDb, withConnectorConfig = true) =>
	Layer.effect(ChatWorkspaceService, ChatWorkspaceService.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		// Merged, not just provided: the state-row assertion reads the repository too.
		Layer.provideMerge(OAuthStateRepository.layer),
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(makeConfig(withConnectorConfig)),
	)

/** Link a workspace directly — `completeInstall` needs the real platform. */
const insertWorkspace = (testDb: TestDb, id: string, orgId: string, externalWorkspaceId: string) =>
	Effect.promise(() =>
		executeSql(
			testDb,
			`insert into chat_workspaces (id, org_id, connector, external_workspace_id, name, settings, created_at)
			 values ($1, $2, $3, $4, $5, '{}'::jsonb, now())`,
			[id, orgId, connector.id, externalWorkspaceId, "Test workspace"],
		),
	).pipe(Effect.as(Schema.decodeSync(ChatWorkspaceId)(id)))

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
				assert.strictEqual(statuses.length, connectors.length)
				const status = statuses.find((entry) => entry.connector.id === connector.id)
				assert.isTrue(status?.available)
				assert.deepStrictEqual(
					status?.workspaces.map((workspace) => workspace.id),
					[id],
				)
			}).pipe(Effect.provide(makeLayer(testDb)))
		}),
	)

	it.effect("reports a connector as unavailable when its config is absent", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				const statuses = yield* chat.list(ORG)
				assert.isTrue(statuses.every((status) => !status.available))
			}).pipe(Effect.provide(makeLayer(testDb, false)))
		}),
	)

	it.effect("mints an authorize URL and a state row namespaced per connector", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				const { url } = yield* chat.beginInstall(ORG, USER, connector.id, CALLBACK)
				const state = new URL(url).searchParams.get("state")
				assert.isNotNull(state)
				const states = yield* OAuthStateRepository
				const stored = yield* states.findByState(state ?? "")
				assert.strictEqual(Option.getOrUndefined(stored)?.provider, `chat:${connector.id}`)
			}).pipe(Effect.provide(makeLayer(testDb)))
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
				// Blank values are dropped before the connector sees them, so an
				// emptied text field reads as "unset" for every connector.
				const updated = yield* chat.updateSettings(ORG, id, { unused_field: "   " })
				assert.deepStrictEqual(updated.settings, {})
				// A key no connector defines is a rejection, not a silent write.
				const failure = yield* chat
					.updateSettings(ORG, id, { definitely_not_a_setting: "x" })
					.pipe(Effect.flip)
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
			}).pipe(Effect.provide(makeLayer(testDb)))
		}),
	)

	it.effect("resolves a workspace to its org for the bot, and nothing else", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			yield* insertWorkspace(testDb, "44444444-4444-4444-8444-444444444444", ORG, "workspace-4")
			yield* Effect.gen(function* () {
				const chat = yield* ChatWorkspaceService
				const resolved = yield* chat.resolve(connector.id, "workspace-4")
				assert.strictEqual(Option.getOrUndefined(resolved)?.orgId, ORG)
				const missing = yield* chat.resolve(connector.id, "workspace-unknown")
				assert.isTrue(Option.isNone(missing))
			}).pipe(Effect.provide(makeLayer(testDb)))
		}),
	)
})
