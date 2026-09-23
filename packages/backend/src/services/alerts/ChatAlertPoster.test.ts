import { afterEach, assert, describe, it } from "@effect/vitest"
import {
	chatConnectorId,
	chatConnectorOutboundConfigKeys,
	ChatOutboundError,
	ConnectorCredentials,
	socketIngress,
	WORKSPACE_CREDENTIALS,
	type ChatBlock,
	type ChatTarget,
} from "@maple/chat-platform"
import { ChatWorkspaceId, OrgId } from "@maple/domain/http"
import { ConfigProvider, Duration, Effect, Layer, Schema } from "effect"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import { Env } from "@maple/backend/platform/Env"
import { sealChatWorkspaceCredentials } from "@maple/backend/services/integrations/chat-workspace-credentials"
import {
	ChatConnectorRegistry,
	type RegisteredChatConnector,
} from "@maple/backend/services/integrations/chat-outbound"
import { ChatAlertPoster } from "./ChatAlertPoster"

/**
 * The `chat` destination's reach into a linked workspace, against a fake connector: which
 * workspace a destination may post into, and what the connector is handed to post with.
 */

const ORG = Schema.decodeSync(OrgId)("org_chat_alerts_1")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_chat_alerts_2")
const TESTCHAT = chatConnectorId("testchat")
const KEY = Buffer.alloc(32, 7)
const WORKSPACE = Schema.decodeSync(ChatWorkspaceId)("11111111-1111-4111-8111-111111111111")
const REVOKED = Schema.decodeSync(ChatWorkspaceId)("22222222-2222-4222-8222-222222222222")

/** A deployment-wide outbound key the host already resolves, so it reaches `Env`. */
const OUTBOUND_KEY = chatConnectorOutboundConfigKeys[0]?.name ?? "CHAT_OUTBOUND_KEY_MISSING"

interface Posted {
	readonly target: ChatTarget
	readonly blocks: ReadonlyArray<ChatBlock>
	readonly config: ReadonlyMap<string, string>
}

const unreachable = () => Effect.die("the alert reached another transport method")

const makeConnector = (posted: Array<Posted>): RegisteredChatConnector => ({
	id: TESTCHAT,
	manifest: {
		id: TESTCHAT,
		name: "Test Chat",
		description: "A connector that exists only in this test.",
		icon: { viewBox: "0 0 24 24", paths: [] },
		accent: "#000000",
		settingsFields: [],
	},
	install: {
		requiredConfig: [],
		authorizeUrl: unreachable,
		complete: unreachable,
		decodeSettings: unreachable,
	},
	outbound: {
		connectorId: TESTCHAT,
		limits: { maxMessageChars: 1000, minEditInterval: Duration.millis(500) },
		requiredConfig: [],
		transport: Effect.gen(function* () {
			const config = yield* ConnectorCredentials
			return {
				post: (target, blocks) =>
					target.workspaceId === "workspace-revoked"
						? Effect.fail(
								new ChatOutboundError({
									message: "Test Chat refused the call: token_revoked",
									connectorId: TESTCHAT,
									operation: "post",
									reason: "auth",
								}),
							)
						: Effect.sync(() => {
								posted.push({ target, blocks, config })
								return { target, messageId: "message-1" }
							}),
				edit: unreachable,
				typing: unreachable,
				openThread: unreachable,
				conversation: unreachable,
				history: unreachable,
				destinations: unreachable,
			}
		}),
	},
	ingress: socketIngress({
		requiredConfig: [],
		stateSchema: Schema.String,
		initialState: "",
		connectUrl: () => "wss://chat.test/gateway",
		onOpen: (state) => ({ state }),
		onFrame: (state) => ({ state }),
		onClose: (state) => ({ state }),
		heartbeat: (state) => ({ state }),
	}),
})

const config = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		PORT: "3472",
		TINYBIRD_HOST: "https://api.tinybird.co",
		TINYBIRD_TOKEN: "test-token",
		MAPLE_AUTH_MODE: "self_hosted",
		MAPLE_ROOT_PASSWORD: "test-root-password",
		MAPLE_DEFAULT_ORG_ID: "default",
		MAPLE_INGEST_KEY_ENCRYPTION_KEY: KEY.toString("base64"),
		MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		MAPLE_APP_BASE_URL: "https://web.localhost",
		[OUTBOUND_KEY]: "deployment-wide-value",
	}),
)

const makeLayer = (testDb: TestDb, posted: Array<Posted>) =>
	ChatAlertPoster.layer.pipe(
		Layer.provide(Layer.succeed(ChatConnectorRegistry, [makeConnector(posted)])),
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(config),
	)

/** Link a workspace with a sealed credential, as a completed install leaves it. */
const linkWorkspace = (testDb: TestDb, id: ChatWorkspaceId, externalWorkspaceId: string) =>
	Effect.gen(function* () {
		const sealed = yield* sealChatWorkspaceCredentials(
			"a-workspaces-own-token",
			KEY,
			{ orgId: ORG, connector: TESTCHAT, externalWorkspaceId },
			(message) => new Error(message),
		).pipe(Effect.orDie)
		yield* Effect.promise(() =>
			executeSql(
				testDb,
				`insert into chat_workspaces (id, org_id, connector, external_workspace_id, name, settings,
				   credentials_ciphertext, credentials_iv, credentials_tag, created_at)
				 values ($1, $2, $3, $4, 'Acme', '{}'::jsonb, $5, $6, $7, now())`,
				[id, ORG, TESTCHAT, externalWorkspaceId, sealed.ciphertext, sealed.iv, sealed.tag],
			),
		)
	})

const blocks: ReadonlyArray<ChatBlock> = [{ kind: "prose", markdown: "**Checkout error rate** — Triggered" }]

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

describe("ChatAlertPoster", () => {
	it.effect("posts through the workspace's connector, with its own credential", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			const posted: Array<Posted> = []
			yield* linkWorkspace(testDb, WORKSPACE, "workspace-1")
			yield* Effect.gen(function* () {
				const poster = yield* ChatAlertPoster
				const result = yield* poster.post({
					orgId: ORG,
					workspaceId: WORKSPACE,
					channelId: "channel-1",
					blocks,
				})
				assert.deepStrictEqual(result, { connectorName: "Test Chat", messageId: "message-1" })
				// The platform's own workspace id, never Maple's row id.
				assert.deepStrictEqual(posted[0]?.target, {
					workspaceId: "workspace-1",
					channelId: "channel-1",
				})
				assert.strictEqual(posted[0]?.config.get(WORKSPACE_CREDENTIALS), "a-workspaces-own-token")
				assert.strictEqual(posted[0]?.config.get(OUTBOUND_KEY), "deployment-wide-value")
			}).pipe(Effect.provide(makeLayer(testDb, posted)))
		}),
	)

	it.effect("never reaches a workspace another org linked", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			const posted: Array<Posted> = []
			yield* linkWorkspace(testDb, WORKSPACE, "workspace-1")
			yield* Effect.gen(function* () {
				const poster = yield* ChatAlertPoster
				const failure = yield* poster
					.post({ orgId: OTHER_ORG, workspaceId: WORKSPACE, channelId: "channel-1", blocks })
					.pipe(Effect.flip)
				assert.strictEqual(failure._tag, "@maple/http/errors/AlertDeliveryTargetMissingError")
				assert.isFalse(failure.error.retryable)
				assert.lengthOf(posted, 0)
			}).pipe(Effect.provide(makeLayer(testDb, posted)))
		}),
	)

	it.effect("reports a grant the platform refused as an auth failure", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			yield* linkWorkspace(testDb, REVOKED, "workspace-revoked")
			yield* Effect.gen(function* () {
				const poster = yield* ChatAlertPoster
				const failure = yield* poster
					.post({ orgId: ORG, workspaceId: REVOKED, channelId: "channel-1", blocks })
					.pipe(Effect.flip)
				assert.strictEqual(failure._tag, "@maple/http/errors/AlertDeliveryAuthError")
			}).pipe(Effect.provide(makeLayer(testDb, [])))
		}),
	)
})
