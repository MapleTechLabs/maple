import { assert, describe, it } from "@effect/vitest"
import { encodeChatTurnTenant, type ChatTurnTenant } from "@maple/domain/chat-session"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Layer, Option } from "effect"
import { applyChatSessionMigrations, makeFakeDurableObjectState } from "../../test/chat/fake-do-state"
import { WorkersAiGateway } from "../platform/WorkersAiHttpClient"
import { makeChatSessionActivation } from "./ChatSession"

const TENANT = encodeChatTurnTenant({
	orgId: "org_test" as ChatTurnTenant["orgId"],
	userId: "user_test" as ChatTurnTenant["userId"],
	roles: [],
	authMode: "self_hosted",
})

/** Alchemy's `SqlMigrations` captures the files at deploy; a test applies the same files directly. */
const activateChatSession = Effect.flatMap(Cloudflare.DurableObjectState, (state) =>
	makeChatSessionActivation(
		Effect.succeed({
			apply: () => Effect.sync(() => applyChatSessionMigrations(state.raw.storage.sql)),
		}),
	),
)

/** One activation the way alchemy's Durable Object bridge performs it: the outer phase under the state, then the inner. */
const activateOn = (state: ReturnType<typeof makeFakeDurableObjectState>) =>
	Effect.gen(function* () {
		// SAFETY: the fake carries the `storage.sql` and `waitUntil` the class reads, and nothing else.
		const raw = state as unknown as import("@cloudflare/workers-types").DurableObjectState
		const build = yield* activateChatSession.pipe(
			Effect.provide(
				Layer.mergeAll(
					Layer.succeed(Cloudflare.DurableObjectState, Cloudflare.fromDurableObjectState(raw)),
					Layer.succeed(Cloudflare.WorkerEnvironment, {}),
					Layer.succeed(WorkersAiGateway, Option.none()),
				),
			),
		)
		return { rpc: yield* build, state }
	})

/** A fresh object per test, so no test reads another's events. */
const activate = () => activateOn(makeFakeDurableObjectState({ migrated: false }))

describe("the ChatSession Durable Object on alchemy's form", () => {
	it.effect("the outer phase touches no storage, so it can run against alchemy's plan-time mock", () =>
		Effect.gen(function* () {
			// alchemy evaluates the outer Effect at plan time with `{ storage: {} }` as the state.
			// SAFETY: that is alchemy's own mock, reproduced here.
			const mock = { storage: {} } as unknown as import("@cloudflare/workers-types").DurableObjectState
			const build = yield* activateChatSession.pipe(
				Effect.provide(
					Layer.mergeAll(
						Layer.succeed(Cloudflare.DurableObjectState, Cloudflare.fromDurableObjectState(mock)),
						Layer.succeed(Cloudflare.WorkerEnvironment, {}),
						Layer.succeed(WorkersAiGateway, Option.none()),
					),
				),
			)
			assert.isTrue(Effect.isEffect(build))
		}),
	)

	it.effect("exposes the stub's surface over the session it built", () =>
		Effect.gen(function* () {
			const { rpc } = yield* activate()
			assert.strictEqual(yield* rpc.cursor(), 0)
			const seq = yield* rpc.append({ type: "user-message", id: "u1", text: "hello" })
			assert.strictEqual(seq, 1)
			assert.deepStrictEqual(
				(yield* rpc.since(0)).map((event) => event.type),
				["user-message"],
			)
			assert.strictEqual(yield* rpc.running(), false)
			assert.strictEqual((yield* rpc.history()).length, 1)
		}),
	)

	it.effect("begins a turn over RPC and lets the class own it", () =>
		Effect.gen(function* () {
			const { rpc, state } = yield* activate()
			const begun = yield* rpc.beginTurn({
				sessionId: "org_test:tab",
				messageId: "m1",
				text: "why is checkout slow?",
				tenant: TENANT,
				origin: { kind: "app" },
			})
			assert.isDefined(begun)
			assert.strictEqual(yield* rpc.running(), true)
			// The turn was scheduled on the object's own context, not the caller's.
			// Two pieces of object work: the turn and the heartbeat alarm that keeps the object alive.
			assert.strictEqual(state.pending.length, 2)
			assert.lengthOf(state.alarms, 1)
			yield* rpc.abort()
			assert.strictEqual(yield* rpc.running(), false)
		}),
	)

	it.effect("brings a session table from before the late columns up to the baseline", () =>
		Effect.gen(function* () {
			const state = makeFakeDurableObjectState({ migrated: false })
			state.storage.sql.exec(
				"CREATE TABLE session (id INTEGER PRIMARY KEY CHECK (id = 1), running INTEGER NOT NULL DEFAULT 0)",
			)
			state.storage.sql.exec("INSERT INTO session (id, running) VALUES (1, 0)")
			const { rpc } = yield* activateOn(state)

			assert.strictEqual(yield* rpc.running(), false)
			const columns = state.storage.sql
				.exec("SELECT name FROM pragma_table_info('session')")
				.toArray()
				.map((row) => row.name)
			assert.includeMembers(columns, [
				"running_since",
				"running_message_id",
				"running_input",
				"running_resumes",
			])
		}),
	)
})
