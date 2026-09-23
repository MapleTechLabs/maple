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
import { ConfigProvider, Duration, Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import { Env } from "@maple/backend/platform/Env"
import { Database, DatabaseError } from "@maple/backend/platform/DatabaseLive"
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

/** `hang` is a platform that never answers the post. */
const makeConnector = (posted: Array<Posted>, hang = false): RegisteredChatConnector => ({
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
		requiredConfig: [{ name: OUTBOUND_KEY, secret: true }],
		transport: Effect.gen(function* () {
			const config = yield* yield* ConnectorCredentials
			return {
				post: (target, blocks) =>
					hang
						? Effect.never
						: target.workspaceId === "workspace-revoked"
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
				destinations: () =>
					Effect.succeed([
						{ id: "channel-1", name: "incidents", private: false },
						{ id: "channel-2", name: "oncall", private: true },
					]),
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

const config = (withOutboundConfig = true) =>
	ConfigProvider.layer(
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
			...(withOutboundConfig ? { [OUTBOUND_KEY]: "deployment-wide-value" } : undefined),
		}),
	)

const makeLayer = (
	testDb: TestDb | Layer.Layer<Database>,
	posted: Array<Posted>,
	options: { readonly outboundConfig?: boolean; readonly hang?: boolean } = {},
) =>
	ChatAlertPoster.layer.pipe(
		Layer.provide(Layer.succeed(ChatConnectorRegistry, [makeConnector(posted, options.hang)])),
		Layer.provide("layer" in testDb ? testDb.layer : testDb),
		Layer.provide(Env.layer),
		Layer.provide(config(options.outboundConfig)),
	)

/** Link a workspace with a sealed credential, as a completed install leaves it. */
const linkWorkspace = (testDb: TestDb, id: ChatWorkspaceId, externalWorkspaceId: string) =>
	Effect.gen(function* () {
		const sealed = yield* sealChatWorkspaceCredentials(
			"a-workspaces-own-token",
			KEY,
			{ orgId: ORG, connector: TESTCHAT, externalWorkspaceId },
			(message) => message,
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

const post = (orgId = ORG, workspaceId = WORKSPACE) =>
	Effect.gen(function* () {
		const poster = yield* ChatAlertPoster
		return yield* poster.post({ orgId, workspaceId, channelId: "channel-1", blocks })
	})

describe("ChatAlertPoster", () => {
	it.effect("keeps a failed workspace lookup retryable", () => {
		const failing = Layer.succeed(Database, {
			execute: () => Effect.fail(new DatabaseError({ message: "connection reset", cause: null })),
		})
		return Effect.gen(function* () {
			const failure = yield* post().pipe(Effect.flip)
			assert.strictEqual(failure._tag, "@maple/http/errors/AlertDeliveryError")
			assert.isTrue(failure.error.retryable)
		}).pipe(Effect.provide(makeLayer(failing, [])))
	})

	it.effect("keeps a deployment's missing connector config retryable, and posts nothing", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			const posted: Array<Posted> = []
			yield* linkWorkspace(testDb, WORKSPACE, "workspace-1")
			yield* Effect.gen(function* () {
				const failure = yield* post().pipe(Effect.flip)
				// Retryable, so no org's destination is disabled for this deployment's gap.
				assert.strictEqual(failure._tag, "@maple/http/errors/AlertDeliveryError")
				assert.isTrue(failure.error.retryable)
				assert.lengthOf(posted, 0)
			}).pipe(Effect.provide(makeLayer(testDb, posted, { outboundConfig: false })))
		}),
	)

	it.effect("times a platform that never answers out, retryably", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			yield* linkWorkspace(testDb, WORKSPACE, "workspace-1")
			yield* Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(post().pipe(Effect.flip))
				yield* TestClock.adjust("15 seconds")
				const failure = yield* Fiber.join(fiber)
				assert.strictEqual(failure._tag, "@maple/http/errors/AlertDeliveryError")
				assert.include(failure.message, "timed out")
			}).pipe(Effect.provide(makeLayer(testDb, [], { hang: true })))
		}),
	)

	it.effect("reports a credential that will not open as needing a reinstall", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			yield* linkWorkspace(testDb, WORKSPACE, "workspace-1")
			// Moved onto another workspace id: the envelope's AAD no longer matches its row.
			yield* Effect.promise(() =>
				executeSql(testDb, "update chat_workspaces set external_workspace_id = 'workspace-moved'"),
			)
			yield* Effect.gen(function* () {
				const failure = yield* post().pipe(Effect.flip)
				assert.strictEqual(failure._tag, "@maple/http/errors/AlertDeliveryAuthError")
				assert.include(failure.message, "reinstall")
			}).pipe(Effect.provide(makeLayer(testDb, [])))
		}),
	)

	it.effect("finds only a channel the org's workspace lists, and names it from the listing", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			yield* linkWorkspace(testDb, WORKSPACE, "workspace-1")
			yield* Effect.gen(function* () {
				const poster = yield* ChatAlertPoster
				assert.deepStrictEqual(yield* poster.findChannel(ORG, WORKSPACE, "channel-2"), {
					connector: TESTCHAT,
					workspaceName: "Acme",
					channelName: "oncall",
				})
				// A channel from somewhere else — the case a shared bot token would otherwise post to.
				const foreign = yield* poster.findChannel(ORG, WORKSPACE, "their-channel").pipe(Effect.flip)
				assert.strictEqual(foreign._tag, "@maple/http/errors/AlertValidationError")
				const otherOrg = yield* poster
					.findChannel(OTHER_ORG, WORKSPACE, "channel-1")
					.pipe(Effect.flip)
				assert.strictEqual(otherOrg._tag, "@maple/http/errors/AlertValidationError")
			}).pipe(Effect.provide(makeLayer(testDb, [])))
		}),
	)

	it.effect("refuses to confirm a channel on a deployment without the connector's config", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			yield* linkWorkspace(testDb, WORKSPACE, "workspace-1")
			yield* Effect.gen(function* () {
				const poster = yield* ChatAlertPoster
				const failure = yield* poster.findChannel(ORG, WORKSPACE, "channel-1").pipe(Effect.flip)
				assert.include(failure.message, "not configured")
			}).pipe(Effect.provide(makeLayer(testDb, [], { outboundConfig: false })))
		}),
	)

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
