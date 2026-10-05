import type { ChatSessionRpc } from "@maple/domain/chat-session-stub"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ChatSessions } from "./bindings"
import { type ChatSessionNamespace, chatSessionsLayer } from "./chat-sessions"

const rpc: ChatSessionRpc = {
	cursor: () => Effect.succeed(7),
	running: () => Effect.succeed(false),
	history: () => Effect.succeed([]),
	since: () => Effect.succeed([]),
	subscribe: () => Effect.succeed(new ReadableStream<Uint8Array>()),
	append: () => Effect.succeed(0),
	beginTurn: () => Effect.succeed(undefined),
	settleProposal: () => Effect.succeed("unknown"),
	holdsTurn: () => Effect.succeed(false),
	endTurn: () => Effect.void,
	abort: () => Effect.void,
	alarm: () => Effect.void,
}

/** Records which namespace each session id was addressed through. */
const namespace = (label: string, seen: Array<string>): ChatSessionNamespace => ({
	getByName: (name) => {
		seen.push(`${label}:${name}`)
		return rpc
	},
	jurisdiction: (jurisdiction) => namespace(`${label}/${jurisdiction}`, seen),
})

const address = (env: Record<string, unknown>, seen: Array<string>) =>
	Effect.gen(function* () {
		return yield* (yield* ChatSessions).session("org_a:t").cursor()
	}).pipe(Effect.provide(chatSessionsLayer(namespace("ns", seen), env)))

describe("chatSessionsLayer", () => {
	it.effect("addresses the object through the eu jurisdiction on the EU instance", () =>
		Effect.gen(function* () {
			const seen: Array<string> = []
			expect(yield* address({ MAPLE_REGION: "eu" }, seen)).toBe(7)
			expect(seen).toEqual(["ns/eu:org_a:t"])
		}),
	)

	it.effect("leaves the us instance, and an env with no region, on the plain namespace", () =>
		Effect.gen(function* () {
			const seen: Array<string> = []
			yield* address({ MAPLE_REGION: "us" }, seen)
			yield* address({}, seen)
			expect(seen).toEqual(["ns:org_a:t", "ns:org_a:t"])
		}),
	)
})
