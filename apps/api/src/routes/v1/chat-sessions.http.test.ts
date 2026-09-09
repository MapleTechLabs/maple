import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { WorkerEnvironment } from "@maple/infra/worker-runtime"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import type { ChatSessionStub } from "@/chat/session"
import { Env } from "@/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { AuthService } from "@/services/auth/AuthService"
import { ApiKeysService } from "@/services/org/ApiKeysService"
import { ChatSessionsRouter } from "./chat-sessions.http"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_chat")
const USER = Schema.decodeUnknownSync(UserId)("user_chat")
const INTERNAL_TOKEN = "chat-internal-service-token"
const SESSION_PATH = `/api/chat/sessions/${encodeURIComponent(`${ORG}:quick`)}`

const config = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		TINYBIRD_HOST: "https://api.tinybird.co",
		TINYBIRD_TOKEN: "test-token",
		MAPLE_AUTH_MODE: "self_hosted",
		MAPLE_ROOT_PASSWORD: "test-root-password",
		MAPLE_DEFAULT_ORG_ID: "default",
		MAPLE_APP_BASE_URL: "https://app.example.com",
		MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
		MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		INTERNAL_SERVICE_TOKEN: INTERNAL_TOKEN,
	}),
)

type BeginTurnInput = Parameters<ChatSessionStub["beginTurn"]>[0]

/** A `ChatSession` Durable Object that records the turns it is asked to start. */
const makeStub = (turns: Array<BeginTurnInput>): ChatSessionStub => ({
	cursor: () => Promise.resolve(0),
	running: () => Promise.resolve(false),
	history: () => Promise.resolve([]),
	since: () => Promise.resolve([]),
	subscribe: () => Promise.resolve(new ReadableStream<Uint8Array>()),
	append: () => Promise.resolve(0),
	beginTurn: (input) => {
		turns.push(input)
		return Promise.resolve({ cursor: turns.length, messageId: input.messageId })
	},
	holdsTurn: () => Promise.resolve(false),
	endTurn: () => Promise.resolve(),
	abort: () => Promise.resolve(),
})

/**
 * The router over the services production gives it, and nothing else in the request context:
 * every service a handler needs has to have been captured while the router was built. This is
 * the shape that answered every chat request with "Service not found" until it was.
 */
const makeRouterLayer = (testDb: TestDb, turns: Array<BeginTurnInput>) => {
	const base = Layer.mergeAll(testDb.layer, Env.layer.pipe(Layer.provide(config)))
	const workerEnv = Layer.succeed(WorkerEnvironment, {
		ChatSession: { idFromName: (name: string) => name, get: () => makeStub(turns) },
	})
	return ChatSessionsRouter.pipe(
		Layer.provide(
			Layer.mergeAll(
				ApiKeysService.layer.pipe(Layer.provide(base)),
				AuthService.layer.pipe(Layer.provide(base)),
				base,
				workerEnv,
			),
		),
	)
}

const withHandler = (
	testDb: TestDb,
	turns: Array<BeginTurnInput>,
	body: (handler: (request: Request) => Promise<Response>) => Effect.Effect<void>,
) => {
	const { handler, dispose } = HttpRouter.toWebHandler(makeRouterLayer(testDb, turns), {
		disableLogger: true,
	})
	return body((request) => handler(request)).pipe(Effect.ensuring(Effect.promise(dispose)))
}

const send = (
	handler: (request: Request) => Promise<Response>,
	headers: Record<string, string>,
	text = "hello",
) =>
	Effect.promise(() =>
		handler(
			new Request(`http://api.localhost${SESSION_PATH}/messages`, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: JSON.stringify({ text }),
			}),
		),
	)

/** Mint a real key for the org so the API-key branch of the tenant resolver runs. */
const mintApiKey = (testDb: TestDb) =>
	Effect.gen(function* () {
		const apiKeys = yield* ApiKeysService
		const created = yield* apiKeys.create(ORG, USER, { name: "chat-test", kind: "standard" })
		return created.secret
	}).pipe(
		Effect.provide(
			ApiKeysService.layer.pipe(
				Layer.provide(Layer.mergeAll(testDb.layer, Env.layer.pipe(Layer.provide(config)))),
			),
		),
	)

describe("ChatSessionsRouter", () => {
	it.effect("starts a turn for an API-key caller of the session's own org", () => {
		const testDb = createTestDb(trackedDbs)
		const turns: Array<BeginTurnInput> = []
		return Effect.gen(function* () {
			const key = yield* mintApiKey(testDb)
			yield* withHandler(
				testDb,
				turns,
				Effect.fnUntraced(function* (handler) {
					const response = yield* send(handler, { authorization: `Bearer ${key}` })
					assert.strictEqual(response.status, 202)
					const body = yield* Effect.promise(() => response.json())
					assert.strictEqual(turns.length, 1)
					assert.strictEqual(turns[0]?.tenant.orgId, ORG)
					assert.strictEqual(turns[0]?.text, "hello")
					assert.strictEqual(body.messageId, turns[0]?.messageId)
				}),
			)
		})
	})

	it.effect("starts a turn for an internal-service caller", () => {
		const testDb = createTestDb(trackedDbs)
		const turns: Array<BeginTurnInput> = []
		return withHandler(
			testDb,
			turns,
			Effect.fnUntraced(function* (handler) {
				const response = yield* send(handler, {
					authorization: `Bearer maple_svc_${INTERNAL_TOKEN}`,
					"x-org-id": ORG,
				})
				assert.strictEqual(response.status, 202)
				assert.strictEqual(turns.length, 1)
			}),
		)
	})

	it.effect("answers 401, never 500, to a credential nobody issued", () => {
		const testDb = createTestDb(trackedDbs)
		const turns: Array<BeginTurnInput> = []
		return withHandler(
			testDb,
			turns,
			Effect.fnUntraced(function* (handler) {
				const unknownKey = yield* send(handler, { authorization: "Bearer maple_ak_not_a_key" })
				assert.strictEqual(unknownKey.status, 401)
				const anonymous = yield* send(handler, {})
				assert.strictEqual(anonymous.status, 401)
				assert.strictEqual(turns.length, 0)
			}),
		)
	})

	it.effect("hides another org's session as 404", () => {
		const testDb = createTestDb(trackedDbs)
		const turns: Array<BeginTurnInput> = []
		return withHandler(
			testDb,
			turns,
			Effect.fnUntraced(function* (handler) {
				const response = yield* send(handler, {
					authorization: `Bearer maple_svc_${INTERNAL_TOKEN}`,
					"x-org-id": "org_other",
				})
				assert.strictEqual(response.status, 404)
				assert.strictEqual(turns.length, 0)
			}),
		)
	})
})
