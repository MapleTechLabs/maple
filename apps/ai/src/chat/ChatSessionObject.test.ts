import { assert, describe, it } from "@effect/vitest"
import { encodeChatTurnTenant, type ChatTurnTenant } from "@maple/domain/chat-session"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Layer } from "effect"
import { installSchedulerWait, makeFakeDurableObjectState } from "../../test/chat/fake-do-state"
import { activateChatSession } from "./ChatSession"

installSchedulerWait()

const TENANT = encodeChatTurnTenant({
	orgId: "org_test" as ChatTurnTenant["orgId"],
	userId: "user_test" as ChatTurnTenant["userId"],
	roles: [],
	authMode: "self_hosted",
})

/** One activation the way alchemy's Durable Object bridge performs it: the outer phase under the state, then the inner. */
const activate = Effect.gen(function* () {
	const state = makeFakeDurableObjectState()
	// SAFETY: the fake carries the `storage.sql` and `waitUntil` the class reads, and nothing else.
	const raw = state as unknown as import("@cloudflare/workers-types").DurableObjectState
	const build = yield* activateChatSession.pipe(
		Effect.provide(
			Layer.mergeAll(
				Layer.succeed(Cloudflare.DurableObjectState, Cloudflare.fromDurableObjectState(raw)),
				Layer.succeed(Cloudflare.WorkerEnvironment, {}),
			),
		),
	)
	return { rpc: yield* build, state }
})

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
					),
				),
			)
			assert.isTrue(Effect.isEffect(build))
		}),
	)

	it.effect("exposes the stub's surface over the session it built", () =>
		Effect.gen(function* () {
			const { rpc } = yield* activate
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
			const { rpc, state } = yield* activate
			const begun = yield* rpc.beginTurn({
				sessionId: "org_test:tab",
				messageId: "m1",
				text: "why is checkout slow?",
				tenant: TENANT,
			})
			assert.isDefined(begun)
			assert.strictEqual(yield* rpc.running(), true)
			// The turn was scheduled on the object's own context, not the caller's.
			assert.strictEqual(state.pending.length, 1)
			yield* rpc.abort()
			assert.strictEqual(yield* rpc.running(), false)
		}),
	)
})
